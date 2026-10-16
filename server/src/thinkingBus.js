// LLM 思考过程（reasoning）内存广播中心：
// llm.js 在每次 chat() 调用时开一个思考会话，reasoning 增量推给所有已连接的
// /api/thinking/stream SSE 客户端——「AI 思考过程」面板订阅后实时展示。
// 与 jobs.js 的 job pub/sub 同一模式：内存态，重启清空。
// 并发模型：active 为 Map（多会话可同时进行），每个 chat() 调用持有自己的 sid，
// 增量按 sid 路由——并发互不封存、不串台；已结束会话的迟到增量直接丢弃。

const clients = new Set();
let sessionCounter = 0;
let translator = null;

export function registerTranslator(fn) { translator = fn; }

// 最近结束会话环（前端连接晚于 chat() 完成时能拿到已有内容）
const MAX_HISTORY = 30;
const history = [];          // 已结束会话（新→旧）
const active = new Map();     // id -> 会话（进行中，可并发多个）
let lastStarted = null;       // 最近开启的会话（snapshot 默认展示）

// 翻译：reasoning 以英文/拉丁为主时，会话结束后异步整段翻译成中文并推送 snapshot 替换展示。
// 触发条件：中文为主（汉字占比高）的思考（如 deepseek/qwen 默认中文）不翻译；
// 纯英文 / 中英混合思考翻译成中文。前端 thinking store 对 snapshot 是整体重建，天然兼容。
const MIN_TRANSLATE_LEN = 60;       // 原文至少多长才值得翻译

// 判断文本是否值得翻译：汉字占比高时保留原文；含大量拉丁/ASCII 则翻译。
function shouldTranslate(text) {
  if (!text) return false;
  if (text.length < MIN_TRANSLATE_LEN) return false;
  let han = 0;
  let latin = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) han++;
    else if (/[A-Za-z]/.test(ch)) latin++;
  }
  if (han === 0) return latin > 30;              // 纯英文/拉丁：字数足够就翻译
  const ratio = latin / Math.max(han, 1);
  return ratio > 0.45;                           // 中英混合：拉丁占比高于 0.45 才翻译
}

// 推送当前会话状态快照到所有连接（翻译完成后整体替换前端显示）
function pushSnapshot(s) {
  const acts = [...active.values()].sort((a, b) => b.startedAt - a.startedAt);
  const others = acts.filter((a) => a.id !== s.id);
  const hist = history.filter((h) => h.id !== s.id);
  broadcast({
    type: 'snapshot',
    session: { id: s.id, label: s.label, model: s.model, text: s.text, status: s.status, startedAt: s.startedAt, updatedAt: s.updatedAt },
    history: [...others, ...hist].slice(0, 19).map((h) => ({ id: h.id, label: h.label, model: h.model, text: h.text, status: h.status, startedAt: h.startedAt, updatedAt: h.updatedAt }))
  });
}

function broadcast(obj) {
  for (const fn of [...clients]) {
    try { fn(obj); } catch { clients.delete(fn); }
  }
}

export function beginSession(meta = {}) {
  sessionCounter += 1;
  const s = {
    id: `t${Date.now().toString(36)}-${sessionCounter}`,
    label: String(meta.label || '模型调用'),
    model: String(meta.model || ''),
    text: '',
    status: 'thinking',
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  active.set(s.id, s);
  lastStarted = s;
  broadcast({
    type: 'think_start',
    id: s.id,
    label: s.label,
    model: s.model,
    startedAt: s.startedAt
  });
  return s.id;
}

export function pushThinking(text, sid) {
  if (!text || !sid) return;
  const s = active.get(sid);
  if (!s) return; // 会话已结束或未知：迟到增量丢弃，防串台
  s.text += text;
  s.updatedAt = Date.now();
  broadcast({ type: 'think_delta', id: sid, text });
}

export function endSession(sid, status = 'done') {
  if (!sid) return;
  const s = active.get(sid);
  if (!s || s.status !== 'thinking') return; // 幂等：重复 end 不改写
  s.status = status;
  s.updatedAt = Date.now();
  active.delete(sid);
  broadcast({ type: 'think_end', id: s.id, status, chars: s.text.length });
  history.unshift(s);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  // 异步翻译：reasoning 以英文/拉丁为主时翻译成中文，完成后推送 snapshot 更新前端显示
  if (translator && shouldTranslate(s.text)) {
    const source = s.text;
    translator(source, s.model).then((zh) => {
      if (!zh || zh.length <= 20 || zh === source) return;
      s.text = zh;
      s.updatedAt = Date.now();
      pushSnapshot(s);
    }).catch(() => {});
  }
}

// 新连接首帧：最近开启的会话（进行中优先）+ 其余进行中会话 + 最近结束环
export function getSnapshot() {
  const acts = [...active.values()].sort((a, b) => b.startedAt - a.startedAt);
  const session = acts[0] || lastStarted || history[0] || null;
  const rest = [];
  for (const a of acts) if (a.id !== session?.id) rest.push(a);
  const entries = [...rest, ...history].slice(0, 20);
  if (!session) return { type: 'snapshot', session: null, history: [] };
  return {
    type: 'snapshot',
    session: { id: session.id, label: session.label, model: session.model, text: session.text, status: session.status, startedAt: session.startedAt, updatedAt: session.updatedAt },
    history: entries.map((h) => ({ id: h.id, label: h.label, model: h.model, text: h.text, status: h.status, startedAt: h.startedAt, updatedAt: h.updatedAt }))
  };
}

// GET /api/thinking/stream SSE handler
export function thinkingStreamHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  write(getSnapshot());
  const unsub = subscribe((ev) => write(ev));
  req.on('close', () => unsub());
}

function subscribe(fn) {
  clients.add(fn);
  return () => clients.delete(fn);
}
