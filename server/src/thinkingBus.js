// LLM 思考过程（reasoning）内存广播中心：
// llm.js 在每次 chat() 调用时开一个思考会话，reasoning 增量推给所有已连接的
// /api/thinking/stream SSE 客户端——「AI 思考过程」面板订阅后实时展示。
// 与 jobs.js 的 job pub/sub 同一模式：内存态，重启清空。
// 并发模型：active 为 Map（多会话可同时进行），每个 chat() 调用持有自己的 sid，
// 增量按 sid 路由——并发互不封存、不串台；已结束会话的迟到增量直接丢弃。

const clients = new Set();
let sessionCounter = 0;

// 最近结束会话环（前端连接晚于 chat() 完成时能拿到已有内容）
const MAX_HISTORY = 30;
const history = [];          // 已结束会话（新→旧）
const active = new Map();     // id -> 会话（进行中，可并发多个）
let lastStarted = null;       // 最近开启的会话（snapshot 默认展示）

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
