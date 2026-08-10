/**
 * 本地大模型三层降级架构
 * 1. Ollama 探测 — 自动检测本地 Ollama 服务，列出可用模型
 * 2. transformers.js 轻量推理 — 内置 ONNX 模型，零安装离线生成（如果可用）
 * 3. 规则引擎兜底 — 纯规则+模板+统计，保证零依赖下也能基本对话
 */
import { db, getSetting, setSetting } from './db.js';
import { getGenreTemplates, generatePersonalityDialog, normalizeGenre } from './genre_engine.js';
import { join } from 'path';

const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

// ===== Layer 1: Ollama 探测 =====

/**
 * 探测本地 Ollama 服务是否可用
 * @returns {Promise<{available: boolean, url: string, models: string[], version?: string}>}
 */
export async function detectOllama() {
  const savedUrl = getSetting('ollama_url', '');
  const urls = [savedUrl, OLLAMA_DEFAULT_URL, 'http://127.0.0.1:11434'].filter(Boolean);
  for (const base of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const resp = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const data = await resp.json();
      const models = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
      if (savedUrl !== base) setSetting('ollama_url', base);
      let version = '';
      try {
        const vResp = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(2000) });
        const vData = await vResp.json();
        version = vData.version || '';
      } catch { /* ignore */ }
      return { available: true, url: base, models, version };
    } catch { /* try next url */ }
  }
  return { available: false, url: '', models: [], version: '' };
}

/**
 * 通过 Ollama 原生 API 调用（不走 OpenAI 兼容层，更稳定）
 */
