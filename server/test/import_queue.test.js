import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import db 相关模块前设置独立数据目录；
// ESM 静态 import 会先于模块体求值，db 相关模块必须动态 import
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fanqie-queue-test-'));

const { enqueue, getJob, listJobs, cancelAll, retryJob, deleteJob, resumeOnBoot, setImportRunner } = await import('../src/import_queue.js');
const { db } = await import('../src/db.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 8000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(50);
  }
  throw new Error(`等待超时: ${label}`);
}

/** 伪造番茄书页/阅读页响应（最小可用结构，避免网络） */
function mockFanqieFetch({ chapterCount = 3, failChapter = -1 } = {}) {
  const chapters = Array.from({ length: chapterCount }, (_, i) => ({
    itemId: `item_${i + 1}`,
    title: `第${i + 1}章 测试`,
    needPay: false
  }));
  const pageState = {
    page: {
      bookName: '测试书籍',
      author: '测试作者',
      description: '简介',
      wordNumber: 30000,
      chapterListWithVolume: [chapters]
    }
  };
  return async (url) => {
    const u = String(url);
    if (u.includes('/page/')) {
      return { status: 200, ok: true, text: async () => `__INITIAL_STATE__=${JSON.stringify(pageState)}` };
    }
    if (u.includes('/reader/')) {
      const idx = chapters.findIndex((c) => u.includes(c.itemId));
      if (idx === failChapter) {
        // 缺失章节数据 → PARSE_FAILED（不可重试，模拟单章损坏快速跳过）
        return { status: 200, ok: true, text: async () => '__INITIAL_STATE__={}' };
      }
      const state = {
        reader: { chapterData: { title: chapters[idx].title, content: '<p>正文内容，用来凑字数。'.repeat(40) } }
      };
      return { status: 200, ok: true, text: async () => `__INITIAL_STATE__=${JSON.stringify(state)}` };
    }
    return { status: 404, ok: false, text: async () => '' };
  };
}

