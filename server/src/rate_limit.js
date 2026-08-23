/**
 * 全局 LLM 请求限速器（滑动窗口 + 429 自适应退避）
 *
 * 用于风格库 / 学习知识库等「批量分块分析」流程：这类流程会连续发起大量请求，
 * 不做限速时很容易瞬间打满模型服务商 / 中转站的 RPM（每分钟请求数）配额，
 * 触发 "rpm exhausted" 类的 HTTP 429，导致分析到中途整体失败。
 *
 * 用法：
 *   发起每个 LLM 请求前 await acquire()；
 *   捕获到 429 限流错误时调用 onRateLimited(retryAfterSec)，
 *   内部会进入冷却并降低速率，让窗口有时间恢复。
 */

const WINDOW_MS = 60000;        // 滑动窗口：1 分钟
const DEFAULT_RPM = 20;         // 默认每分钟请求数（保守值，避免打满大多数中转站）
const MIN_RPM = 3;              // 429 退避后的最低速率
const RECOVERY_MS = 120000;     // 连续健康运行多长时间后恢复一档速率
const MAX_COOLDOWN_MS = 120000; // 单次冷却上限（防止 Retry-After 过长导致长时间卡死）

const state = {
  rpm: DEFAULT_RPM,
  timestamps: [],
  coolDownUntil: 0,
  lastRateLimitedAt: 0,
  lastHalvedAt: 0,
  lastRequestAt: 0,
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
  const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
  let cleanup = () => {};
  if (signal) {
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })); };
    signal.addEventListener('abort', onAbort, { once: true });
    cleanup = () => signal.removeEventListener('abort', onAbort);
  }
});

function now() {
  return Date.now();
}

// 连续健康一段时间后，逐步把速率恢复到默认档位
function maybeRestore() {
  if (state.rpm >= DEFAULT_RPM) return;
  if (state.coolDownUntil > now()) return;
  if (state.lastRateLimitedAt && now() - state.lastRateLimitedAt >= RECOVERY_MS) {
    state.rpm = Math.min(DEFAULT_RPM, Math.ceil(state.rpm * 1.5));
  }
}

/**
 * 等待直到允许发起下一个 LLM 请求。
 * 返回时表示已获得一个「请求名额」。
 */
export async function acquire(signal) {
  maybeRestore();
  let t = now();

  // 429 冷却期内强制等待，让服务商窗口恢复
  if (t < state.coolDownUntil) {
    await sleep(state.coolDownUntil - t, signal);
    t = now();
  }

  // 滑动窗口：清理过期时间戳
  state.timestamps = state.timestamps.filter((ts) => t - ts < WINDOW_MS);

  // 已打满当前速率：等最旧的请求滑出窗口再放行
  if (state.timestamps.length >= state.rpm) {
    const oldest = state.timestamps[0];
    await sleep(WINDOW_MS - (t - oldest), signal);
    t = now();
    state.timestamps = state.timestamps.filter((ts) => t - ts < WINDOW_MS);
  }

  state.timestamps.push(now());
  state.lastRequestAt = now();
}

/**
 * 收到 429（限流 / 配额）后调用：进入冷却并把速率降档。
 * @param {number} [retryAfterSec] 服务商返回的 Retry-After 秒数（可选）
 */
export function onRateLimited(retryAfterSec) {
  const retryAfter = Math.max(0, Number(retryAfterSec) || 0);
  const waitMs = retryAfter > 0
    ? Math.min(retryAfter * 1000, MAX_COOLDOWN_MS)
    : Math.max(5000, Math.round(WINDOW_MS / state.rpm));
  state.coolDownUntil = now() + waitMs;
  state.lastRateLimitedAt = now();
  // 降档限速（最多每 10 秒降一档）：一批并发请求同时被 429 时，避免速率被瞬间降到最低
  if (now() - state.lastHalvedAt >= 10000) {
    state.rpm = Math.max(MIN_RPM, Math.floor(state.rpm / 2));
    state.lastHalvedAt = now();
  }
  // 清空窗口：避免冷却刚结束又立刻打满，再次触发 429
  state.timestamps = [];
}

/** 当前限速器状态（诊断 / 日志用，不下发到前端） */
export function getLimiterState() {
  return {
    rpm: state.rpm,
    defaultRpm: DEFAULT_RPM,
    cooldownSeconds: Math.max(0, Math.ceil((state.coolDownUntil - now()) / 1000)),
    lastRateLimitedAt: state.lastRateLimitedAt,
    lastRequestAt: state.lastRequestAt,
  };
}

/** 重置限速器（切换模型 / 服务商后调用） */
export function resetLimiter() {
  state.rpm = DEFAULT_RPM;
  state.timestamps = [];
  state.coolDownUntil = 0;
  state.lastRateLimitedAt = 0;
  state.lastHalvedAt = 0;
  state.lastRequestAt = 0;
}