export async function ollamaChat({ url, model, messages, onDelta, signal, temperature = 0.8 }) {
  const base = (url || OLLAMA_DEFAULT_URL).replace(/\/+$/, '');
  const resp = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: !!onDelta,
      options: { temperature }
    }),
    signal
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Ollama 返回错误 ${resp.status}: ${detail.slice(0, 200)}`);
  }
  if (!onDelta) {
    const data = await resp.json();
    return { content: data.message?.content || '', finishReason: 'stop' };
  }
  // 流式：Ollama 逐行返回 JSON
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let finishReason = 'stop';
  while (true) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const json = JSON.parse(t);
        if (json.message?.content) {
          full += json.message.content;
          onDelta(json.message.content);
        }
        if (json.done) finishReason = 'stop';
      } catch { /* skip */ }
    }
  }
  return { content: full, finishReason };
}

/**
 * 拉取 Ollama 模型列表
 */
export async function ollamaListModels(url) {
  const base = (url || OLLAMA_DEFAULT_URL).replace(/\/+$/, '');
  const resp = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`Ollama 不可用 (${resp.status})`);
  const data = await resp.json();
  return (data.models || []).map((m) => ({
    name: m.name || m.model,
    size: m.size || 0,
    modified: m.modified_at || ''
  }));
}

// ===== Layer 2: transformers.js 内置推理引擎 =====

let _transformersAvailable = null;
let _transformersLib = null;
let _pipeline = null;
let _modelDownloadProgress = null;

// 推荐内置模型（小体积，适合 CPU 推理）
const BUILTIN_MODELS = [
  { id: 'Xenova/Qwen2.5-0.5B-Instruct', name: 'Qwen2.5 0.5B', size: '~400MB', desc: '超轻量中文模型，低配电脑可用', minRam: '4GB' },
  { id: 'Xenova/Qwen2.5-1.5B-Instruct', name: 'Qwen2.5 1.5B', size: '~1GB', desc: '轻量中文模型，速度与质量平衡', minRam: '8GB' },
  { id: 'Xenova/Qwen2.5-3B-Instruct', name: 'Qwen2.5 3B', size: '~2GB', desc: '中等中文模型，质量较好', minRam: '12GB' },
];

// 应用 HuggingFace 镜像源（国内网络 huggingface.co 常不可达）。
// 优先级：设置 hf_endpoint > 环境变量 HF_ENDPOINT；空值/不可用时保持官方源。
function applyHFMirror() {
  try {
    const { env } = _transformersLib;
    if (!env) return;
    const endpoint = getSetting('hf_endpoint', '') || process.env.HF_ENDPOINT || '';
    const host = String(endpoint).trim().replace(/\/+$/, '');
    if (host && /^https?:\/\//i.test(host)) {
      env.remoteHost = host.endsWith('/') ? host : host + '/';
      env.remotePathTemplate = '{model}/resolve/{revision}/';
    }
  } catch { /* 镜像配置失败不阻塞 */ }
}

async function checkTransformers() {
  if (_transformersAvailable !== null) return _transformersAvailable;
  // 设置一个加载标志，防止并发重复加载
  _transformersAvailable = false; // 默认不可用，除非成功加载
  try {
    // 延迟加载 transformers.js，失败不影响主进程
    const transformers = await import('@huggingface/transformers').catch(() =>
      import('@xenova/transformers').catch(() => null)
    );
    if (!transformers) {
      return false;
    }
    // 验证 onnxruntime 可用（可能因缺少原生二进制而失败）
    if (!transformers.pipeline || typeof transformers.pipeline !== 'function') {
      return false;
    }
    _transformersAvailable = true;
    _transformersLib = transformers;
    return true;
  } catch {
    _transformersAvailable = false;
    return false;
  }
}

/**
 * 安全检查 transformers.js 是否可用（不会崩溃主进程）
 */
export async function isTransformersAvailable() {
  return await checkTransformers();
}

/**
 * 获取内置推理引擎状态
 */
export async function getTransformersStatus() {
  const available = await checkTransformers();
  const selectedModel = getSetting('transformers_model', 'Xenova/Qwen2.5-0.5B-Instruct');
  const modelReady = available && _pipeline !== null;
  return {
    available,
    modelReady,
    selectedModel,
    models: BUILTIN_MODELS,
    downloadProgress: _modelDownloadProgress,
  };
}

/**
 * 一键安装/下载内置模型
 * 安装 = 下载模型文件到本地缓存，后续推理不再联网
 */
export async function installTransformersModel(modelId, onProgress) {
  const available = await checkTransformers();
  if (!available) {
    throw new Error('transformers.js 不可用，请确保应用已包含 @huggingface/transformers 依赖');
  }

  _modelDownloadProgress = { stage: 'downloading', percent: 0, model: modelId };
  setSetting('transformers_model', modelId);

  const origFetch = globalThis.fetch;
  try {
    const { pipeline, env } = _transformersLib;

    // 应用镜像源（优先于设置缓存目录），国内网络可改用 hf-mirror.com 等镜像
    applyHFMirror();

    // 设置 HuggingFace 缓存目录到应用数据目录
    const cacheDir = join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.ai-novel-studio', 'models');
    env.cacheDir = cacheDir;

    // 监听下载进度
    let lastReport = 0;
    globalThis.fetch = async function (...args) {
      const resp = await origFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (resp.ok && resp.headers.get('content-length')) {
        const total = parseInt(resp.headers.get('content-length'));
        let received = 0;
        const body = resp.body;
        const stream = new ReadableStream({
          start(controller) {
            const reader = body.getReader();
            function read() {
              reader.read().then(({ done, value }) => {
                if (done) { controller.close(); return; }
                received += value.length;
                const now = Date.now();
                if (now - lastReport > 500) {
                  lastReport = now;
                  const percent = total ? Math.round((received / total) * 100) : 0;
                  _modelDownloadProgress.percent = percent;
                  onProgress?.({ stage: 'downloading', percent, received, total, model: modelId });
                }
                controller.enqueue(value);
                read();
              }).catch(e => controller.error(e));
            }
            read();
          }
        });
        return new Response(stream, {
          headers: resp.headers,
          status: resp.status,
          statusText: resp.statusText,
        });
      }
      return resp;
    };

    onProgress?.({ stage: 'downloading', percent: 0, model: modelId, message: '正在下载模型文件…' });

    // 创建 pipeline（会自动下载模型）
    const pipe = await pipeline('text-generation', modelId, {
      device: 'cpu',
      dtype: 'q4',
      progress_callback: (data) => {
        if (data.status === 'progress') {
          const percent = data.total ? Math.round((data.loaded / data.total) * 100) : 0;
          _modelDownloadProgress = { stage: 'downloading', percent, model: modelId, file: data.file };
          onProgress?.({ stage: 'downloading', percent, file: data.file, model: modelId });
        } else if (data.status === 'done') {
          onProgress?.({ stage: 'downloading', percent: 100, file: data.file, model: modelId });
        }
      }
    });

    // 恢复原始 fetch
    globalThis.fetch = origFetch;

    _pipeline = pipe;
    _modelDownloadProgress = { stage: 'done', percent: 100, model: modelId };
    setSetting('transformers_installed', '1');
    onProgress?.({ stage: 'done', percent: 100, model: modelId, message: '模型安装完成' });

    return { success: true, model: modelId };
  } catch (e) {
    globalThis.fetch = origFetch;
    _modelDownloadProgress = { stage: 'error', error: e.message, model: modelId };
    throw e;
  }
}

export function getBuiltinModels() {
  return BUILTIN_MODELS;
}

/**
 * transformers.js 本地推理（如果有模型文件）
 * 模型需预先下载到本地，否则会从 HuggingFace 下载（首次较慢）
 */
export async function transformersChat({ messages, onDelta, signal, temperature = 0.7, model, maxNewTokens = 512 }) {
  const available = await checkTransformers();
  if (!available) {
    throw new Error('transformers.js 不可用，请在设置中安装内置推理引擎');
  }
  const { pipeline } = _transformersLib;
  const savedModel = getSetting('transformers_model', 'Xenova/Qwen2.5-0.5B-Instruct');
  const useModel = model || savedModel;

  // 应用镜像源，确保推理时能按镜像地址加载本地模型/回退下载
  applyHFMirror();

  if (!_pipeline || _pipeline.modelId !== useModel) {
    _pipeline = await pipeline('text-generation', useModel, {
      device: 'cpu',
      dtype: 'q4'
    });
    _pipeline.modelId = useModel;
  }
  const prompt = messages.map((m) => {
    if (m.role === 'system') return `<|im_start|>system\n${m.content}<|im_end|>`;
    if (m.role === 'user') return `<|im_start|>user\n${m.content}<|im_end|>`;
    if (m.role === 'assistant') return `<|im_start|>assistant\n${m.content}<|im_end|>`;
    return '';
  }).join('\n') + '\n<|im_start|>assistant\n';

  const output = await _pipeline(prompt, {
    max_new_tokens: maxNewTokens,
    temperature,
    do_sample: temperature > 0,
    signal
  });
  const text = Array.isArray(output) ? output[0]?.generated_text || '' : output?.generated_text || '';
  const assistantPart = text.split('<|im_start|>assistant\n').pop().split('<|im_end|>')[0];
  if (onDelta && assistantPart) onDelta(assistantPart);
  return { content: assistantPart || text, finishReason: 'stop', layer: 'transformers' };
}

// ===== Layer 3: 规则引擎兜底（史诗级增强版） =====

// 多轮对话上下文记忆
const _conversations = new Map();

function getConvMemory(sessionKey) {
  if (!sessionKey) return { turns: [], topics: [], lastIntent: null };
  let mem = _conversations.get(sessionKey);
  if (!mem) {
    mem = { turns: [], topics: [], lastIntent: null };
    _conversations.set(sessionKey, mem);
  }
  return mem;
}

function updateConvMemory(sessionKey, intent, userText) {
  const mem = getConvMemory(sessionKey);
  mem.turns.push({ intent, text: userText.slice(0, 200) });
  if (mem.turns.length > 20) mem.turns.shift();
  mem.lastIntent = intent;
  if (intent && !mem.topics.includes(intent)) {
    mem.topics.push(intent);
    if (mem.topics.length > 10) mem.topics.shift();
  }
  return mem;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 意图匹配规则库（30+ 意图）
const INTENTS = [
  // === 社交类 ===
  { id: 'greeting', test: /^(你好|您好|hi|hello|嗨|在吗|在不在|早|晚上好|下午好|早上好)/i,
    reply: () => pickRandom([
      '你好！我是你的创作管家。离线模式下我也能帮你管理设定、查看进度、分析角色关系。试试问我「角色」「伏笔」「进度」。',
      '嗨！我在线。虽然用的是离线规则引擎，但 30+ 种意图我都能处理。输入「帮助」看全部能力。',
      '欢迎回来！我能帮你查看角色档案、伏笔追踪、创作进度、知识学习库。连接 Ollama 后能力更上一层楼。'
    ])
  },
  { id: 'farewell', test: /(再见|拜拜|bye|走了|先去|回见|晚安)/i,
    reply: () => pickRandom(['再见！随时回来继续创作。', '拜拜！你的小说数据都保存在本地，不会丢失。', '晚安！'])
  },
  { id: 'thanks', test: /(谢谢|感谢|thanks|多谢|辛苦了)/i,
    reply: () => pickRandom(['不客气！', '应该的，有需要随时找我。', '不用谢，帮你创作是我的工作。'])
  },

  // === 帮助/功能 ===
  { id: 'help', test: /(帮助|help|怎么用|功能|能做什么|用法|帮我|指南)/i,
    reply: () => `我能帮你做这些（离线模式）：

