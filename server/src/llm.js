import { estimateTokens } from './lib.js';
import { getTaskConfig } from './model_router.js';

// 还原模型/中转站把中文双重转义成的字面 \uXXXX 序列（含代理对）。
// 正常内容里的真实反斜杠+\u（如讲解转义用法的文本）会被一并还原，但小说创作场景不受影响。
export function unescapeUnicode(str) {
  const s = String(str || '');
  if (!s.includes('\\u')) return s;
  // 先处理代理对（\uD83D\uDE00 等），避免被单字符还原拆散
  let out = s.replace(/\\u([0-9a-fA-F]{4})\\u([0-9a-fA-F]{4})/g, (m, h1, h2) => {
    const c1 = parseInt(h1, 16);
    const c2 = parseInt(h2, 16);
    if (c1 >= 0xd800 && c1 <= 0xdbff && c2 >= 0xdc00 && c2 <= 0xdfff) {
      return String.fromCharCode(c1, c2);
    }
    return m;
  });
  out = out.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return out;
}

// 部分模型/中转网关在支持 function-calling 但协议不完整时，会在 content 里以 XML 文本
// 形式输出工具调用（<function_calls><invoke name="X"><parameter name="k">v</parameter>...</invoke></function_calls>），
// 而非 OpenAI 结构化 message.tool_calls。此函数把这类文本解析成 {name,args} 列表，供上层当 toolCalls 使用。
export function parseTextToolCalls(content) {
  const s = String(content || '');
  const out = [];
  const invokeRe = /<invoke\s+name\s*=\s*"([^"]+)"([\s\S]*?)<\/invoke>/gi;
  let m;
  while ((m = invokeRe.exec(s)) !== null) {
    const name = m[1].trim();
    const body = m[2] || '';
    const args = {};
    const paramRe = /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi;
    let pm;
    let hasParam = false;
    while ((pm = paramRe.exec(body)) !== null) {
      hasParam = true;
      const key = pm[1].trim();
      let val = pm[2].trim();
      try { val = JSON.parse(val); } catch { /* keep as string */ }
      args[key] = val;
    }
    if (!hasParam) {
      // 兜底：<invoke name="X">{json}</invoke> 或 body 里裸 JSON 参数
      const jsonM = body.match(/(\{(?:[^{}]|\{[^{}]*\})*\}|\[(?:[^\[\]]|\[[^\[\]]*\])*\])/);
      if (jsonM) {
        try { Object.assign(args, JSON.parse(jsonM[1])); } catch { /* ignore */ }
      }
    }
    out.push({
      id: `txt_${out.length}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      args: JSON.stringify(args)
    });
  }
  return out;
}

const PROVIDER_PRESETS = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    note: '支持 GPT-4o / GPT-4.1 等'
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    note: '推理能力强，性价比高，适合长文创作（deepseek-chat 已停用，改用 v4 系列）'
  },
  moonshot: {
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    note: '长上下文，支持 32k-128k'
  },
  qwen: {
    name: '通义千问 (Qwen)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    note: '阿里云百炼，兼容模式'
  },
  zhipu: {
    name: '智谱 (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    note: 'GLM-4 系列'
  },
  ollama: {
    name: 'Ollama (本地)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b',
    note: '本地模型，无需 API Key，可离线创作'
  },
  custom: {
    name: '自定义 (OpenAI 兼容)',
    baseUrl: '',
    model: '',
    note: '任意 OpenAI 兼容端点'
  }
};

const DEFAULT_CONFIG = {
  provider: 'custom',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.9,
  maxTokens: 8192,
  contextLength: 32768,
  reasoning: 'off',
  autoPolish: false,
  autoCompress: true,
  compressThreshold: 0.5,
  forceNonStreaming: false
};

// 计算单次请求的上下文预算（token）：窗口 - 输出预留 - 余量
export function contextBudget(config) {
  const ctx = Number(config?.contextLength) || 32768;
  const out = Number(config?.maxTokens) || 8192;
  return Math.max(4096, Math.floor(ctx - out - 4096));
}

// 基于预算裁剪历史消息：保留首条（system）与末条（最新 user），从最旧开始丢中间历史
function trimMessagesToBudget(messages, budget) {
  if (!budget || budget <= 0 || messages.length <= 2) return messages;
  const total = messages.reduce((s, m) => s + estimateTokens(m.content || ''), 0);
  if (total <= budget) return messages;
  const drop = [];
  let current = total;
  for (let i = 1; i < messages.length - 1; i++) {
    if (current <= budget || messages.length - drop.length <= 2) break;
    current -= estimateTokens(messages[i].content || '');
    drop.push(i);
  }
  return messages.filter((_, i) => !drop.includes(i));
}

function normalizeEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('未配置 API Base URL');
  if (/\/chat\/completions$/i.test(u)) return u;
  return `${u}/chat/completions`;
}

function buildHeaders(config) {
  const headers = {
    'Content-Type': 'application/json'
  };
  const apiKey = (config.apiKey || '').trim();
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

/**
 * 底层对话调用，支持流式与非流式。
 * @param {object} opts
 * @param {string} [opts.task] - 多模型路由任务类型（writing/planning/chat/summary/analysis/research）
 * @param {object} [opts.config] - LLM 配置 {baseUrl, apiKey, model, temperature, maxTokens}
 *                                未传时按 task 从多模型路由解析；也未解析到时使用默认配置
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {(delta:string)=>void} [opts.onDelta] - 流式增量回调
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content:string, finishReason:string}>}
 */
export async function chat(opts) {
  const {
    config,
    task,
    messages,
    temperature,
    maxTokens,
    onDelta,
    signal,
    tools,
    toolChoice
  } = opts;

  let cfg = { ...DEFAULT_CONFIG, ...config };
  // 多模型路由：仅当未显式传 config 或显式传了 task 时，尝试按任务解析
  if (task) {
    const routed = getTaskConfig(task);
    if (routed) cfg = { ...cfg, ...routed };
  }
  if (!cfg.model) throw new Error('未配置模型名称');
  if (!cfg.baseUrl && cfg.provider !== 'ollama') {
    const preset = PROVIDER_PRESETS[cfg.provider];
    if (preset?.baseUrl) cfg.baseUrl = preset.baseUrl;
  }
  if (!cfg.baseUrl) throw new Error('未配置 API Base URL');

  const endpoint = normalizeEndpoint(cfg.baseUrl);
  // 规范化数值字段：配置里可能因历史数据/手输存成字符串（如 temperature='0.9'、maxTokens='8192'），统一转回 Number；非法值给默认
  const safeNum = (v, def) => {
    if (v === null || v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  const effectiveMax = safeNum(
    (maxTokens && cfg.maxTokens) ? Math.min(maxTokens, cfg.maxTokens) : (maxTokens || cfg.maxTokens),
    0
  );
  const body = {
    model: String(cfg.model || ''),
    messages: trimMessagesToBudget(messages, contextBudget(cfg)),
    temperature: Math.min(1.99, Math.max(0, safeNum(temperature ?? cfg.temperature, 0.9))),
    stream: typeof onDelta === 'function' && !cfg.forceNonStreaming
  };
  if (effectiveMax) body.max_tokens = effectiveMax;
  // Phase 5：tool-use 透传（非流式）
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }

  // 思考功能：按 provider/模型注入对应参数（不支持的环境静默忽略，避免 400）
  const reasoning = String(cfg.reasoning || 'off').toLowerCase();
  const model = String(cfg.model || '').toLowerCase();
  // DeepSeek V4 系列（deepseek-v4-pro / deepseek-v4-flash）：思考参数为 extra_body.thinking + reasoning_effort
  const isDeepSeekV4 = /deepseek[-._]?v4[-._]?(pro|flash)?/.test(model);
  // 旧版模型名：deepseek-chat（非思考）/ deepseek-reasoner（思考）
  const isDeepSeekLegacy = /deepseek-chat|deepseek[-._]?reasoner/.test(model);
  if (reasoning !== 'off') {
    if (cfg.provider === 'ollama') {
      body.think = true;
    } else if (cfg.provider === 'qwen') {
      body.enable_thinking = true;
    } else if (isDeepSeekV4) {
      // DeepSeek V4 思考模式：官方参数
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = reasoning;
    } else if (/o1|o3|o4|gpt-5|thinking/.test(model)) {
      body.reasoning_effort = reasoning;
    }
  } else {
    // reasoning=off 时，对支持思考的模型显式关闭，防止默认思考吞掉 max_tokens
    if (isDeepSeekV4) {
      body.thinking = { type: 'disabled' };
      body.enable_thinking = false; // 兼容旧网关/中转
    } else if (isDeepSeekLegacy) {
      body.enable_thinking = false;
    }
  }

  let resp;
  const isStream = typeof onDelta === 'function';
  // 流式调用：响应头超时（connectTimeout，默认 180s）防止 fetch 无限挂起；拿到响应后交给 consumeStream 的 idle 超时（默认 300s）
  // 非流式调用：整体超时（默认 180s）
  const connectTimeoutMs = isStream ? (Number(opts.connectTimeout) || 180000) : (Number(opts.timeout) || 180000);
  const timeoutMs = isStream ? 0 : connectTimeoutMs;
  let timeoutCtrl = null;
  let timer = null;
  let combined = signal;
  let cleanup = () => {};
  if (timeoutMs > 0) {
    timeoutCtrl = new AbortController();
    const doAbort = () => timeoutCtrl.abort();
    if (signal?.aborted) timeoutCtrl.abort();
    else if (signal) signal.addEventListener('abort', doAbort);
    timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    combined = timeoutCtrl.signal;
    cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', doAbort);
    };
  } else if (isStream && connectTimeoutMs > 0) {
    // 流式：仅对「等待响应头」阶段设超时，避免 LLM API 不响应时永久挂起
    timeoutCtrl = new AbortController();
    const doAbort = () => timeoutCtrl.abort();
    if (signal?.aborted) timeoutCtrl.abort();
    else if (signal) signal.addEventListener('abort', doAbort);
    timer = setTimeout(() => timeoutCtrl.abort(), connectTimeoutMs);
    combined = timeoutCtrl.signal;
    cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', doAbort);
    };
  }
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify(body),
      signal: combined
    });
  } catch (e) {
    cleanup();
    if (e.name === 'AbortError') {
      if (signal?.aborted) throw e;
      throw new Error(`请求超时（${Math.round(connectTimeoutMs / 1000)} 秒）：模型 API 无响应，请检查 Base URL 是否正确、模型名称是否存在、网络是否可达。`);
    }
    throw new Error(`网络请求失败：${e.message}（请检查 Base URL 或网络连接）`);
  }

  if (!resp.ok) {
    cleanup();
    let detail = '';
    try {
      const j = await resp.json();
      detail = j?.error?.message || j?.message || JSON.stringify(j);
    } catch {
      detail = await resp.text().catch(() => '');
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`认证失败（HTTP ${resp.status}）：API Key 无效或无权限。${detail}`);
    }
    if (resp.status === 402) {
      throw new Error(`账户余额不足（HTTP 402）：API 服务返回「${detail}」，请到模型服务商后台充值或检查套餐用量。`);
    }
    if (resp.status === 404) {
      throw new Error(`接口不存在（HTTP 404）：请检查 Base URL 与模型名是否拼写正确。${detail}`);
    }
    if (resp.status === 429) {
      const err = new Error(`请求过于频繁或额度不足（HTTP 429）：请稍后重试或检查余额。${detail}`);
      const retryAfter = Number(resp.headers?.get?.('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = retryAfter;
      throw err;
    }
    if (resp.status === 503 && /model_not_found|no available channel/i.test(detail)) {
      throw new Error(`模型不可用（HTTP 503）：当前 API 网关没有渠道提供「${cfg.model}」这个模型。模型名大小写敏感、且中转站模型名可能与官方不同（如 Kimi-K2.6 / DeepSeek-V4-Flash）。请到设置页点击“获取模型列表”，选择列表中的准确名称。${detail}`);
    }
    if (resp.status >= 400 && resp.status < 500) {
      // 4xx 为确定性错误，重试不会成功，直接抛出
      throw new Error(`模型 API 拒绝请求（HTTP ${resp.status}）：${detail || resp.statusText}`);
    }
    throw new Error(`调用失败（HTTP ${resp.status}）：${detail || resp.statusText}`);
  }

  if (isStream) {
    // 响应头已收到，说明连接成功：释放仅用于「等待响应头」的 connect 超时定时器，
    // 避免它一直挂着，把整个流式会话也限制在 connectTimeout 内（慢速流式模型会因此被误杀）。
    if (timer) { clearTimeout(timer); timer = null; }
    const runStreamOnce = async () => {
      const streamIdleTimeout = Number(opts.streamIdleTimeout) || 300000;
      return consumeStream(resp, onDelta, combined, streamIdleTimeout);
    };
    try {
      const r0 = await runStreamOnce();
      const content0 = unescapeUnicode(r0.content);
      // 启动即中断（没收到有效正文）且非用户主动取消 → 短时重试 1 次
      const userCancelled = !!signal?.aborted;
      const retriable = r0.finishReason === 'length' && !userCancelled && (!content0 || content0.trim().length < 10);
      if (!retriable) {
        return { ...r0, content: content0, finishReason: r0.finishReason || 'stop' };
      }
      // 重试：重新发起流式请求（丢弃本次空响应，先释放原连接）
      try { resp.body && resp.body.cancel && resp.body.cancel(); } catch { /* ignore */ }
      const retryResp = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(cfg),
        body: JSON.stringify(body),
        signal: signal ?? undefined
      });
      if (!retryResp.ok) {
        // 重试仍失败：保留 original 标 length，交给上层续写兜底
        return { ...r0, content: content0, finishReason: 'length' };
      }
      const r1 = await consumeStream(retryResp, onDelta, signal, streamIdleTimeout);
      const content1 = unescapeUnicode(r1.content);
      return { ...r1, content: content1, finishReason: r1.finishReason || 'length' };
    } finally {
      cleanup();
    }
  }

  try {
    const data = await resp.json();
    const choice = data?.choices?.[0] || {};
    let content = unescapeUnicode(choice.message?.content ?? '');
    let finishReason = choice.finish_reason || 'stop';
    let toolCalls = Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name,
      args: tc.function?.arguments || '{}'
    })) : [];

    // 思考模型（如 glm-5.2）在小 max_tokens 下会全部消耗在 reasoning 上，content 为空
    // 检测到这种情况时自动用更大的 max_tokens 重试一次
    if (!content && finishReason === 'length' && !toolCalls.length && effectiveMax < 4000) {
      cleanup();
      const retryMax = Math.max(4000, effectiveMax * 4);
      const retryBody = { ...body, max_tokens: retryMax };
      const retryResp = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(cfg),
        body: JSON.stringify(retryBody),
        signal: signal ?? undefined
      });
      if (retryResp.ok) {
        const retryData = await retryResp.json();
        const retryChoice = retryData?.choices?.[0] || {};
        content = unescapeUnicode(retryChoice.message?.content ?? '');
        finishReason = retryChoice.finish_reason || 'stop';
        toolCalls = Array.isArray(retryChoice.message?.tool_calls) ? retryChoice.message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name,
          args: tc.function?.arguments || '{}'
        })) : [];
      }
    }

    // 兼容"XML 文本形式的工具调用"：模型没走结构化 tool_calls，而是把 <invoke> 写进 content。
    // 此时把文本调用解析进 toolCalls，并从 content 中剥离，避免把调用片段当回答回显给用户。
    if (!toolCalls.length && /<function_calls>|<invoke\s+name/i.test(content)) {
      const txtCalls = parseTextToolCalls(content);
      if (txtCalls.length) {
        toolCalls = txtCalls;
        content = content.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '').trim();
      }
    }

    return { content: unescapeUnicode(content), finishReason, toolCalls };
  } catch (e) {
    if (e.name === 'AbortError') {
      if (signal?.aborted) throw e;
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：模型响应过慢，请检查网络、模型负载或增大超时。`);
    }
    throw e;
  } finally {
    cleanup();
  }
}

