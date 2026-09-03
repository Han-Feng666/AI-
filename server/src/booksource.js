import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';

/**
 * Legado（阅读 3.0）书源兼容引擎（常用规则子集）
 * - parseSourceBatch: 宽松解析书源 JSON（对象或数组），逐条校验必填字段
 * - searchBook: 按 searchUrl 模板搜索并按 ruleSearch 解析结果
 * - fetchBookInfo / fetchToc / fetchContent: 详情 / 目录 / 正文抓取
 *
 * 支持的规则语法：@css 选择器、默认链式规则（class./tag./id. + @text/@href）、
 * JSON 路径（$.a.b[*].c）、##正则#替换 净化、|| 备选、&& 合并；
 * 不支持 JS 引擎（<js>/{{java.}}）与 XPath（导入时标记 partial，求值为空）。
 */

export const SOURCE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const REQ_TIMEOUT_MS = 15000;
export const FETCH_INTERVAL_MS = 250;
// nextTocUrl / nextContentUrl 翻页上限，防止规则异常导致死循环
export const PAGE_LIMIT = 50;

export class BookSourceError extends Error {
  constructor(message, { code = 'FETCH_FAILED', retryable = false } = {}) {
    super(message);
    this.name = 'BookSourceError';
    this.code = code; // HTTP_ERROR | PARSE_FAILED | UNSUPPORTED | TIMEOUT
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 书源解析与校验
// ---------------------------------------------------------------------------

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function detectUnsupported(rulesLike) {
  const s = JSON.stringify(rulesLike) || '';
  const marks = [];
  if (/<js>|\{\{java\./i.test(s)) marks.push('含 JS 规则（<js>/{{java.}}），相关字段可能为空');
  if (/@XPath:/i.test(s)) marks.push('含 XPath 规则，相关字段可能为空');
  return marks;
}

export function validateSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('书源条目必须是 JSON 对象');
  }
  for (const f of ['bookSourceUrl', 'searchUrl']) {
    if (!raw[f] || typeof raw[f] !== 'string') {
      throw new Error(`缺少必填字段 ${f}（Legado 格式：bookSourceName/bookSourceUrl/searchUrl/ruleSearch/ruleToc/ruleContent）`);
    }
  }
  for (const f of ['ruleSearch', 'ruleToc', 'ruleContent']) {
    if (!raw[f] || typeof raw[f] !== 'object' || Array.isArray(raw[f])) {
      throw new Error(`缺少必填字段 ${f}（Legado 格式：bookSourceName/bookSourceUrl/searchUrl/ruleSearch/ruleToc/ruleContent）`);
    }
  }
  return {
    name: String(raw.bookSourceName || hostOf(raw.bookSourceUrl) || '未命名书源'),
    sourceUrl: raw.bookSourceUrl.trim(),
    searchUrl: raw.searchUrl.trim(),
    rules: {
      ruleSearch: raw.ruleSearch || {},
      ruleBookInfo: raw.ruleBookInfo || {},
      ruleToc: raw.ruleToc || {},
      ruleContent: raw.ruleContent || {}
    },
    partial: detectUnsupported([raw.searchUrl, raw.ruleSearch, raw.ruleBookInfo, raw.ruleToc, raw.ruleContent])
  };
}

/** 宽松解析粘贴的书源 JSON 文本，返回逐条成功/失败明细 */
export function parseSourceBatch(text) {
  const items = [];
  const errors = [];
  let data;
  try {
    data = JSON.parse(String(text || ''));
  } catch (e) {
    return { items, errors: [{ index: 1, message: `JSON 解析失败: ${e.message}` }] };
  }
  const arr = Array.isArray(data) ? data : [data];
  arr.forEach((raw, i) => {
    try {
      items.push(validateSource(raw));
    } catch (e) {
      errors.push({ index: i + 1, message: e instanceof Error ? e.message : String(e) });
    }
  });
  return { items, errors };
}

// ---------------------------------------------------------------------------
// 规则求值
// ---------------------------------------------------------------------------

/** 拆出净化后缀：rule##正则##替换 -> { main, purify } */
function splitPurify(rule) {
  const s = String(rule || '');
  const i = s.indexOf('##');
  if (i < 0) return { main: s, purify: null };
  const parts = s.slice(i + 2).split('##');
  return { main: s.slice(0, i), purify: { re: parts[0] || '', rep: parts[1] ?? '' } };
}

function applyPurify(text, purify, multiline = false) {
  if (!purify || !purify.re) return text;
  try {
    return text.replace(new RegExp(purify.re, multiline ? 'gm' : 'g'), purify.rep);
  } catch {
    return text;
  }
}

/** JSON 路径求值：$.a.b[*].c -> 数组（单值也在数组中） */
export function evalJsonPath(root, path) {
  const norm = String(path || '').trim().replace(/^\$\.?/, '');
  if (!norm) return [root];
  const tokens = [];
  for (const seg of norm.split('.')) {
    const m = seg.match(/^([^\[\]]*)((?:\[[^\]]*\])*)$/);
    if (!m) return [];
    if (m[1]) tokens.push({ key: m[1] });
    for (const ix of m[2].match(/\[([^\]]*)\]/g) || []) {
      tokens.push({ index: ix.slice(1, -1) });
    }
  }