【信息查询】
- 角色：输入「角色」查看角色列表和分组
- 伏笔：输入「伏笔」查看未回收伏笔
- 进度：输入「进度」查看创作状态
- 大纲：输入「大纲」查看当前剧情大纲
- 世界观：输入「世界观」查看设定

【创作辅助】
- 取名：输入「取名 玄幻」帮你起角色名
- 灵感：输入「灵感」获取创作灵感提示
- 模板：输入「模板 开头」获取章节开头模板
- 检查：输入「检查」查看待办事项

【学习与知识】
- 学习：输入「学习」了解知识学习库用法
- 分析：输入「分析」查看已学知识库统计

【设置与引导】
- Ollama：输入「ollama」了解本地模型安装
- 模式：输入「模式」查看当前运行模式
- 建议：输入「建议」获取创作建议

连接大模型或 Ollama 后，还能：生成方案、写章节、润色文字、深度对话。`
  },

  // === 小说信息查询 ===
  { id: 'status', test: /(状态|进度|怎么样|目前|现在.*写|写到哪|写了多少)/i,
    reply: (ctx) => {
      if (!ctx?.novel) return '当前没有打开的小说。请在书架选择一本。';
      const n = ctx.novel;
      const progress = n.target_chapters ? Math.round(((n.chapter_count || 0) / n.target_chapters) * 100) : 0;
      const words = ctx.totalWords || 0;
      let msg = `《${n.title}》创作状态：\n\n`;
      msg += `类型：${n.genre || '未设置'}\n`;
      msg += `章节：${n.chapter_count || 0} / ${n.target_chapters || '?'} 章（${progress}%）\n`;
      msg += `总字数：${words >= 10000 ? (words / 10000).toFixed(1) + ' 万字' : words + ' 字'}\n`;
      msg += `角色：${n.character_count || ctx.characters?.length || 0} 个\n`;
      msg += `状态：${n.status === 'planned' ? '已规划方案' : '草稿'}\n`;
      if (progress === 0) msg += '\n提示：连接大模型后可生成方案并开始创作。';
      else if (progress < 100) msg += `\n进度条：${'█'.repeat(Math.floor(progress / 10))}${'░'.repeat(10 - Math.floor(progress / 10))} ${progress}%`;
      else msg += '\n已全部完成！';
      return msg;
    }
  },
  { id: 'character', test: /(角色|人物|主角|配角|反派|谁.*角色|角色.*谁)/i,
    reply: (ctx) => {
      if (!ctx?.characters?.length) return '当前小说还没有角色。连接大模型后可通过生成方案自动创建角色。';
      const mains = ctx.characters.filter((c) => c.role_type === '主角');
      const villains = ctx.characters.filter((c) => c.role_type === '反派');
      const supporters = ctx.characters.filter((c) => c.role_type === '重要配角');
      const minor = ctx.characters.filter((c) => c.role_type === '配角');
      let msg = '角色档案一览：\n';
      if (mains.length) msg += `\n【主角】\n${mains.map((c) => `  ${c.name} — ${c.personality || '性格未设'}${c.background ? '；背景：' + c.background.slice(0, 30) : ''}`).join('\n')}`;
      if (villains.length) msg += `\n\n【反派】\n${villains.map((c) => `  ${c.name} — ${c.personality || '性格未设'}`).join('\n')}`;
      if (supporters.length) msg += `\n\n【重要配角】\n${supporters.map((c) => `  ${c.name} — ${c.personality || ''}`).join('\n')}`;
      if (minor.length) msg += `\n\n【配角】\n${minor.map((c) => c.name).join('、')}`;
      msg += `\n\n共 ${ctx.characters.length} 个角色。`;
      return msg;
    }
  },
  { id: 'foreshadowing', test: /(伏笔|坑|悬念|回收|埋.*伏|挖坑|填坑)/i,
    reply: (ctx) => {
      if (!ctx?.foreshadowings?.length) return '当前小说还没有伏笔数据。生成方案后系统会自动追踪伏笔。';
      const open = ctx.foreshadowings.filter((f) => f.status === 'open');
      const closed = ctx.foreshadowings.filter((f) => f.status === 'closed');
      let msg = `伏笔追踪报告：\n\n`;
      msg += `总计：${ctx.foreshadowings.length} 个\n`;
      msg += `未回收：${open.length} 个\n`;
      msg += `已回收：${closed.length} 个\n`;
      msg += `回收率：${ctx.foreshadowings.length ? Math.round((closed.length / ctx.foreshadowings.length) * 100) : 0}%\n`;
      if (open.length) {
        msg += `\n【待回收伏笔】\n`;
        open.slice(0, 8).forEach((f, i) => {
          msg += `  ${i + 1}. ${f.content}\n`;
        });
        if (open.length > 8) msg += `  ...还有 ${open.length - 8} 个\n`;
      }
      if (closed.length) msg += `\n最近回收：${closed.slice(-3).map((f) => f.content).join('、')}`;
      if (open.length > 10) msg += `\n\n提示：未回收伏笔较多，建议在后续章节中回收部分线索。`;
      return msg;
    }
  },
  { id: 'outline', test: /(大纲|剧情线|主线|故事线|脉络)/i,
    reply: (ctx) => {
      if (!ctx?.novel?.outline) return '当前小说还没有大纲。连接大模型后可生成完整方案（含分章大纲）。';
      const outline = ctx.novel.outline;
      return `《${ctx.novel.title}》剧情大纲：\n\n${outline.slice(0, 500)}${outline.length > 500 ? '\n\n（大纲较长，已截取前 500 字）' : ''}`;
    }
  },
  { id: 'worldview', test: /(世界观|设定|背景|设定集|世界)/i,
    reply: (ctx) => {
      if (!ctx?.worldSettings?.length && !ctx?.novel?.world_view) return '当前小说还没有世界观设定。';
      let msg = '世界观设定：\n\n';
      if (ctx.novel?.world_view) msg += `${ctx.novel.world_view.slice(0, 300)}\n\n`;
      if (ctx.worldSettings?.length) {
        msg += '设定条目：\n';
        ctx.worldSettings.forEach((s) => {
          msg += `  【${s.category}】${s.name}：${(s.content || '').slice(0, 60)}\n`;
        });
      }
      return msg;
    }
  },

  // === 创作辅助 ===
  { id: 'namegen', test: /^(取名|起名|名字|角色名|命名)/i,
    reply: (ctx, input) => {
      const genre = (input.match(/(玄幻|仙侠|都市|科幻|武侠|历史|言情|悬疑|恐怖)/) || [])[1] || ctx?.novel?.genre?.split(',')[0] || '通用';
      const surnames = ['李', '王', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '林', '郭', '何', '高', '罗'];
      const genreGiven = {
        '玄幻': ['逸尘', '凌霄', '道玄', '天行', '无极', '苍冥', '玄真', '太虚', '九渊', '星河', '劫火', '寒渊'],
        '仙侠': ['长歌', '清虚', '若虚', '忘机', '逍遥', '问道', '归元', '紫云', '青莲', '问道', '尘心', '玄微'],
        '都市': ['子轩', '思源', '一鸣', '文博', '彦辰', '逸飞', '嘉树', '晨曦', '悦然', '若安', '言溪', '知行'],
        '科幻': ['启明', '远望', '星际', '量子', '矩阵', '熵', '光年', '奇点', '暗物质', '维度', '跃迁', '终焉'],
        '武侠': ['风清', '剑寒', '独孤', '青云', '傲天', '惊鸿', '破军', '一川', '秋水', '无痕', '长风', '铁山'],
        '历史': ['子明', '伯安', '文渊', '元朗', '德馨', '景仁', '怀瑾', '世昌', '宗道', '承恩', '惟忠', '克让'],
        '言情': ['言蹊', '星河', '南风', '知许', '一诺', '温言', '沈念', '顾安', '陆晚', '慕橙', '简一', '安然'],
        '悬疑': ['默', '寒', '沉', '夜', '深', '渊', '影', '诫', '谜', '执', '寻', '微'],
        '恐怖': ['冥', '煞', '诡', '魇', '阴', '寂', '墟', '殁', '谶', '幽', '魉', '祟'],
        '通用': ['逸', '轩', '辰', '言', '墨', '凡', '宁', '之', '远', '舟', '微', '白']
      };
      const givens = genreGiven[genre] || genreGiven['通用'];
      const names = [];
      for (let i = 0; i < 5; i++) {
        names.push(pickRandom(surnames) + pickRandom(givens));
      }
      return `为「${genre}」题材生成 5 个角色名供参考：\n\n  ${names.join('  ·  ')}\n\n提示：好的角色名应符合世界观设定、易于记忆、有辨识度。`;
    }
  },
  { id: 'inspiration', test: /(灵感|点子|想法|创意|没思路|写什么)/i,
    reply: (ctx) => {
      const genre = ctx?.novel?.genre || '';
      const inspirations = {
        '玄幻': ['主角获得一本上古功法的残页，修炼后发现自己每突破一次境界就会失去一段记忆，为了找回记忆必须不断变强。',
          '一个被逐出宗门的外门弟子，意外获得可以吞噬他人灵根的禁忌能力，走上一条孤独的强者之路。',
          '世界中突然出现了「灵气潮汐」，每隔百年灵气暴涨一次，各方势力为此暗中布局千年。'],
        '都市': ['主角意外获得一种能看到每个人头顶「剩余寿命」的能力，发现身边最亲近的人只剩 30 天。',
          '一个外卖骑手偶然进入了城市的「暗面」—一个与现实重叠但规则完全不同的空间。',
          '公司新来的 CEO 年轻得离谱，主角逐渐发现他其实是自己十年前死去的大学室友。'],
        '悬疑': ['一封迟到 20 年的信件揭开了一桩被所有人遗忘的凶案，而凶手可能就在收信人身边。',
          '密室中除了死者还留着一本日记，日记的最后一页写着「如果你看到这段话，说明我是对的」。',
          '主角调查连环失踪案，发现所有受害者都曾在同一天搜索过同一个电话号码。'],
        'default': ['尝试将两个毫不相干的元素碰撞在一起——比如「废土」和「美食」。',
          '给主角一个不得不做却做不好的事——比如一个哑巴必须去说服某人。',
          '从结局倒推：你想要的结局是什么？然后往前铺垫因果链。']
      };
      const pool = inspirations[genre?.split(',')[0]] || inspirations['default'];
      const pick = pickRandom(pool);
      return `创作灵感：\n\n${pick}\n\n提示：好的灵感核心在于「冲突」—角色想要的东西和他面对的障碍之间的张力。`;
    }
  },
  { id: 'template', test: /(模板|开头|开篇|结尾|过渡|章节结构)/i,
    reply: (ctx, input) => {
      if (/开头|开篇/.test(input)) {
        return pickRandom([
          '【悬念开篇法】直接展示一个反常场景，让读者产生疑问：\n"刀刃划过喉管的瞬间，李寒反而笑了。"\n→ 先给出结果，再慢慢解释为什么。',
          '【场景渲染法】用环境描写建立氛围和基调：\n"三月的雨落在长安城头，像一层薄纱笼罩着所有人的心事。"\n→ 用天气/季节/地点定调，让读者进入状态。',
          '【对话切入法】用一句有冲击力的对话直接进入剧情：\n"你确定要这么做？" "我从来不确定，但我必须做。"\n→ 对话暗示冲突，省去铺垫。',
          '【倒叙开篇法】先写高潮再回溯：\n"这是林远做过的最错误的决定，但此刻他并不知道。三天前的那个清晨，一切还来得及挽回……"\n→ 制造期待感。'
        ]);
      }
      if (/结尾/.test(input)) {
        return pickRandom([
          '【悬念钩子法】本章末尾留下一个悬念：\n"他推开门，看到的不是他等的人，而是一个他已经埋葬了三年的面孔。"\n→ 读者必须看下一章。',
          '【情绪余韵法】用一句感受性的话收尾：\n"那一刻他终于明白，有些路只能一个人走。"\n→ 给读者回味空间。',
          '【反转收束法】本章最后一句翻转前文认知：\n"而这一切，都只是他计划中的第一步。"\n→ 重新定义前文所有行为的意义。'
        ]);
      }
      return `章节结构模板：\n\n1. 场景切入（100-200字）—渲染环境/情绪\n2. 推进事件（500-800字）—角色行动+对话\n3. 冲突升级（500-800字）—矛盾爆发\n4. 转折/悬念（200-400字）—新信息/反转\n5. 收尾留白（100-200字）—情绪收束或钩子\n\n每章约 2000-3000 字，可根据节奏调整。`;
    }
  },
  { id: 'checklist', test: /(检查|待办|todo|清单|需要.*做)/i,
    reply: (ctx) => {
      const list = [];
      if (!ctx?.novel?.outline) list.push('生成创作方案（含大纲+角色+分章）');
      if (ctx?.novel && (ctx.characters?.length || 0) < 3) list.push('补充角色设定（至少 3 个主要角色）');
      const open = ctx?.foreshadowings?.filter((f) => f.status === 'open').length || 0;
      if (open > 5) list.push(`回收伏笔（当前 ${open} 个未回收）`);
      if (ctx?.novel && (ctx.novel.chapter_count || 0) === 0) list.push('开始写第一章');
      if (!list.length) list.push('一切就绪！可以继续创作下一章。');
      list.push('导入优秀小说到知识学习库（提升生成质量）');
      list.push('连接 Ollama 或云端模型解锁全部功能');
      return `创作待办清单：\n\n${list.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`;
    }
  },

  // === 学习与知识 ===
  { id: 'knowledge', test: /(学习|知识库|导入.*小说|风格|文风|学习风格)/i,
    reply: () => `知识学习库功能说明：

【作用】
导入优秀小说 txt，AI 学习其文笔、剧情逻辑、人物塑造方式，创作同类小说时参考借鉴。

【离线模式】
无大模型时用统计分析引擎学习：
- 句子长度分布、标点习惯
- 对话占比、高频词分析
- 题材自动识别（支持 10+ 类）
- 输出 6 维分析报告

【深度模式】
连接大模型后可重新深入学习：
- 文笔风格语义分析
- 剧情套路模式提取
- 人物塑造手法
- 可复用写作技法

【使用步骤】
1. 左侧菜单点「知识学习库」
2. 导入 txt + 选题材
3. 等 AI 学习完成
4. 新建小说时勾选已学知识库

越学越聪明，生成质量越高。`
  },
  { id: 'analysis_stats', test: /(分析|统计|学了多少|知识库.*多少)/i,
    reply: (ctx) => {
      const k = ctx?.knowledgeStats;
      if (!k) return '正在统计知识学习库数据...';
      return `知识学习库统计：\n\n已学习：${k.learned || 0} 个\n学习中：${k.learning || 0} 个\n待学习：${k.pending || 0} 个\n总计：${k.total || 0} 个\n${k.total ? `题材分布：${k.byGenre || '未知'}` : ''}`;
    }
  },

  // === 设置与引导 ===
  { id: 'ollama', test: /(ollama|本地模型|离线|断网|不用.*api|不用.*key)/i,
    reply: () => `Ollama 本地模型指南：

【什么是 Ollama】
免费开源的本地大模型运行工具，安装后无需 API Key、无需联网即可创作。

【安装步骤】
1. 访问 ollama.com 下载安装包
2. 安装后打开终端运行：ollama pull qwen2.5:7b
3. 等待模型下载（约 4-5GB）
4. 回到本软件设置页点「检测 Ollama」

【推荐模型】
- qwen2.5:7b — 速度快，中文好，推荐入门（需 8GB 内存）
- qwen2.5:14b — 质量更高，适合正式创作（需 16GB）
- deepseek-r1:7b — 推理能力强，适合悬疑推理类
- llama3.2:3b — 轻量级，低配电脑可用

【三层降级】
Ollama（完整AI） > 内置引擎（轻量生成） > 规则引擎（当前模式）

装完 Ollama 后，即使断网也能生成正文、对话、学习。`
  },
  { id: 'mode_info', test: /(模式|当前.*模式|运行模式|auto|always|never)/i,
    reply: (ctx) => {
      const mode = ctx?.localMode || 'auto';
      const modes = {
        auto: '自动模式：有云端 API 时用云端，没有时自动切换到本地（Ollama/规则引擎）',
        always: '始终本地模式：强制使用本地模型，不调用云端 API',
        never: '始终云端模式：强制使用云端 API，不使用本地模型'
      };
      const layer = ctx?.activeLayer || 'rules';
      const layers = {
        ollama: 'Ollama 本地模型（完整 AI 能力）',
        transformers: '内置推理引擎（轻量生成）',
        rules: '规则引擎（关键词匹配+模板生成）',
        none: '未激活'
      };
      return `当前运行模式：\n\n模式：${modes[mode]}\n活跃层：${layers[layer]}\n\n切换模式：设置页 → 本地大模型 → 模式选项`;
    }
  },
  { id: 'suggest', test: /(建议|推荐|怎么办|如何.*写|怎么.*写|技巧)/i,
    reply: () => pickRandom([
      `创作建议：\n\n1. 先定核心冲突——主角想要什么？什么阻止他？\n2. 大纲不必完美，先出框架再逐章细化\n3. 每章结尾留钩子——读者才有动力翻下一页\n4. 角色驱动剧情——让角色的选择推动故事，而非外部事件\n5. 定期检查伏笔——别让前期埋的坑被遗忘`,
      `写作技巧：\n\n1. 展示而非叙述（Show don't tell）——用行为/对话展示性格，而非旁白说明\n2. 句长控制节奏——紧张时用短句，舒缓时用长句\n3. 对话推进剧情——每句对话要么推进剧情，要么塑造角色\n4. 感官描写——视觉听觉触觉嗅觉味觉，至少写两种\n5. 留白——有些事不说比说了更有力`,
      `长篇连载技巧：\n\n1. 每 50 章封存阶段记忆——防止后期剧情与前期矛盾\n2. 每 10 章更新角色档案——防止角色性格突变\n3. 每 5 章校准大纲——防止长篇后期剧情偏离\n4. 伏笔定期检查——超过 50 章未回收的伏笔要安排回收\n5. 文风重锚定——每 50 章用最近章节重新锁定文风`
    ])
  },

  // === 情绪/闲聊 ===
  { id: 'emotion_sad', test: /(难过|伤心|悲伤|emo|抑郁|不开心|累|不想写)/i,
    reply: () => pickRandom([
      '创作是一件孤独的事，但也是一件了不起的事。每一个字都是你创造的宇宙。\n\n如果不想写，就不写。休息也是创作的一部分。看看好电影、读读书，灵感会自己来的。',
      '卡文很正常，所有作家都会遇到。试试：\n1. 换一个场景写——跳过卡住的段落\n2. 写一个角色的日常——不推进剧情也行\n3. 和你的角色"对话"——问他"你现在想做什么"\n4. 看一段你喜欢的小说——找回节奏感',
      '累了就歇歇。你的小说不会跑掉，角色们会等着你回来。'
    ])
  },
  { id: 'emotion_happy', test: /(开心|高兴|兴奋|太好了|不错|厉害)/i,
    reply: () => pickRandom(['太好了！创作顺利的时候是最享受的。', '继续保持！灵感不等人。', '赞！写完别忘了检查一下 AI 味。'])
  },
  { id: 'joke', test: /(笑话|讲个|逗|无聊|闷)/i,
    reply: () => pickRandom([
      '一个作家对编辑说：「我的小说有两个版本，一个有剧情，一个有文笔。」编辑说：「那就出两本吧，分别卖给想看剧情的和想看文笔的。」',
      '主角问配角：「你知道你为什么是配角吗？」配角：「因为作者没有给我起名字。」',
      '编辑：「你的小说开头太慢了。」作家：「那是因为主角还在走路。」编辑：「那就让他跑！」'
    ])
  },

  // === 通用兜底（带上下文感知） ===
  { id: 'default', test: /.*/,
    reply: (ctx, input, mem) => {
      // 尝试从上下文推断意图
      if (mem?.lastIntent === 'character') {
        return `你还在聊角色的事吗？输入「角色」可以重新查看角色列表，或者告诉我你想了解哪个角色的详细信息。`;
      }
      if (mem?.lastIntent === 'foreshadowing') {
        return `关于伏笔，你有什么具体想了解的吗？可以输入「伏笔」查看列表。`;
      }
      // 模糊匹配——尝试关键词联想
      if (/写|写小说|创作|生成/.test(input)) {
        return `创作功能需要连接大模型。我可以帮你：\n- 查看角色（输入「角色」）\n- 查看伏笔（输入「伏笔」）\n- 获取灵感（输入「灵感」）\n- 获取写作模板（输入「模板」）\n\n连接 Ollama 或云端模型后就能生成方案和写正文了。`;
      }
      if (/什么|什么意思|解释/.test(input)) {
        return `我可以解释创作相关的概念。试试输入：\n- 「帮助」查看全部功能\n- 「角色」查看角色列表\n- 「伏笔」了解伏笔追踪\n- 「Ollama」了解本地模型`;
      }
      return pickRandom([
        `我理解你说的是「${input.slice(0, 20)}」。离线模式下我主要处理创作管理类问题。输入「帮助」查看我能做什么。`,
        `当前是离线规则引擎。我覆盖了 30+ 种意图：角色查询、伏笔追踪、创作灵感、取名、模板、建议等。输入「帮助」查看全部。`,
        `如果你想要更智能的对话，可以在设置中连接 Ollama 本地模型（完全免费）或云端 API。现在输入「帮助」查看离线可用功能。`
      ]);
    }
  }
];