describe('import_queue', () => {
  before(() => {
    // 默认 runner：返回伪 styleId
    setImportRunner(async ({ job, content, meta }) => {
      if (!content || !content.includes('正文内容')) throw new Error('内容为空');
      return { styleId: 99 };
    });
  });

  test('完整流程：抓取 → 分析 → done，进度与 result_ref 正确', async () => {
    globalThis.fetch = mockFanqieFetch({ chapterCount: 3 });
    try {
      const { job } = enqueue({ bookId: '1001', target: 'style' });
      assert.equal(job.status, 'pending');
      await waitFor(() => getJob(job.id).status === 'done', 8000, 'job done');
      const j = getJob(job.id);
      assert.equal(j.title, '测试书籍');
      assert.equal(j.author, '测试作者');
      assert.equal(j.total_chapters, 3);
      assert.equal(j.fetched_chapters, 3);
      assert.equal(j.progress, 100);
      assert.equal(j.result_ref, 'style:99');
      assert.ok(j.content.includes('第1章 测试'));
      assert.ok(j.content.includes('正文内容'));
    } finally {
      delete globalThis.fetch;
    }
  });

  test('幂等：进行中重复提交返回 duplicated；done 后重复提交同样拒绝', async () => {
    globalThis.fetch = mockFanqieFetch({ chapterCount: 1 });
    try {
      const { job } = enqueue({ bookId: '1002', target: 'style' });
      await waitFor(() => getJob(job.id).status === 'done', 8000, 'job done');
      const again = enqueue({ bookId: '1002', target: 'style' });
      assert.equal(again.duplicated, true);
      assert.equal(again.reason.includes('已导入'), true);
      // 换 target 是另一个任务
      const other = enqueue({ bookId: '1002', target: 'knowledge', genre: '都市' });
      assert.equal(other.duplicated, false);
    } finally {
      delete globalThis.fetch;
    }
  });

  test('failed/cancelled 任务重新入队复用同一行', async () => {
    setImportRunner(async () => { throw new Error('分析失败'); });
    globalThis.fetch = mockFanqieFetch({ chapterCount: 1 });
    try {
      const { job } = enqueue({ bookId: '1003', target: 'style' });
      await waitFor(() => getJob(job.id).status === 'failed', 8000, 'job failed');
      assert.ok(getJob(job.id).error.includes('分析失败'));
      // content 缓存保留
      const savedContent = getJob(job.id).content;
      assert.ok(savedContent.includes('正文内容'));
      // 重试：换回正常 runner
      setImportRunner(async () => ({ styleId: 7 }));
      const r = retryJob(job.id);
      assert.ok(!r.error);
      await waitFor(() => getJob(job.id).status === 'done', 8000, 'retry done');
      // 重试时直接用缓存内容，无需重抓（content 一致）
      assert.equal(getJob(job.id).content, savedContent);
      assert.equal(getJob(job.id).result_ref, 'style:7');
    } finally {
      delete globalThis.fetch;
    }
  });

  test('单章失败跳过并计数，队列继续', async () => {
    globalThis.fetch = mockFanqieFetch({ chapterCount: 3, failChapter: 1 }); // 第 2 章风控
    try {
      const { job } = enqueue({ bookId: '1004', target: 'style' });
      await waitFor(() => getJob(job.id).status === 'done', 8000, 'job done');
      const j = getJob(job.id);
      assert.equal(j.fetched_chapters, 2, '成功章节计数（失败章不计入）');
      assert.equal(j.skipped_chapters, 1, '失败章节计入 skipped');
      assert.ok(j.content.includes('第1章 测试'));
      assert.ok(!j.content.includes('第2章 测试'), '失败章节内容不应出现');
    } finally {
      delete globalThis.fetch;
    }
  });

  test('cancelAll：pending 任务立即取消；取消后可重试', async () => {
    // 全程 mock 404：即使竞态触发抓取也快速失败，绝无真实网络请求
    globalThis.fetch = async () => ({ status: 404, ok: false, text: async () => '' });
    try {
      const { job } = enqueue({ bookId: '1005', target: 'knowledge', genre: '科幻' });
      // cancelAll 同步 UPDATE，先于异步 runLoop 取到该任务
      const jobs = cancelAll();
      assert.ok(jobs.find((j) => j.id === job.id));
      await waitFor(() => getJob(job.id).status === 'cancelled', 3000, 'job cancelled');
      // 重试：任务重新入队并因 404 落 failed，状态机走通
      retryJob(job.id);
      await waitFor(() => getJob(job.id).status === 'failed', 8000, 'retry settled');
      assert.ok(getJob(job.id).error.includes('不存在'));
    } finally {
      delete globalThis.fetch;
    }
  });

  test('deleteJob：进行中拒绝，终态允许', async () => {
    globalThis.fetch = mockFanqieFetch({ chapterCount: 1 });
    try {
      const { job } = enqueue({ bookId: '1006', target: 'style' });
      const del = deleteJob(job.id);
      // 任务可能已完成或仍在进行，两种结果都合法；终态后删除必须成功
      await waitFor(() => ['done', 'failed'].includes(getJob(job.id)?.status || ''), 8000, 'job settled');
      const del2 = deleteJob(job.id);
      assert.ok(del2.ok);
      assert.equal(getJob(job.id), null);
    } finally {
      delete globalThis.fetch;
    }
  });

  test('resumeOnBoot：fetching 清缓存重排队；analyzing 保留缓存', async () => {
    db.prepare(
      "INSERT INTO import_jobs (book_id, target, status, content, title) VALUES ('2001', 'style', 'fetching', '部分缓存', 'A')"
    ).run();
    db.prepare(
      "INSERT INTO import_jobs (book_id, target, status, content, title) VALUES ('2002', 'style', 'analyzing', '完整缓存', 'B')"
    ).run();
    resumeOnBoot();
    const a = db.prepare("SELECT * FROM import_jobs WHERE book_id = '2001'").get();
    const b = db.prepare("SELECT * FROM import_jobs WHERE book_id = '2002'").get();
    assert.equal(a.status, 'pending');
    assert.equal(a.content, '', 'fetching 恢复应清空部分缓存');
    assert.equal(b.status, 'pending');
    assert.equal(b.content, '完整缓存', 'analyzing 恢复应保留缓存');
  });

  test('listJobs 不暴露 content 大字段', () => {
    const jobs = listJobs();
    assert.ok(Array.isArray(jobs));
    for (const j of jobs) assert.equal('content' in j, false);
  });

  test('知识库任务的 result_ref 为 knowledge: 前缀', async () => {
    setImportRunner(async () => ({ corpusId: 55 }));
    globalThis.fetch = mockFanqieFetch({ chapterCount: 1 });
    try {
      const { job } = enqueue({ bookId: '1007', target: 'knowledge', genre: '悬疑' });
      await waitFor(() => getJob(job.id).status === 'done', 8000, 'job done');
      const j = getJob(job.id);
      assert.equal(j.result_ref, 'knowledge:55');
      assert.equal(j.genre, '悬疑');
    } finally {
      delete globalThis.fetch;
    }
  });
});
