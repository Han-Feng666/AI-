import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import {
  parseSourceBatch, validateSource, evalJsonPath, evalHtmlRule,
  buildSearchRequest, searchBook, fetchToc, fetchContent
} from '../src/booksource.js';

const SEARCH_HTML = `<!doctype html><html><body>
<div class="result">
  <div class="bookbox"><h4><a href="/book/1">斗破苍穹</a></h4><span class="author">天蚕土豆</span><p class="intro">这是简介一</p><a class="more" href="/book/1">最新：第一章 大结局</a></div>
  <div class="bookbox"><h4><a href="/book/2">斗罗大陆</a></h4><span class="author">唐家三少</span><p class="intro">这是简介二</p><a class="more" href="/book/2">最新：第二章 完结</a></div>
</div>
</body></html>`;

const TOC_HTML = `<!doctype html><html><body>
<div class="list"><div class="item"><a href="/book/1/1.html">第一章 起点</a></div><div class="item"><a href="/book/1/2.html">第二章 抉择</a></div><div class="item"><a href="/book/1/3.html">第三章 终局</a></div></div>
</body></html>`;

const CONTENT_HTML = `<!doctype html><html><body><div id="content">
前一段正文。<br>后一段正文。<p>第二段落</p>
</div></body></html>`;

const LEGADO_SOURCE = {
  bookSourceName: '测试源',
  bookSourceUrl: 'https://fake.test',
  searchUrl: 'https://fake.test/search?q={{key}}',
  ruleSearch: {
    bookList: 'class.bookbox',
    name: 'tag.h4@tag.a@text',
    author: 'class.author@text',
    intro: 'class.intro@text',
    latestChapter: 'class.more@text',
    bookUrl: 'tag.h4@tag.a@href'
  },
  ruleBookInfo: { name: 'tag.h1@text', author: 'class.author@text' },
  ruleToc: { chapterList: 'class.item', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
  ruleContent: { content: 'id.content@html' }
};
const SOURCE = validateSource(LEGADO_SOURCE);

describe('parseSourceBatch', () => {
  test('解析数组书源并逐条校验', () => {
    const valid = JSON.parse(JSON.stringify(LEGADO_SOURCE));
    valid.bookSourceName = '源A';
    const broken = { bookSourceName: '缺字段' };
    const { items, errors } = parseSourceBatch(JSON.stringify([valid, broken]));
    assert.equal(items.length, 1);
    assert.equal(items[0].name, '源A');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('缺少必填字段'));
  });

  test('JSON 非法时整体报错', () => {
    const { items, errors } = parseSourceBatch('not json');
    assert.equal(items.length, 0);
    assert.ok(errors[0].message.includes('JSON 解析失败'));
  });

  test('JS/XPath 规则标记 partial', () => {
    const { items } = parseSourceBatch(JSON.stringify({
      bookSourceName: 'JS源',
      bookSourceUrl: 'https://x.test', searchUrl: 'https://x.test/s?key={{key}}',
      ruleSearch: { bookList: '<js>1</js>', name: '@XPath://a' },
      ruleToc: { chapterList: 'class.item', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href' },
      ruleContent: { content: 'id.content@html' }
    }));
    assert.equal(items.length, 1);
    assert.equal(items[0].partial.length, 2, 'JS 与 XPath 均应标记');
  });
});

describe('规则求值', () => {
  test('JSON 路径：键 / 索引 / 通配', () => {
    const obj = { data: { list: [{ t: 'a' }, { t: 'b' }], total: 2 } };
    assert.deepEqual(evalJsonPath(obj, '$.data.list[*].t'), ['a', 'b']);
    assert.deepEqual(evalJsonPath(obj, '$.data.list[0].t'), ['a']);
    assert.deepEqual(evalJsonPath(obj, '$.data.total'), [2]);
    assert.deepEqual(evalJsonPath(obj, '$.data.list[-1].t'), ['b']);
  });

  test('HTML 默认链式规则 + 净化后缀', () => {
    const $ = cheerio.load(SEARCH_HTML);
    const vals = evalHtmlRule($, $.root(), 'class.intro@text##这是');
    assert.deepEqual(vals, ['简介一', '简介二']);
  });

  test('@css 前缀规则', () => {
    const $ = cheerio.load(SEARCH_HTML);
    const vals = evalHtmlRule($, $.root(), '@css: h4 a@text');
    assert.deepEqual(vals, ['斗破苍穹', '斗罗大陆']);
  });
});

describe('buildSearchRequest', () => {
  test('GET 模板替换 {{key}}', () => {
    const r = buildSearchRequest('https://x.test/search?q={{key}}&p={{page}}', '斗破');
    assert.equal(r.url, 'https://x.test/search?q=' + encodeURIComponent('斗破') + '&p=1');
    assert.equal(r.init.method, 'GET');
  });

  test('POST 带选项尾缀', () => {
    const r = buildSearchRequest('https://x.test/s,{"method":"POST","body":"kw={{key}}","charset":"gbk"}', '斗破');
    assert.equal(r.init.method, 'POST');
    assert.match(r.init.body, /kw=%B6%B7%C6%C6/);
    assert.equal(r.charset, 'gbk');
  });
});

describe('searchBook / fetchToc / fetchContent（mock 网络）', () => {
  test('HTML 书源全流程', async () => {
    const fetchImpl = async (url) => {
      const u = String(url);
      let body;
      if (u.includes('/search')) body = SEARCH_HTML;
      else if (u.includes('.html')) body = CONTENT_HTML;
      else if (u.includes('/book/')) body = TOC_HTML;
      else body = '';
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body, 'utf-8') };
    };

    const { results } = await searchBook(SOURCE, '斗', fetchImpl);
    assert.equal(results.length, 2);
    assert.equal(results[0].name, '斗破苍穹');
    assert.equal(results[0].author, '天蚕土豆');
    assert.ok(results[0].bookUrl.startsWith('https://fake.test/book/1'), '相对链接应绝对化');

    const toc = await fetchToc(SOURCE, 'https://fake.test/book/1', fetchImpl);
    assert.equal(toc.length, 3);
    assert.equal(toc[0].title, '第一章 起点');
    assert.equal(toc[1].url, 'https://fake.test/book/1/2.html');

    const content = await fetchContent(SOURCE, toc[0].url, fetchImpl);
    assert.ok(content.includes('前一段正文。'));
    assert.ok(content.includes('\n'), '<br> 应转换为换行');
    assert.ok(!content.includes('<'), '不应残留 HTML 标签');
  });

  test('JSON API 书源搜索', async () => {
    const jsonSource = validateSource({
      bookSourceName: 'JSON源',
      bookSourceUrl: 'https://api.test',
      searchUrl: 'https://api.test/search?key={{key}}',
      ruleSearch: {
        bookList: '$.data.list',
        name: '$.title', author: '$.author', intro: '$.intro',
        latestChapter: '$.latest', bookUrl: '$.url'
      },
      ruleToc: { chapterList: '$.data.chapters', chapterName: '$.name', chapterUrl: '$.url' },
      ruleContent: { content: '$.data.content' }
    });
    const pages = {
      'https://api.test/search': { data: { list: [{ title: '凡人修仙传', author: '忘语', intro: '简介', latest: '第1章', url: '/book/9' }] } },
      'https://api.test/book/9': { data: { chapters: [{ name: '第一章', url: '/book/9/1' }] } },
      'https://api.test/book/9/1': { data: { content: '正文内容' } }
    };
    const fetchImpl = async (url) => {
      const u = String(url).split('?')[0];
      const body = pages[u] ?? pages[`https://api.test/book/9/${u.split('/').pop()}`] ?? pages[u.replace(/\/\d+$/, '')];
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify(body ?? {}), 'utf-8') };
    };

    const { results } = await searchBook(jsonSource, '凡人', fetchImpl);
    assert.equal(results.length, 1);
    assert.equal(results[0].name, '凡人修仙传');
    assert.equal(results[0].bookUrl, 'https://api.test/book/9');

    const toc = await fetchToc(jsonSource, 'https://api.test/book/9', fetchImpl);
    assert.deepEqual(toc, [{ title: '第一章', url: 'https://api.test/book/9/1' }]);

    const content = await fetchContent(jsonSource, toc[0].url, fetchImpl);
    assert.equal(content, '正文内容');
  });
});

describe('递归 JSON 路径 $..key', () => {
  test('递归键查找与通配组合', () => {
    const obj = { data: { bookList: [{ t: 'a' }, { t: 'b' }], meta: { bookList: [{ t: 'c' }] } } };
    assert.deepEqual(evalJsonPath(obj, '$..bookList[*].t'), ['a', 'b', 'c']);
    assert.deepEqual(evalJsonPath(obj, '$..t'), ['a', 'b', 'c']);
  });
});