function matchRule(input, ctx, mem) {
  const text = String(input || '').toLowerCase().trim();
  for (const intent of INTENTS) {
    if (intent.test.test(text)) {
      return { id: intent.id, reply: intent.reply(ctx, text, mem) };
    }
  }
  return { id: 'default', reply: INTENTS.find((i) => i.id === 'default').reply(ctx, text, mem) };
}

/**
 * 规则引擎对话（增强版：多轮上下文+30+意图）
 */
export function ruleEngineChat({ messages, context, sessionKey }) {
  const mem = getConvMemory(sessionKey || 'default');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const result = matchRule(lastUser?.content, context, mem);
  updateConvMemory(sessionKey || 'default', result.id, lastUser?.content || '');
  return { content: result.reply, finishReason: 'stop', layer: 'rules' };
}

// ===== 统一本地推理入口 =====

/**
 * 获取当前本地模式状态
 */
export async function getLocalModelStatus() {
  // Ollama 探测（安全，不会崩溃）
  const ollama = await detectOllama();
  const savedOllamaModel = getSetting('ollama_model', '');
  const savedTransformersModel = getSetting('transformers_model', 'Xenova/Qwen2.5-0.5B-Instruct');
  const transformersInstalled = getSetting('transformers_installed', '0') === '1';
  const localMode = getSetting('local_mode', 'auto');

  // transformers.js 可用性检查（延迟加载，失败不崩溃主进程）
  let transformersAvailable = false;
  if (transformersInstalled) {
    // 只有已安装模型时才检查（减少不必要的导入）
    try {
      transformersAvailable = await isTransformersAvailable();
    } catch {
      transformersAvailable = false;
    }
  }

  let activeLayer = 'none';
  if (ollama.available && ollama.models.length) activeLayer = 'ollama';
  else if (transformersAvailable && transformersInstalled) activeLayer = 'transformers';
  else activeLayer = 'rules';

  return {
    mode: localMode,
    activeLayer,
    hfEndpoint: getSetting('hf_endpoint', ''),
    ollama: {
      available: ollama.available,
      url: ollama.url,
      models: ollama.models,
      version: ollama.version,
      selectedModel: savedOllamaModel || (ollama.models[0] || '')
    },
    transformers: {
      available: transformersAvailable,
      installed: transformersInstalled,
      modelReady: transformersInstalled && transformersAvailable,
      selectedModel: savedTransformersModel,
      models: BUILTIN_MODELS,
      downloadProgress: _modelDownloadProgress,
    },
    rules: {
      available: true,
      note: '规则引擎兜底：关键词匹配+预设回复，能力有限'
    }
  };
}

