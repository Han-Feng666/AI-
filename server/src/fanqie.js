import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 番茄小说抓取与反混淆
 * - parseBookInputs: 从粘贴文本提取书籍 ID（支持 书籍页链接 / 阅读页链接 / 裸数字 ID）
 * - fetchBookMeta: 抓取书籍页拿书名/作者/章节目录（仅 needPay=0 免费章节可读）
 * - fetchChapterRaw: 抓取阅读页拿章节标题与正文 HTML（SSR __INITIAL_STATE__）
 * - deobfuscate: 私用区字符查表还原 + 清理插图/标签，产出纯文本段落
 *
 * 风控约定：HTTP 200 但空 body（size:0）= 风控限流，可重试；还原率 < 95% 视为映射失效。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = 'https://fanqienovel.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const FETCH_INTERVAL_MS = 250;
export const RETRY_DELAYS = [1000, 3000, 9000];
// 连续空 body 视为风控升级，调用方应暂停队列
export const RISK_LIMIT_STREAK = 50;
// 反混淆还原率下限（私用区字符成功映射比例）
export const DEOBF_MIN_RATIO = 0.95;

export class FanqieError extends Error {
  constructor(message, { code = 'FETCH_FAILED', retryable = false } = {}) {
    super(message);
    this.name = 'FanqieError';
    this.code = code; // RISK_LIMITED | NOT_FOUND | PARSE_FAILED | DEOBF_BROKEN | FETCH_FAILED
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从粘贴文本提取书籍 ID 列表（保持出现顺序、去重）。
 * 支持：https://fanqienovel.com/page/7143038691944959774
 *      https://fanqienovel.com/reader/7143038691944959774_6712474563301913351
 *      裸数字书籍 ID（10~25 位，独占一行或由空白分隔）
 */
export function parseBookInputs(text) {
  const src = String(text || '');
  const ids = [];
  const push = (id) => {
    if (id && !ids.includes(id)) ids.push(id);
  };

  const linkRe = /fanqienovel\.com\/(?:page|reader)\/(\d{10,25})(?:_\d+)?/g;
  let m;
  while ((m = linkRe.exec(src))) push(m[1]);

  // 裸数字 ID：先移除链接部分，避免把链接里的长数字重复算作裸 ID
  // 番茄书籍 ID 为雪花 ID（19 位左右），下限 16 位避免误匹配手机号等短数字
  const rest = src.replace(/https?:\/\/\S+/g, ' ');
  const bareRe = /(?<![\d])(\d{16,25})(?![\d])/g;
  while ((m = bareRe.exec(rest))) push(m[1]);

  return ids.map((id) => ({ bookId: id }));
}

/**
 * 提取 SSR 注入的 __INITIAL_STATE__={...} JSON。
 * 必须用括号配平 + 字符串状态机（正文含大量转义与嵌套，正则不可靠）。
 */
export function extractInitialState(html) {
  const raw = String(html || '');
  const anchor = raw.indexOf('__INITIAL_STATE__=');
  if (anchor < 0) return null;
  const seg = raw.slice(anchor + '__INITIAL_STATE__='.length);

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(seg.slice(0, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchPage(url, referer) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]);
    let resp;
    try {
      resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: referer || `${HOST}/`,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      lastErr = new FanqieError(`网络请求失败: ${e.message}`, { retryable: true });
      continue;
    }
    if (resp.status === 404 || resp.status === 410) {
      throw new FanqieError('页面不存在（书籍可能已下架）', { code: 'NOT_FOUND' });
    }
    if (!resp.ok) {
      lastErr = new FanqieError(`HTTP ${resp.status}`, { retryable: true });
      continue;
    }
    const body = await resp.text();
    // 番茄风控特征：HTTP 200 但空 body
    if (!body || !body.trim()) {
      lastErr = new FanqieError('番茄风控限流（空响应）', { code: 'RISK_LIMITED', retryable: true });
      continue;
    }
    return body;
  }
  throw lastErr || new FanqieError('请求失败');
}

function flatChapters(list) {
  if (!Array.isArray(list)) return [];
  // chapterListWithVolume 可能为扁平章节或按卷嵌套，统一拍平
  return list.flatMap((it) => {
    if (Array.isArray(it)) return flatChapters(it);
    if (it && it.itemId) return [it];
    return [];
  });
}

/** 抓取书籍页，返回书籍元信息与章节目录。
 * 番茄全平台免费（needPay 恒为 0）；isChapterLock 是网页端试读限制——
 * 实测所有书籍网页端统一只开放前 10 章，锁定章节的阅读页仅返回几十字残片。 */
export async function fetchBookMeta(bookId) {
  const html = await fetchPage(`${HOST}/page/${bookId}`);
  const state = extractInitialState(html);
  const page = state && state.page;
  // 实测字段：bookName（书名）、author、description（简介）、wordNumber（字数）
  if (!page || !page.bookName) {
    throw new FanqieError('书籍页解析失败（未找到页面数据）', { code: 'PARSE_FAILED' });
  }
  const chapters = flatChapters(page.chapterListWithVolume).map((c) => ({
    itemId: String(c.itemId),
    title: String(c.title || ''),
    // 网页端锁定章节（含历史付费标记），阅读页只能拿到残片
    locked: Boolean(c.needPay) || Boolean(c.isChapterLock),
  }));
  const readableCount = chapters.filter((c) => !c.locked).length;
  return {
    bookId: String(page.bookId || bookId),
    title: String(page.bookName || ''),
    author: String(page.author || ''),
    intro: String(page.description || page.abstract || ''),
    wordCount: Number(page.wordNumber || 0),
    chapterCount: chapters.length,
    readableCount,
    lockedCount: chapters.length - readableCount,
    chapters,
  };
}

// 网页端可抓取正文的最小长度；低于该值视为锁定/异常残片，不进入语料
export const MIN_CHAPTER_CHARS = 200;

/** 抓取阅读页，返回章节标题与正文 HTML（未反混淆） */
export async function fetchChapterRaw(bookId, itemId) {
  const html = await fetchPage(`${HOST}/reader/${itemId}`, `${HOST}/page/${bookId}`);
  const state = extractInitialState(html);
  const cd = state && state.reader && state.reader.chapterData;
  if (!cd || !cd.content) {
    throw new FanqieError('阅读页解析失败（未找到章节数据）', { code: 'PARSE_FAILED' });
  }
  return { itemId: String(itemId), title: String(cd.title || ''), contentHtml: String(cd.content) };
}

let cachedMap = null;

/** 加载反混淆映射表（进程内缓存） */
export function loadDeobfMap() {
  if (cachedMap) return cachedMap;
  const p = path.join(__dirname, 'data', 'fanqie_deobf_map.json');
  if (!fs.existsSync(p)) return { map: {}, meta: {} };
  cachedMap = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return cachedMap;
}

/** 供测试重置缓存 */
export function resetDeobfMapCache() {
  cachedMap = null;
}

/**
 * 正文 HTML → 纯文本：
 * 1. 段落边界 </p> 转换行；2. 删插图 <img> 与 {{image_domain}} 占位；3. 去剩余标签；
 * 4. HTML 实体反转义；5. 私用区字符查映射表还原。
 * 返回 { text, residual, ratio, unknown }，ratio < DEOBF_MIN_RATIO 视为映射失效。
 */
export function deobfuscate(contentHtml, map) {
  let html = String(contentHtml || '');
  html = html.replace(/<img[^>]*>/gi, '').replace(/\{\{image_domain\}\}/g, '');
  html = html.replace(/<\/p>/gi, '\n');
  html = html.replace(/<br\s*\/?>/gi, '\n');
  html = html.replace(/<[^>]+>/g, '');
  html = html
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

  const lookup = map || {};
  const out = [];
  let puaTotal = 0;
  let puaUnknown = 0;
  const unknown = new Set();
  for (const ch of html) {
    const code = ch.codePointAt(0);
    if (code >= 0xe000 && code <= 0xf8ff) {
      puaTotal++;
      const mapped = lookup[ch] || lookup[hex(code)];
      if (mapped) {
        out.push(mapped);
      } else {
        puaUnknown++;
        unknown.add(hex(code));
        out.push(ch);
      }
    } else {
      out.push(ch);
    }
  }
  const text = out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const ratio = puaTotal === 0 ? 1 : 1 - puaUnknown / puaTotal;
  return { text, residual: puaUnknown, ratio, unknown: [...unknown] };
}

function hex(code) {
  return '0x' + code.toString(16);
}

/** 抓取章节并反混淆；还原率不足时抛 DEOBF_BROKEN */
export async function fetchChapter(bookId, itemId) {
  const raw = await fetchChapterRaw(bookId, itemId);
  const { map, meta } = loadDeobfMap();
  const result = deobfuscate(raw.contentHtml, map);
  if (result.ratio < DEOBF_MIN_RATIO) {
    throw new FanqieError(
      `反混淆还原率 ${(result.ratio * 100).toFixed(1)}% 低于阈值，映射表可能已失效（当前字体: ${meta.source || '未知'}）`,
      { code: 'DEOBF_BROKEN' }
    );
  }
  // 锁定章节的阅读页只返回几十字残片，丢弃并交由调用方跳过
  if (result.text.length < MIN_CHAPTER_CHARS) {
    throw new FanqieError('章节内容过短（网页端锁定章节仅提供试读残片）', { code: 'CHAPTER_LOCKED' });
  }
  return { itemId: raw.itemId, title: raw.title, text: result.text, residual: result.residual };
}

/** 章节间隔等待（队列调用，保持对番茄的访问节奏） */
export async function throttle() {
  await sleep(FETCH_INTERVAL_MS);
}
