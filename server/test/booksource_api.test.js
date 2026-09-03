import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

// ESM 静态 import 会先于模块体执行，db.js 单例必须在 env 设置后动态加载
// （routes.js 依赖链里含 import_queue.js -> db.js，必须一并动态导入）
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-api-test-'));
process.env.NOVEL_DATA_DIR = dataDir;

const { db } = await import('../src/db.js');
const { setImportRunner, getJob } = await import('../src/import_queue.js');
const { default: routes } = await import('../src/routes.js');

const SEARCH_HTML = `<!doctype html><html><body>
<div class="box"><h4><a href="/book/1">测试小说甲</a></h4><span class="author">作者甲</span><p class="intro">甲的简介</p></div>
</body></html>`;
const TOC_HTML = `<!doctype html><html><body>
<div class="item"><a href="/book/1/1.html">第一章</a></div><div class="item"><a href="/book/1/2.html">第二章</a></div>
</body></html>`;
const CONTENT_HTML = `<!doctype html><html><body><div id="content">正文段落。</div></body></html>`;

const SOURCE_A = {
  bookSourceName: '源A',
  bookSourceUrl: 'https://a.test',
  searchUrl: 'https://a.test/search?q={{key}}',
  ruleSearch: { bookList: 'class.box', name: 'tag.h4@tag.a@text', author: 'class.author@text', intro: 'class.intro@text', bookUrl: 'tag.h4@tag.a@href' },
  ruleToc: { chapterList: 'class.item', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
  ruleContent: { content: 'id.content@html' }
};
const SOURCE_B = {
  bookSourceName: '源B',
  bookSourceUrl: 'https://b.test',
  searchUrl: 'https://b.test/s?key={{key}}',
  ruleSearch: { bookList: 'class.box', name: 'tag.h4@tag.a@text', bookUrl: 'tag.h4@tag.a@href' },
  ruleToc: { chapterList: 'class.item', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
  ruleContent: { content: 'id.content@html' }
};

let baseUrl;
let server;

before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', routes);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const rawFetch = globalThis.fetch;

async function api(method, url, body) {
  const res = await rawFetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

describe('书源导入与管理', () => {
  test('批量导入：坏条目报错，好条目入库；重复导入覆盖', async () => {
    const broken = { bookSourceName: '坏源' };
    let r = await api('POST', '/sources', { json: JSON.stringify([SOURCE_A, broken, SOURCE_B]) });
    assert.equal(r.status, 200);
    assert.equal(r.data.saved, 2);
    assert.equal(r.data.errors.length, 1);
    assert.match(r.data.errors[0].message, /缺少必填字段/);

    // 重复导入源A（改名）→ 覆盖不新增
    const renamed = { ...SOURCE_A, bookSourceName: '源A改' };
    r = await api('POST', '/sources', { json: JSON.stringify(renamed) });
    assert.equal(r.data.saved, 1);
    r = await api('GET', '/sources');
    const rows = r.data.sources.filter((s) => s.sourceUrl === SOURCE_A.bookSourceUrl);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, '源A改');
    assert.equal(r.data.sources.length, 2, '总计应为 2 条书源');
  });

  test('启用/禁用与删除', async () => {
    let r = await api('GET', '/sources');
    const id = r.data.sources.find((s) => s.name === '源B').id;
    r = await api('PATCH', `/sources/${id}`, { status: 'disabled' });
    assert.equal(r.status, 200);
    r = await api('GET', '/sources');
    assert.equal(r.data.sources.find((s) => s.id === id).status, 'disabled');
    // 恢复启用，供后续测试
    await api('PATCH', `/sources/${id}`, { status: 'enabled' });
  });

  test('聚合搜索：单源失败不阻塞，结果标注来源', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('a.test')) {
        const body = u.includes('/search') ? SEARCH_HTML : u.includes('.html') ? CONTENT_HTML : TOC_HTML;
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body, 'utf-8') };
      }
      return { ok: false, status: 500, arrayBuffer: async () => Buffer.from('') };
    };
    try {
      const r = await api('POST', '/sources/search', { keyword: '测试' });
      assert.equal(r.status, 200);
      assert.equal(r.data.results.length, 1);
      assert.equal(r.data.results[0].name, '测试小说甲');
      assert.equal(r.data.results[0].sourceName, '源A改');
      assert.equal(r.data.failures.length, 1);
      assert.equal(r.data.failures[0].sourceName, '源B');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('书源整本导入（队列集成）', () => {
  test('入队 → 抓目录 → 逐章正文 → 分析 → done', async () => {
    // mock runner 模拟分析管线
    setImportRunner(async ({ content, meta }) => {
      if (!content.includes('第一章')) throw new Error('语料缺少章节');
      return { styleId: 77 };
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      const body = u.includes('/search') ? SEARCH_HTML : u.includes('.html') ? CONTENT_HTML : TOC_HTML;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body, 'utf-8') };
    };
    try {
      let r = await api('POST', '/import/source', {
        sourceId: 1, bookUrl: 'https://a.test/book/1', name: '测试小说甲', author: '作者甲', target: 'style'
      });
      assert.equal(r.status, 200);
      const jobId = r.data.job.id;
      assert.equal(r.data.job.source_type, 'booksource');

      const waitDone = (id) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('任务超时未完成')), 8000);
        const poll = setInterval(() => {
          const j = getJob(id);
          if (['done', 'failed'].includes(j.status)) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve(j);
          }
        }, 100);
      });
      const j = await waitDone(jobId);
      assert.equal(j.status, 'done', `首次任务应成功，error: ${j.error}`);
      assert.equal(j.result_ref, 'style:77');
      assert.equal(j.total_chapters, 2);
      assert.equal(j.fetched_chapters, 2);
      assert.equal(j.title, '测试小说甲');
      const row = db.prepare('SELECT content FROM import_jobs WHERE id = ?').get(jobId);
      assert.match(row.content, /第一章/);

      // 幂等：已完成的书再次入队 409
      r = await api('POST', '/import/source', {
        sourceId: 1, bookUrl: 'https://a.test/book/1', name: '测试小说甲', target: 'style'
      });
      assert.equal(r.status, 409, `重复入队应 409，实际 ${r.status}: ${JSON.stringify(r.data)}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('书源被禁用后任务失败并给出明确原因', async () => {
    setImportRunner(async () => ({ styleId: 1 }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      const body = u.includes('/search') ? SEARCH_HTML : u.includes('.html') ? CONTENT_HTML : TOC_HTML;
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body, 'utf-8') };
    };
    try {
      // 禁用源A后入队新书
      await api('PATCH', '/sources/1', { status: 'disabled' });
      const r = await api('POST', '/import/source', {
        sourceId: 1, bookUrl: 'https://a.test/book/2', name: '另一本', target: 'style'
      });
      assert.equal(r.status, 200);
      const jobId = r.data.job.id;
      const j = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('任务超时')), 8000);
        const poll = setInterval(() => {
          const job = getJob(jobId);
          if (['done', 'failed'].includes(job.status)) {
            clearInterval(poll);
            clearTimeout(timer);
            resolve(job);
          }
        }, 100);
      });
      assert.equal(j.status, 'failed');
      assert.match(j.error, /书源已被删除或禁用/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
