import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// 使用临时数据目录，避免污染 src/data 下的真实库
process.env.NOVEL_DATA_DIR = '/tmp/novel-test-data';

// 限速/重试链路会遗留最长 30s 的冷却定时器，测试结束后强制退出子进程
after(() => {
  resetLimiter?.();
  process.exit(0);
});

let acquire, onRateLimited, getLimiterState, resetLimiter;
let chat;

before(async () => {
  const limiter = await import('../src/rate_limit.js');
  acquire = limiter.acquire;
  onRateLimited = limiter.onRateLimited;
  getLimiterState = limiter.getLimiterState;
  resetLimiter = limiter.resetLimiter;
  resetLimiter();
  const llm = await import('../src/llm.js');
  chat = llm.chat;
});

test('默认速率下前 20 个请求立即可放行', async () => {
  resetLimiter();
  const start = Date.now();
  for (let i = 0; i < 20; i++) await acquire();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 3000, `20 个请求应瞬时放行，实际耗时 ${elapsed}ms`);
});

test('onRateLimited 无 Retry-After 时进入 ≥5s 冷却并降档', async () => {
  resetLimiter();
  onRateLimited();
  const st = getLimiterState();
  assert.ok(st.cooldownSeconds >= 5, `冷却应至少 5 秒，实际 ${st.cooldownSeconds}s`);
  assert.ok(st.rpm < st.defaultRpm, `速率应降档，实际 rpm=${st.rpm}`);
});

test('onRateLimited 携带 Retry-After=30 时冷却约 30 秒', async () => {
  resetLimiter();
  onRateLimited(30);
  const st = getLimiterState();
  assert.ok(st.cooldownSeconds >= 29 && st.cooldownSeconds <= 31, `冷却应约 30 秒，实际 ${st.cooldownSeconds}s`);
});

test('Retry-After 过大时冷却被限制在上限内', async () => {
  resetLimiter();
  onRateLimited(99999);
  const st = getLimiterState();
  assert.ok(st.cooldownSeconds <= 120, `冷却应不超过 120 秒，实际 ${st.cooldownSeconds}s`);
});

test('10 秒内连续 429 只降一档速率', async () => {
  resetLimiter();
  onRateLimited();
  onRateLimited();
  onRateLimited();
  const st = getLimiterState();
  assert.ok(st.rpm >= st.defaultRpm / 2, `应只降一档（≥10），实际 rpm=${st.rpm}`);
});

test('resetLimiter 恢复默认速率', async () => {
  resetLimiter();
  onRateLimited();
  const slowed = getLimiterState().rpm;
  assert.ok(slowed < getLimiterState().defaultRpm);
  resetLimiter();
  assert.equal(getLimiterState().rpm, getLimiterState().defaultRpm);
});

test('llm.js 的 429 错误携带 Retry-After 头信息', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: 'rpm exhausted' } }),
    { status: 429, headers: { 'Retry-After': '1' } }
  );
  try {
    await assert.rejects(
      () => chat({
        config: { baseUrl: 'http://mock/v1', apiKey: 'test', model: 'mock-model' },
        messages: [{ role: 'user', content: 'hi' }]
      }),
      (err) => {
        assert.equal(err.retryAfter, 1, '应解析 Retry-After=1');
        assert.match(err.message, /rpm exhausted/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test('llm.js 429 无 Retry-After 头时不带 retryAfter 字段', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: 'rate limit reached' } }),
    { status: 429, headers: {} }
  );
  try {
    await assert.rejects(
      () => chat({
        config: { baseUrl: 'http://mock/v1', apiKey: 'test', model: 'mock-model' },
        messages: [{ role: 'user', content: 'hi' }]
      }),
      (err) => {
        assert.equal(err.retryAfter, undefined);
        return true;
      }
    );
  } finally {
    globalThis.fetch = orig;
  }
});
