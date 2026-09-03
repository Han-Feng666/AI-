import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { parseBookInputs, extractInitialState, fetchBookMeta, deobfuscate, loadDeobfMap } = await import('../src/fanqie.js');

const FIXTURE_PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'fanqie_page.html'), 'utf-8');
const FIXTURE_READER = fs.readFileSync(path.join(__dirname, 'fixtures', 'fanqie_reader_1.html'), 'utf-8');

describe('parseBookInputs', () => {
  test('解析书籍页链接', () => {
    expectList('https://fanqienovel.com/page/7143038691944959774', ['7143038691944959774']);
  });

  test('解析阅读页链接（取书籍 ID 部分）', () => {
    expectList('https://fanqienovel.com/reader/7143038691944959774_6712474563301913351', ['7143038691944959774']);
  });

  test('解析裸数字 ID', () => {
    expectList('7143038691944959774', ['7143038691944959774']);
  });

  test('混合多行输入 + 去重 + 保持顺序', () => {
    const input = [
      '第一本 https://fanqienovel.com/page/7143038691944959774',
      '7143038691944959774',
      'https://fanqienovel.com/reader/7122999999999999999_6712474563301913351',
      '',
      '8888888888888888888'
    ].join('\n');
    expectList(input, ['7143038691944959774', '7122999999999999999', '8888888888888888888']);
  });

  test('非法输入返回空', () => {
    assert.deepEqual(parseBookInputs(''), []);
    assert.deepEqual(parseBookInputs(null), []);
    assert.deepEqual(parseBookInputs('不是链接 https://example.com/book abc'), []);
  });

  test('短数字（手机号等）不误识别', () => {
    assert.deepEqual(parseBookInputs('13800138000'), []);
  });

  function expectList(input, expected) {
    const list = parseBookInputs(input);
    assert.deepEqual(list.map((x) => x.bookId), expected);
  }
});

describe('fetchBookMeta（mock 网络）', () => {
  test('从真实书页 fixture 解析书名/作者/章节目录', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { status: 200, ok: true, text: async () => FIXTURE_PAGE };
    };
    try {
      const meta = await fetchBookMeta('7143038691944959774');
      assert.ok(calls[0].includes('/page/7143038691944959774'));
      assert.ok(meta.title, '应有书名');
      assert.ok(meta.author, '应有作者');
      assert.ok(meta.chapterCount > 0, '应有章节');
      assert.ok(meta.chapters.length === meta.chapterCount);
      assert.ok(meta.chapters.every((c) => c.itemId && typeof c.needPay === 'boolean'));
      assert.ok(meta.freeCount > 0, '应有免费章节');
    } finally {
      delete globalThis.fetch;
    }
  });

  test('空 body 判定风控并重试后抛错', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { status: 200, ok: true, text: async () => '' };
    };
    try {
      await assert.rejects(fetchBookMeta('123'), (e) => e.code === 'RISK_LIMITED');
      assert.ok(calls >= 2, `应至少重试一次，实际 ${calls} 次`);
    } finally {
      delete globalThis.fetch;
    }
  });

  test('404 直接失败（NOT_FOUND，不重试）', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { status: 404, ok: false, text: async () => 'not found' };
    };
    try {
      await assert.rejects(fetchBookMeta('123'), (e) => e.code === 'NOT_FOUND');
      assert.equal(calls, 1, '404 不应重试');
    } finally {
      delete globalThis.fetch;
    }
  });
});

describe('阅读页章节数据解析', () => {
  test('extractInitialState + deobfuscate 全链路与 fetchChapter 行为一致', () => {
    const state = extractInitialState(FIXTURE_READER);
    const cd = state.reader.chapterData;
    const { map } = loadDeobfMap();
    const r = deobfuscate(cd.content, map);
    assert.equal(r.residual, 0);
    assert.ok(cd.title, '章节标题应为明文');
  });
});