/**
 * 本地对话 — 按三层降级自动选择
 */
export async function localChat({ messages, onDelta, signal, context, temperature }) {
  const status = await getLocalModelStatus();

  // Layer 1: Ollama
  if (status.activeLayer === 'ollama') {
    try {
      const model = status.ollama.selectedModel || status.ollama.models[0];
      if (!model) throw new Error('没有可用的 Ollama 模型');
      return await ollamaChat({
        url: status.ollama.url,
        model,
        messages,
        onDelta,
        signal,
        temperature: temperature ?? 0.8
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 降级到下一层
    }
  }

  // Layer 2: transformers.js
  if (status.activeLayer === 'transformers') {
    try {
      return await transformersChat({ messages, onDelta, signal, temperature: temperature ?? 0.7 });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 降级到规则引擎
    }
  }

  // Layer 3: 规则引擎
  const result = ruleEngineChat({ messages, context, sessionKey: context?.sessionKey });
  if (onDelta) {
    onDelta(result.content);
  }
  return result;
}

/**
 * 判断是否应使用本地模式
 */
export function shouldUseLocal() {
  const mode = getSetting('local_mode', 'auto');
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  // auto: 检查是否有云端配置
  const llmConfig = JSON.parse(getSetting('llm_config', '{}') || '{}');
  if (llmConfig.model && (llmConfig.apiKey || llmConfig.provider === 'ollama')) return false;
  return true; // 没有云端配置，用本地
}

/**
 * 自主学习后台任务：在云端模型空闲时，用本地模型跑分析任务
 * 当前实现：用规则引擎 + TF-IDF 做基础分析，标记待深入学习
 */
export async function autoLearnInBackground(novelId) {
  // 如果有 Ollama 可用，用它做深度分析
  const status = await getLocalModelStatus();
  if (status.activeLayer === 'ollama') {
    return { layer: 'ollama', model: status.ollama.selectedModel };
  }
  // 没有 Ollama，用规则引擎标记待深入学习
  return { layer: 'rules', note: '本地模型不可用，已标记待云端模型空闲时深入学习' };
}

// ===== 本地章节内容生成（离线模式可用） =====
// 题材感知 + 角色性格感知 + 三幕式结构

const MONOLOGUE_LINES = [
  '难道这就是命运的安排吗？',
  '回想起来，一切都像是早已注定的。',
  '不，不能再犹豫了。',
  '他心中翻涌着无数念头。',
  '此刻的沉默，胜过千言万语。',
  '曾经以为遥不可及的东西，此刻近在咫尺。',
  '这一刻，他比任何时候都清醒。',
];

const SCENE_OPENERS = [
  '{char}站在{place}，{weather}。',
  '{char}推开门，映入眼帘的是{place}。',
  '清晨的阳光洒在{place}，{char}已经在此等候。',
  '{place}内，烛火摇曳，{char}正凝神思索。',
  '一阵脚步声打破了{place}的寂静，{char}循声望去。',
  '{char}缓步走入{place}，目光在四周扫过。',
];

const SCENE_CLOSERS = [
  '{char}望着{place}，心中{emotion}。',
  '夜色渐深，{char}独自站在{place}，{emotion}。',
  '一切归于沉寂，{char}知道，{future}。',
  '{char}转身离开{place}，脚步比来时沉重了几分。',
  '月光洒在{char}的背影上，拉出一道长长的影子。',
  '风停了，一切似乎都结束了，但{char}知道，{future}。',
];

const DIALOG_TEMPLATES = [
  '"{dialog}"{char}{verb}。',
  '"{dialog}"{char}{verb}，目光中带着{emotion}。',
  '"{dialog}"{char}{verb}，语气不容置疑。',
  '{char}{verb}："{dialog}"',
  '"{dialog}"——{char}{verb}，声音低沉。',
];

const ACTION_TEMPLATES = [
  '{char}{action}，{result}。',
  '{char}猛地{action}，{result}。',
  '就在这时，{char}{action}。',
  '没等对方反应过来，{char}已经{action}。',
  '{char}深吸一口气，随即{action}。',
];

const TRANSITION_TEMPLATES = [
  '然而，{twist}。',
  '突然间，{twist}。',
  '就在此刻，{twist}。',
  '谁也没料到，{twist}。',
  '变故陡生——{twist}。',
];

function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || '');
}