  let items = [root];
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];
    const isLast = ti === tokens.length - 1;
    const next = [];
    for (const it of items) {
      if (it == null) continue;
      if ('key' in tok) {
        // 数组形态保持整体（由后续索引/通配 token 处理），isLast 时原样返回
        const v = Array.isArray(it) ? it.map((x) => (x == null ? undefined : x[tok.key])) : it[tok.key];
        next.push(v);
      } else if (tok.index === '*' || tok.index === '') {
        if (Array.isArray(it)) next.push(...it);
      } else {
        const arr = Array.isArray(it) ? it : null;
        if (!arr) continue;
        const i = parseInt(tok.index, 10);
        if (!Number.isNaN(i)) next.push(i < 0 ? arr[arr.length + i] : arr[i]);
      }
    }
    items = next;
  }
  return items;
}

const VALUATORS = new Set(['text', 'html', 'all', 'textnodes', 'owntext', 'content']);
const COMMON_ATTRS = new Set([
  'href', 'src', 'value', 'alt', 'title', 'data-src', 'data-original', 'data-url', 'content'
]);

/** 默认链式规则单段 -> CSS 选择器或取值器 */
function segToSelector(seg) {
  const low = seg.toLowerCase();
  if (VALUATORS.has(low)) return { type: 'val', val: low };
  if (COMMON_ATTRS.has(low)) return { type: 'attr', attr: low };
  if (seg.includes('=')) {
    const i = seg.indexOf('=');
    return { type: 'attr', attr: seg.slice(0, i).trim() };
  }
  const m = seg.match(/^(class|tag|id)\.([^.\s]+)(?:\.(-?\d+))?$/);
  if (m) {
    const [, kind, name, idx] = m;
    const css = kind === 'class' ? `.${name}` : kind === 'id' ? `#${name}` : name;
    return { type: 'css', css, idx: idx ? parseInt(idx, 10) : null };
  }
  // 裸段：含选择器特征按 CSS 处理，否则视为属性名
  if (/[.\s#[>:]/.test(seg) || /^[a-z][a-z0-9-]*$/i.test(seg)) return { type: 'css', css: seg, idx: null };
  return { type: 'attr', attr: seg };
}

/**
 * 应用选择器链，返回 { nodes, valuator, attr }。
 * valuator/attr 为规则末尾的取值器（@text/@href/...），缺省由调用方决定默认取值。
 */
function applySelectorChain($, ctx, rule) {
  let r = String(rule || '').trim();
  if (r.startsWith('@css:')) r = r.slice(5).trim();
  if (!r) return { nodes: $(ctx), valuator: null, attr: null };

  const segs = r.split('@').map((s) => s.trim()).filter(Boolean);
  let nodes = $(ctx);
  let valuator = null;
  let attr = null;
  for (const seg of segs) {
    const sel = segToSelector(seg);
    if (sel.type === 'val') {
      valuator = sel.val;
      break;
    }
    if (sel.type === 'attr') {
      attr = sel.attr;
      break;
    }
    let next = nodes.find(sel.css);
    if (sel.idx != null) next = next.eq(sel.idx < 0 ? next.length + sel.idx : sel.idx);
    if (!next.length) return { nodes: next, valuator: null, attr: null };
    nodes = next;
  }
  return { nodes, valuator, attr };
}

/** HTML 上下文求值（默认链式或 @css: 前缀），返回字符串数组 */
export function evalHtmlRule($, ctx, rule) {
  const { main, purify } = splitPurify(rule);
  const { nodes, valuator, attr } = applySelectorChain($, ctx, main);
  if (!nodes.length) return [];
  let vals;
  if (attr) vals = nodes.toArray().map((el) => ($(el).attr(attr) || '').trim());
  else if (valuator === 'html') vals = nodes.toArray().map((el) => $(el).html() || '');
  else if (valuator === 'all') vals = nodes.toArray().map((el) => $.html(el) || '');
  else vals = nodes.toArray().map((el) => $(el).text().trim());
  return purify ? vals.map((v) => applyPurify(v, purify).trim()) : vals;
}

/** HTML 列表规则求值：返回元素集合（保持节点上下文供字段规则继续求值） */
function evalHtmlList($, ctx, rule) {
  const { nodes } = applySelectorChain($, ctx, rule);
  return nodes.toArray();
}

/** 在响应上下文中求值单条规则（已含 ||/&& 组合与净化），返回字符串数组 */
function evalRuleParts(rule, ctx) {
  const branches = String(rule || '').split('||').map((b) => b.trim()).filter(Boolean);
  for (const branch of branches) {
    const out = [];
    for (const part of branch.split('&&').map((p) => p.trim()).filter(Boolean)) {
      const { main, purify } = splitPurify(part);
      let vals;
      if (ctx.kind === 'json') vals = evalJsonPath(ctx.json, main);
      else vals = evalHtmlRule(ctx.$, ctx.nodes, main);
      for (const v of vals) {
        if (v == null) continue;
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        if (s.trim()) out.push(applyPurify(s, purify).trim());
      }
    }
    if (out.length) return out;
  }
  return [];
}

/** 字段求值：||/&& 合并后的首个非空字符串 */
function evalField(rule, ctx) {
  if (!rule) return '';
  const vals = evalRuleParts(rule, ctx);
  return vals.length ? vals[0] : '';
}

// ---------------------------------------------------------------------------
// searchUrl 模板与请求
// ---------------------------------------------------------------------------

function pctEncodeGbk(kw) {
  return Array.from(iconv.encode(kw, 'gbk'), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}

/** 解析 Legado searchUrl 模板 -> { url, init, charset } */
export function buildSearchRequest(tpl, keyword) {
  let raw = String(tpl || '').trim();
  let opts = {};
  const m = raw.match(/^(\S+?)\s*,\s*(\{[\s\S]+\})$/);
  if (m) {
    raw = m[1];
    try {
      opts = JSON.parse(m[2]);
    } catch {
      opts = {};
    }
  }
  const charset = String(opts.charset || 'utf-8').toLowerCase();
  const enc = (kw) => (charset.startsWith('gb') ? pctEncodeGbk(kw) : encodeURIComponent(kw));
  const url = raw.replaceAll('{{key}}', enc(keyword)).replaceAll(/\{\{page\}\}/g, '1');

  const init = { method: String(opts.method || 'GET').toUpperCase(), headers: { ...(opts.headers || {}) } };
  if (init.method === 'POST') {
    let body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? {});
    body = body.replaceAll('{{key}}', enc(keyword));
    init.body = body;
    if (!init.headers['Content-Type'] && !body.trim().startsWith('{')) {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  return { url, init, charset };
}

function decodeBody(buf, charset) {
  if (charset.startsWith('gb')) {
    try {
      return new TextDecoder(charset === 'gbk' ? 'gbk' : charset).decode(buf);
    } catch {
      /* fallthrough */
    }
  }
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

const lastHitByHost = new Map();

async function throttleHost(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const last = lastHitByHost.get(host) || 0;
  const wait = last + FETCH_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHitByHost.set(host, Date.now());
}

async function requestPage(url, init, charset, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const doFetch = fetchImpl || fetch;
    const res = await doFetch(url, {
      method: init.method || 'GET',
      body: init.body,
      headers: { 'User-Agent': SOURCE_UA, ...(init.headers || {}) },
      signal: ctrl.signal
    });
    if (!res.ok) throw new BookSourceError(`站点返回 HTTP ${res.status}`, { code: 'HTTP_ERROR' });
    const buf = Buffer.from(await res.arrayBuffer());
    return decodeBody(buf, charset);
  } catch (e) {
    if (e instanceof BookSourceError) throw e;
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
      throw new BookSourceError('站点请求超时', { code: 'TIMEOUT' });
    }
    throw new BookSourceError(`站点请求失败: ${e instanceof Error ? e.message : String(e)}`, { code: 'FETCH_FAILED' });
  } finally {
    clearTimeout(timer);
  }
}

/** 响应自动识别 JSON / HTML 上下文 */
function parseResponse(text) {
  const t = text.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return { kind: 'json', json: JSON.parse(t) };
    } catch {
      /* fallthrough to html */
    }
  }
  return { kind: 'html', $: cheerio.load(text) };
}

function rootCtx(parsed) {
  return parsed.kind === 'json'
    ? { kind: 'json', json: parsed.json }
    : { kind: 'html', $: parsed.$, nodes: parsed.$.root() };
}

function itemCtx(parsed, item) {
  return parsed.kind === 'json'
    ? { kind: 'json', json: item }
    : { kind: 'html', $: parsed.$, nodes: parsed.$(item) };
}

function evalList(listRule, parsed) {
  if (!listRule) return [];
  const ctx = rootCtx(parsed);
  const branches = String(listRule || '').split('||').map((b) => b.trim()).filter(Boolean);
  for (const branch of branches) {
    const main = splitPurify(branch.split('&&')[0].trim()).main;
    if (ctx.kind === 'json') {
      // 列表元素保持对象形态（evalRuleParts 会字符串化，列表不适用）
      const vals = evalJsonPath(ctx.json, main).flat();
      const objs = vals.filter((v) => v != null && typeof v === 'object');
      if (objs.length) return objs;
    } else {
      const items = evalHtmlList(ctx.$, ctx.nodes, main);
      if (items.length) return items;
    }
  }
  return [];
}

function resolveUrl(u, base) {
  try {
    return new URL(u, base).href;
  } catch {
    return u;
  }
}

// ---------------------------------------------------------------------------
// 对外操作：搜索 / 详情 / 目录 / 正文
// ---------------------------------------------------------------------------

/** 按书源搜索，返回 { name, author, latest, intro, bookUrl } 列表 */
export async function searchBook(source, keyword, fetchImpl) {
  const { url, init, charset } = buildSearchRequest(source.searchUrl, keyword);
  const text = await requestPage(url, init, charset, fetchImpl);
  const parsed = parseResponse(text);
  const rs = source.rules.ruleSearch;
  const list = evalList(rs.bookList, parsed);
  if (!list.length) {
    throw new BookSourceError('搜索结果解析为空（书源规则可能不兼容）', { code: 'PARSE_FAILED' });
  }
  const results = [];
  for (const item of list) {
    const ctx = itemCtx(parsed, item);
    const name = evalField(rs.name, ctx);
    const bookUrl = evalField(rs.bookUrl, ctx);
    if (!name || !bookUrl) continue;
    results.push({
      name: name.trim(),
      author: evalField(rs.author, ctx).trim(),
      latest: evalField(rs.latestChapter || rs.kind || '', ctx).trim(),
      intro: evalField(rs.intro, ctx).trim(),
      bookUrl: resolveUrl(bookUrl, url)
    });
  }
  if (!results.length) {
    throw new BookSourceError('搜索结果解析为空（书源规则可能不兼容）', { code: 'PARSE_FAILED' });
  }
  return { results };
}

/** 详情页补充信息（可选，失败返回空对象） */
export async function fetchBookInfo(source, bookUrl, fetchImpl) {
  const rb = source.rules.ruleBookInfo || {};
  if (!rb.name && !rb.author && !rb.intro) return {};
  try {
    await throttleHost(bookUrl);
    const text = await requestPage(bookUrl, { method: 'GET' }, 'utf-8', fetchImpl);
    const parsed = parseResponse(text);
    const ctx = rootCtx(parsed);
    return {
      title: evalField(rb.name, ctx).trim(),
      author: evalField(rb.author, ctx).trim(),
      intro: evalField(rb.intro, ctx).trim()
    };
  } catch {
    return {};
  }
}

function cleanContent(raw) {
  let s = String(raw || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  // 实体解码（&nbsp; &amp; 等）
  try {
    s = cheerio.load(`<div>${s}</div>`)('div').text();
  } catch {
    /* keep as-is */
  }
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 抓取目录（含 nextTocUrl 分页），返回 [{ title, url }] */
export async function fetchToc(source, bookUrl, fetchImpl) {
  const rt = source.rules.ruleToc;
  const nameRule = rt.chapterName || rt.name;
  const urlRule = rt.chapterUrl || rt.url;
  const chapters = [];
  const seen = new Set();
  let url = bookUrl;
  let pages = 0;
  while (url && pages < PAGE_LIMIT && !seen.has(url)) {
    seen.add(url);
    pages++;
    await throttleHost(url);
    const text = await requestPage(url, { method: 'GET' }, 'utf-8', fetchImpl);
    const parsed = parseResponse(text);
    const list = evalList(rt.chapterList, parsed);
    for (const item of list) {
      const ctx = itemCtx(parsed, item);
      const title = evalField(nameRule, ctx);
      const cu = evalField(urlRule, ctx);
      if (title && cu) chapters.push({ title: title.trim(), url: resolveUrl(cu, url) });
    }
    if (rt.nextTocUrl) {
      const nxt = evalField(rt.nextTocUrl, rootCtx(parsed));
      url = nxt ? resolveUrl(nxt, url) : '';
    } else {
      url = '';
    }
  }
  if (!chapters.length) {
    throw new BookSourceError('目录解析为空（书源规则可能不兼容）', { code: 'PARSE_FAILED' });
  }
  return chapters;
}

/** 抓取单章正文（含 nextContentUrl 翻页），返回纯文本 */
export async function fetchContent(source, chapterUrl, fetchImpl) {
  const rc = source.rules.ruleContent || {};
  if (!rc.content) throw new BookSourceError('书源缺少正文规则 ruleContent.content', { code: 'UNSUPPORTED' });
  const parts = [];
  const seen = new Set();
  let url = chapterUrl;
  let pages = 0;
  while (url && pages < PAGE_LIMIT && !seen.has(url)) {
    seen.add(url);
    pages++;
    await throttleHost(url);
    const text = await requestPage(url, { method: 'GET' }, 'utf-8', fetchImpl);
    const parsed = parseResponse(text);
    const { main, purify } = splitPurify(rc.content);
    let raw;
    if (parsed.kind === 'json') {
      raw = (evalJsonPath(parsed.json, main)[0] ?? '').toString();
    } else {
      const vals = evalHtmlRule(parsed.$, parsed.$.root(), main);
      raw = vals.join('\n');
    }
    if (purify) raw = applyPurify(raw, purify, true);
    const cleaned = cleanContent(raw);
    if (cleaned) parts.push(cleaned);
    if (rc.nextContentUrl) {
      const nxt = evalField(rc.nextContentUrl, rootCtx(parsed));
      url = nxt ? resolveUrl(nxt, url) : '';
    } else {
      url = '';
    }
  }
  const body = parts.join('\n\n').trim();
  if (!body) {
    throw new BookSourceError('正文解析为空（书源规则可能不兼容）', { code: 'PARSE_FAILED' });
  }
  return body;
}
