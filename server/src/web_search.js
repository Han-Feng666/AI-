import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

const DEFAULT_TIMEOUT = 10000;

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: opts.headers || {},
      timeout: opts.timeout || DEFAULT_TIMEOUT,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetch(res.headers.location, opts));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchJson(url, opts = {}) {
  return fetch(url, opts).then((body) => JSON.parse(body));
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeta(html) {
  const getMeta = (name) => {
    const m = html.match(new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'));
    return m ? m[1] : '';
  };
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return {
    title: titleMatch ? titleMatch[1].trim() : '',
    description: getMeta('description') || getMeta('og:description'),
  };
}

function extractMainText(html, maxLen = 2000) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const cleaned = stripHtml(body);
  return cleaned.slice(0, maxLen);
}

async function searchDuckDuckGo(query, count = 8) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const body = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
  });
  const results = [];
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  let m;
  while ((m = linkRegex.exec(body)) !== null) links.push({ url: m[1], title: stripHtml(m[2]) });
  const snippets = [];
  while ((m = snippetRegex.exec(body)) !== null) snippets.push(stripHtml(m[1]));
  for (let i = 0; i < Math.min(count, links.length); i++) {
    let rawUrl = links[i].url;
    if (rawUrl.includes('duckduckgo.com/l/?uddg=')) {
      const u = new URL(rawUrl);
      rawUrl = u.searchParams.get('uddg') || rawUrl;
    }
    results.push({
      title: links[i].title || '',
      url: rawUrl,
      snippet: snippets[i] || '',
    });
  }
  return results;
}

async function searchSearxng(query, baseUrl, count = 8) {
  const url = `${baseUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
  const body = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  const data = JSON.parse(body);
  const results = (data.results || []).slice(0, count).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
  }));
  return results;
}

async function searchBingApi(query, apiKey, endpoint, count = 8) {
  const url = `${endpoint || 'https://api.bing.microsoft.com/v7.0/search'}?q=${encodeURIComponent(query)}&count=${count}`;
  const data = await fetchJson(url, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
  });
  const results = (data.webPages?.value || []).map((r) => ({
    title: r.name || '',
    url: r.url || '',
    snippet: r.snippet || '',
  }));
  return results;
}

async function fetchPageContent(url, maxLen = 3000) {
  try {
    const html = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
      timeout: 8000,
    });
    const meta = extractMeta(html);
    const text = extractMainText(html, maxLen);
    return { title: meta.title, description: meta.description, content: text };
  } catch {
    return { title: '', description: '', content: '' };
  }
}

export async function webSearch(query, opts = {}) {
  const engine = opts.engine || 'duckduckgo';
  const count = Math.min(opts.count || 8, 10);
  const fetchContent = opts.fetchContent !== false;
  try {
    let results = [];
    if (engine === 'searxng' && opts.searxUrl) {
      results = await searchSearxng(query, opts.searxUrl, count);
    } else if (engine === 'bing' && opts.bingApiKey) {
      results = await searchBingApi(query, opts.bingApiKey, opts.bingEndpoint, count);
    } else {
      results = await searchDuckDuckGo(query, count);
    }
    if (fetchContent && results.length > 0) {
      const top = results.slice(0, 3);
      const contents = await Promise.all(top.map((r) => fetchPageContent(r.url)));
      top.forEach((r, i) => {
        r.fetchedTitle = contents[i].title;
        r.fetchedContent = contents[i].content;
        r.description = r.description || contents[i].description;
      });
    }
    return { query, engine, results };
  } catch (e) {
    return { query, engine, results: [], error: e.message };
  }
}

export function formatSearchResults(searchData) {
  if (!searchData || !searchData.results || !searchData.results.length) {
    return '搜索未返回结果。';
  }
  const lines = [`搜索关键词：${searchData.query}`, `搜索引擎：${searchData.engine}`, ''];
  searchData.results.forEach((r, i) => {
    lines.push(`【结果 ${i + 1}】${r.title || '(无标题)'}`);
    if (r.url) lines.push(`链接：${r.url}`);
    if (r.snippet) lines.push(`摘要：${r.snippet}`);
    if (r.fetchedContent) lines.push(`正文摘录：${r.fetchedContent.slice(0, 500)}`);
    lines.push('');
  });
  return lines.join('\n');
}

export const SEARCH_SYSTEM_PROMPT = `你拥有联网搜索能力。当用户的问题涉及实时信息、最新新闻、具体事实、技术文档或你不确定的知识时，你可以使用 web_search 工具搜索互联网获取最新信息。

搜索建议：
- 在搜索前先判断问题是否需要联网——如果是小说创作建议、剧情构思等创意性问题，不需要搜索
- 搜索关键词要精炼，用核心词而非整句
- 搜索结果可能不完全准确，需交叉验证
- 引用搜索结果时标注来源`;