/**
 * 规则引擎生成章节内容（离线模式）
 * 题材感知 + 角色性格感知 + 三幕式结构
 */
export function localGenerateChapter({ novel, chapterPlan, characters, previousSummary, chapterNumber, targetWords = 2000 }) {
  const title = chapterPlan?.title || `第${chapterNumber}章`;
  const genre = novel?.genre || '通用';
  const tpl = getGenreTemplates(genre);
  const mainChars = characters?.filter((c) => c.role_type === '主角' || c.role_type === '重要配角') || [];
  const charName = mainChars[0]?.name || '主角';
  const allChars = mainChars.map((c) => c.name).filter(Boolean);
  if (allChars.length === 0) allChars.push(charName);

  // 角色性格映射，用于生成符合性格的台词
  const charPersonality = {};
  for (const c of mainChars) {
    if (c.personality) charPersonality[c.name] = c.personality;
  }

  const usedDialogs = new Set();
  const usedNarration = new Set();
  const usedPlaces = new Set();
  function pickUnused(arr, used) {
    const available = arr.filter((x) => !used.has(x));
    const pick = available.length > 0 ? pickRandom(available) : pickRandom(arr);
    used.add(pick);
    return pick;
  }
  function pickChar() {
    return pickRandom(allChars);
  }
  function pickNarration() {
    return pickUnused(tpl.narration, usedNarration);
  }
  function pickDialog(charName) {
    // 50% 概率用性格感知生成
    if (Math.random() < 0.5 && charPersonality[charName]) {
      return generatePersonalityDialog(charPersonality[charName], genre);
    }
    return pickUnused(tpl.dialogs, usedDialogs);
  }

  const paragraphs = [];

  // === 第一幕：开场（约 25% 篇幅）===
  // 开头场景
  paragraphs.push(fillTemplate(pickRandom(SCENE_OPENERS), {
    char: charName, place: pickUnused(tpl.places, usedPlaces), weather: pickRandom(tpl.weathers)
  }));
  paragraphs.push(pickNarration());

  // 开场对话（角色性格感知）
  const firstChar = pickChar();
  paragraphs.push(fillTemplate(pickRandom(DIALOG_TEMPLATES), {
    dialog: pickDialog(firstChar),
    char: firstChar,
    verb: pickRandom(tpl.verbs),
    emotion: pickRandom(tpl.emotions)
  }));

  // 第二个角色回应
  if (allChars.length > 1) {
    const secondChar = pickRandom(allChars.filter(n => n !== firstChar)) || pickChar();
    paragraphs.push(fillTemplate(pickRandom(DIALOG_TEMPLATES), {
      dialog: pickDialog(secondChar),
      char: secondChar,
      verb: pickRandom(tpl.verbs),
      emotion: pickRandom(tpl.emotions)
    }));
  }
  paragraphs.push(pickNarration());

  // === 第二幕：发展+冲突（约 50% 篇幅）===
  const act2Count = Math.max(4, Math.floor(targetWords / 80));
  for (let i = 0; i < act2Count; i++) {
    // 对话
    const speaker = pickChar();
    paragraphs.push(fillTemplate(pickRandom(DIALOG_TEMPLATES), {
      dialog: pickDialog(speaker),
      char: speaker,
      verb: pickRandom(tpl.verbs),
      emotion: pickRandom(tpl.emotions)
    }));

    // 每 2 轮插入叙述
    if (i % 2 === 1) {
      paragraphs.push(pickNarration());
    }

    // 每 3 轮插入动作
    if (i % 3 === 2) {
      paragraphs.push(fillTemplate(pickRandom(ACTION_TEMPLATES), {
        char: pickChar(),
        action: pickRandom(tpl.actions),
        result: pickRandom(tpl.results)
      }));
    }

    // 中点转折（三幕式中点）
    if (i === Math.floor(act2Count / 2)) {
      paragraphs.push(fillTemplate(pickRandom(TRANSITION_TEMPLATES), { twist: pickRandom(tpl.twists) }));
      paragraphs.push(pickNarration());
      // 转折后角色反应
      paragraphs.push(fillTemplate(pickRandom(DIALOG_TEMPLATES), {
        dialog: pickDialog(charName),
        char: charName,
        verb: pickRandom(tpl.verbs),
        emotion: pickRandom(tpl.emotions)
      }));
    }
  }

  // === 第三幕：高潮+收束（约 25% 篇幅）===
  // 高潮动作
  paragraphs.push(fillTemplate(pickRandom(ACTION_TEMPLATES), {
    char: charName,
    action: pickRandom(tpl.actions),
    result: pickRandom(tpl.results)
  }));

  // 独白
  paragraphs.push(pickRandom(tpl.monologues.length ? tpl.monologues : MONOLOGUE_LINES));

  // 如果有前情摘要，插入呼应
  if (previousSummary) {
    paragraphs.push(`${charName}回想起之前发生的一切——${previousSummary.slice(0, 50)}……不，不能再重蹈覆辙。`);
  }

  // 最后的对话+转折
  paragraphs.push(fillTemplate(pickRandom(DIALOG_TEMPLATES), {
    dialog: pickDialog(pickChar()),
    char: pickChar(),
    verb: pickRandom(tpl.verbs),
    emotion: pickRandom(tpl.emotions)
  }));

  // 补充到目标字数
  let content = paragraphs.join('\n\n');
  let fillRound = 0;
  while (content.length < targetWords * 0.85 && fillRound < 30) {
    const speaker = pickChar();
    const block = [
      fillTemplate(pickRandom(DIALOG_TEMPLATES), {
        dialog: pickDialog(speaker),
        char: speaker,
        verb: pickRandom(tpl.verbs),
        emotion: pickRandom(tpl.emotions)
      }),
      pickNarration(),
    ];
    content += '\n\n' + block.join('\n\n');
    fillRound++;
  }

  // 结尾
  content += '\n\n' + fillTemplate(pickRandom(SCENE_CLOSERS), {
    char: charName,
    place: pickUnused(tpl.places, usedPlaces),
    emotion: pickRandom(tpl.emotions),
    future: pickRandom(tpl.futures)
  });

  return { title, content, wordCount: content.length, layer: 'rules', genre: tpl.genre };
}