async function consumeStream(resp, onDelta, signal, idleTimeoutMs = 120000) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let finishReason = '';
  let idleTimer = null;
  let signalAbortCleanup = null;

  const cancelReader = () => {
    try { reader.cancel(); } catch { /* ignore */ }
  };

  if (signal && !signal.aborted) {
    signal.addEventListener('abort', cancelReader, { once: true });
    signalAbortCleanup = () => signal.removeEventListener('abort', cancelReader);
  }

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        cancelReader();
        if (!signal?.aborted) {
          const err = new Error(`流式响应超时（${Math.round(idleTimeoutMs / 1000)} 秒无新数据）：模型可能卡住或网络中断。`);
          err.name = 'AbortError';
          throw err;
        }
      }, idleTimeoutMs);
    }
  };
  resetIdleTimer();

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { done, value } = await reader.read();
      resetIdleTimer();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') { finishReason = 'stop'; continue; }
        try {
          const json = JSON.parse(payload);
          // 中间帧出现 error 字段（如网关 503/限流/余额不足），直接抛出，避免静默返回空内容
          if (json?.error) {
            const msg = json.error.message || JSON.stringify(json.error).slice(0, 300);
            cancelReader();
            const err = new Error(`模型流式响应出错：${msg}`);
            throw err;
          }
          const delta = unescapeUnicode(json?.choices?.[0]?.delta?.content ?? '');
          if (delta) {
            full += delta;
            onDelta(delta);
          }
          if (json?.choices?.[0]?.finish_reason) {
            finishReason = json.choices[0].finish_reason;
          }
        } catch (e) {
          if (e instanceof Error && !(e instanceof SyntaxError) && e.message?.startsWith('模型流式响应出错')) {
            throw e;
          }
          // 忽略无法解析的中间帧
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // 网关在流中返回的明确错误（如 503 过载/限流/余额不足）原样抛出，不能静默吞掉
    if (e.message?.startsWith('模型流式响应出错')) throw e;
    // 其他异常：流中断时尽量保留已生成内容，但标记为 length 防止调用方误认为模型已自然收尾
    finishReason = 'length';
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (signalAbortCleanup) signalAbortCleanup();
  }

  if (buffer.trim()) {
    const payload = buffer.trim().replace(/^data:/, '').trim();
    if (payload && payload !== '[DONE]') {
      try {
        const json = JSON.parse(payload);
        const delta = unescapeUnicode(json?.choices?.[0]?.delta?.content ?? '');
        if (delta) { full += delta; onDelta(delta); }
      } catch { /* ignore */ }
    }
  }

  return { content: full, finishReason };
}

export { PROVIDER_PRESETS, DEFAULT_CONFIG };
