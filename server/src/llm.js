import { estimateTokens } from './lib.js';
import { getTaskConfig } from './model_router.js';

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
    model: 'deepseek-chat',
    note: '推理能力强，性价比高，适合长文创作'
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
  compressThreshold: 0.5
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
  const effectiveMax = maxTokens && cfg.maxTokens ? Math.min(maxTokens, cfg.maxTokens) : (maxTokens || cfg.maxTokens);
  const body = {
    model: cfg.model,
    messages: trimMessagesToBudget(messages, contextBudget(cfg)),
    temperature: temperature ?? cfg.temperature ?? 0.9,
    stream: typeof onDelta === 'function'
  };
  if (effectiveMax) body.max_tokens = effectiveMax;
  // Phase 5：tool-use 透传（非流式）
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }

  // 思考功能：按 provider/模型注入对应参数（不支持的环境静默忽略，避免 400）
  const reasoning = String(cfg.reasoning || 'off').toLowerCase();
  if (reasoning !== 'off') {
    const model = String(cfg.model || '').toLowerCase();
    if (cfg.provider === 'ollama') {
      body.think = true;
    } else if (cfg.provider === 'qwen') {
      body.enable_thinking = true;
    } else if (/o1|o3|o4|gpt-5|thinking/.test(model)) {
      body.reasoning_effort = reasoning;
    }
  } else {
    // reasoning=off 时，对支持思考的模型显式关闭，防止默认思考吞掉 max_tokens
    const model = String(cfg.model || '').toLowerCase();
    if (/deepseek.*r|reasoner/.test(model)) {
      body.enable_thinking = false;
    }
  }

  let resp;
  const isStream = typeof onDelta === 'function';
  // 流式调用加无数据超时（默认 120s），非流式加整体超时（默认 120s）
  const streamIdleTimeout = isStream ? (Number(opts.streamIdleTimeout) || 120000) : 0;
  const timeoutMs = isStream ? 0 : Number(opts.timeout) || 120000;
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
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：模型响应过慢，请检查网络、模型负载或增大超时。`);
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
    if (resp.status === 404) {
      throw new Error(`接口不存在（HTTP 404）：请检查 Base URL 与模型名是否拼写正确。${detail}`);
    }
    if (resp.status === 429) {
      throw new Error(`请求过于频繁或额度不足（HTTP 429）：请稍后重试或检查余额。${detail}`);
    }
    throw new Error(`调用失败（HTTP ${resp.status}）：${detail || resp.statusText}`);
  }

  if (isStream) {
    const r = await consumeStream(resp, onDelta, combined, streamIdleTimeout);
    cleanup();
    return r;
  }

  try {
    const data = await resp.json();
    const choice = data?.choices?.[0] || {};
    let content = choice.message?.content ?? '';
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
        content = retryChoice.message?.content ?? '';
        finishReason = retryChoice.finish_reason || 'stop';
        toolCalls = Array.isArray(retryChoice.message?.tool_calls) ? retryChoice.message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name,
          args: tc.function?.arguments || '{}'
        })) : [];
      }
    }

    return { content, finishReason, toolCalls };
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

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        try { reader.cancel(); } catch { /* ignore */ }
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
          const delta = json?.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            full += delta;
            onDelta(delta);
          }
          if (json?.choices?.[0]?.finish_reason) {
            finishReason = json.choices[0].finish_reason;
          }
        } catch {
          // 忽略无法解析的中间帧
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // 流中断时尽量保留已生成内容
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  if (buffer.trim()) {
    const payload = buffer.trim().replace(/^data:/, '').trim();
    if (payload && payload !== '[DONE]') {
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content ?? '';
        if (delta) { full += delta; onDelta(delta); }
      } catch { /* ignore */ }
    }
  }

  return { content: full, finishReason };
}

export { PROVIDER_PRESETS, DEFAULT_CONFIG };