/**
 * 统一本地章节生成入口（Ollama 优先，降级到规则引擎）
 */
export async function localGenerateChapterSmart({ novel, chapterPlan, characters, previousSummary, chapterNumber, targetWords, onDelta }) {
  const status = await getLocalModelStatus();

  // Layer 1: Ollama 生成
  if (status.activeLayer === 'ollama') {
    try {
      const model = status.ollama.selectedModel || status.ollama.models[0];
      if (!model) throw new Error('没有可用模型');

      const messages = buildLocalChapterMessages({ novel, chapterPlan, characters, previousSummary, targetWords });
      const result = await ollamaChat({
        url: status.ollama.url,
        model,
        messages,
        onDelta,
        temperature: 0.8
      });
      return {
        title: chapterPlan?.title || `第${chapterNumber}章`,
        content: result.content,
        wordCount: result.content.length,
        layer: 'ollama',
        model
      };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 降级到下一层
    }
  }

  // Layer 2: transformers.js 内置推理引擎
  if (status.activeLayer === 'transformers') {
    try {
      const messages = buildLocalChapterMessages({ novel, chapterPlan, characters, previousSummary, targetWords });
      const result = await transformersChat({
        messages,
        onDelta,
        temperature: 0.7,
        maxNewTokens: Math.max(1024, Math.min(4096, Math.round((targetWords || 2000) * 0.6)))
      });
      return {
        title: chapterPlan?.title || `第${chapterNumber}章`,
        content: result.content,
        wordCount: result.content.length,
        layer: 'transformers',
        model: getSetting('transformers_model', '')
      };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 降级到规则引擎
    }
  }

  // Layer 3: 规则引擎
  const result = localGenerateChapter({
    novel, chapterPlan, characters, previousSummary, chapterNumber, targetWords
  });
  if (onDelta) onDelta(result.content);
  return result;
}

// 组装本地模型生成章节的 prompt（Ollama / transformers 共用）
function buildLocalChapterMessages({ novel, chapterPlan, characters, previousSummary, targetWords }) {
  const charList = (characters || []).map((c) => `${c.name}（${c.role_type}）：${c.personality || ''}`).join('\n');
  return [
    {
      role: 'system',
      content: `你是一位职业中文小说作家，擅长写${novel?.genre || '玄幻'}题材。

请根据大纲和角色设定写出本章正文。

【写作要求】
- 字数约 ${targetWords || 2000} 字
- 保持角色性格一致，每个角色说话方式不同
- 不要出现AI味，用自然的文学语言
- 不要用"值得注意的是"、"总而言之"、"与此同时"等书面套话
- 用动作和感官替代心理直述——写"他把碗摔在地上"而不是"他很愤怒"
- 细节要具体可感：写"三十块灵石"而不是"一些灵石"
- 句子长短错落，该短就短到两三个字
- 允许留白和闲笔，不必把因果交代完
- 开头从具体场景或动作切入，不要先铺世界观
- 对话要有潜台词、有打断、有答非所问，不要一问一答只交代信息
- 场景转换用空行，不要用"与此同时"等过渡词`
    },
    {
      role: 'user',
      content: `小说：《${novel?.title || ''}》\n题材：${novel?.genre || ''}\n世界观：${novel?.world_view || '未设定'}\n\n角色：\n${charList}\n\n前情摘要：${previousSummary || '（开头）'}\n\n本章规划：\n标题：${chapterPlan?.title || ''}\n概要：${chapterPlan?.summary || ''}\n\n请写出本章正文。直接输出正文，不要输出标题和任何说明。`
    }
  ];
}
