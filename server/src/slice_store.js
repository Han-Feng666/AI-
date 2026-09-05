import { db } from './db.js';
import { tokenize, buildTfIdf, cosineSim } from './rag.js';

/**
 * 样本切片库 — 风格库 / 知识库共用的切片存储与检索
 * - sliceText: 按段落聚合切片，超限按 40/30/30 抽样
 * - retrieveFromSlices: TF-IDF 检索 + 场景标签过滤（复用 rag.js 纯函数）
 * - getNovelStyleSnippets / getNovelKnowledgeSnippets: routes 高层封装，含回退
 */

export const SCENE_TAGS = ['对话', '动作/打斗', '心理', '环境', '开篇', '悬念/转折', '日常', '情绪高潮'];

// 场景标签规则预分类（LLM 打标前的兜底）
const TAG_RULES = [
  ['对话', /[""''].{2,}[""']/],
  ['动作/打斗', /一剑|刀光|拳|掌力|砍|刺|杀|爆|轰|撞|砸|冲杀|搏|挥刀|挡|血溅|身形暴退|极速/],
  ['心理', /心想|暗想|心中|念头|思绪|心里|内心|暗道|嘀咕|忐忑|犹豫/],
  ['环境', /天色|月光|阳光|风|雨|雪|山|林|河|城|街道|屋子|房间|空气|气味|夜色|暮色/],
  ['开篇', /^\s*(第[一二三四五六七八九十百千0-9]+[章回节])/],
  ['情绪高潮', /嘶吼|咆哮|泪|哭喊|绝望|狂喜|崩溃|癫狂|嘶喊|痛哭/]
];

export function preClassify(text) {
  const tags = [];
  for (const [tag, re] of TAG_RULES) {
    if (re.test(String(text || ''))) tags.push(tag);
  }
  if (!tags.length) tags.push('日常');
  return tags.slice(0, 3);
}

/**
 * 按段落聚合切片。超出 limit 时按 开头40%/中间30%/结尾30% 抽样。
 */
export function sliceText(text, { minLen = 500, maxLen = 2000, limit = 2000 } = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return [];

  const paragraphs = raw.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const all = [];
  let buf = '';
  for (const p of paragraphs) {
    if (p.length > maxLen) {
      if (buf) { all.push(buf); buf = ''; }
      // 超长段落按 maxLen 硬切
      for (let i = 0; i < p.length; i += maxLen) all.push(p.slice(i, i + maxLen));
      continue;
    }
    if (buf.length + p.length + 1 > maxLen) {
      all.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  if (buf) all.push(buf);

  let slices = all.filter((s) => s.length >= minLen || (s.length >= 100 && all.length <= 3));
  if (slices.length <= limit) {
    return slices.map((t, i) => ({ slice_index: i, text: t }));
  }

  // 抽样：开头 40% / 中间 30% / 结尾 30%
  const take = limit;
  const head = Math.floor(take * 0.4);
  const mid = Math.floor(take * 0.3);
  const tail = take - head - mid;
  const headEnd = Math.floor(slices.length * 0.4);
  const tailStart = Math.floor(slices.length * 0.7);
  const picked = [
    ...slices.slice(0, Math.min(head, headEnd)),
    ...(headEnd < tailStart
      ? slices.slice(headEnd, tailStart).filter((_, i) => i % Math.max(1, Math.floor((tailStart - headEnd) / Math.max(mid, 1))) === 0).slice(0, mid)
      : []),
    ...slices.slice(Math.max(tailStart, headEnd)).slice(-tail)
  ];
  slices = picked.slice(0, limit);
  return slices.map((t, i) => ({ slice_index: i, text: t }));
}

export function extractKeywords(text, n = 10) {
  const tokens = tokenize(text);
  const freq = new Map();
  for (const t of tokens) {
    if (t.length === 2) freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]).join(' ');
}

export function saveStyleSlices(styleId, slices) {
  db.prepare('DELETE FROM style_slices WHERE style_id = ?').run(styleId);
  const ins = db.prepare('INSERT INTO style_slices (style_id, slice_index, text, scene_tags, keywords) VALUES (?,?,?,?,?)');
  // 使用 exec 包裹事务，确保数据完整性
  db.exec('BEGIN');
  try {
    for (const s of slices) {
      ins.run(styleId, s.slice_index, s.text, JSON.stringify(s.scene_tags || preClassify(s.text)), extractKeywords(s.text));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return slices.length;
}

export function getStyleSlices(styleId) {
  return db.prepare('SELECT id, slice_index, text, scene_tags, keywords FROM style_slices WHERE style_id = ? ORDER BY slice_index').all(styleId);
}

// 检索索引缓存：key -> { index, docs, count }
const _sliceIndexCache = new Map();

function buildSliceIndex(rows) {
  const docs = rows.map((r) => ({ id: r.id, text: r.text + ' ' + (r.keywords || ''), row: r }));
  const index = buildTfIdf(docs.map(({ id, text }) => ({ id, text })));
  return { index, docs, count: rows.length };
}

function getCachedSliceIndex(cacheKey, loadRows) {
  const rows = loadRows();
  const cached = _sliceIndexCache.get(cacheKey);
  if (cached && cached.count === rows.length) return cached;
  if (_sliceIndexCache.size > 50) _sliceIndexCache.clear();
  const built = buildSliceIndex(rows);
  _sliceIndexCache.set(cacheKey, built);
  return built;
}

/**
 * 从切片表中检索与 query 最相关的片段。
 * @param {string} table 'style_slices' | 'knowledge_samples'
 * @param {number[]} ownerIds style_id 或 corpus_id 列表
 * @param {string} query 检索查询串
 * @param {object} opts { topK, maxChars, sceneTags }
 */
export function retrieveFromSlices(table, ownerIds, query, { topK = 4, maxChars = 3000, sceneTags = null } = {}) {
  if (!ownerIds?.length) return [];
  const idList = [...new Set(ownerIds.map(Number).filter(Boolean))];
  if (!idList.length) return [];

  const placeholders = idList.map(() => '?').join(',');
  const isStyle = table === 'style_slices';
  const ownerCol = isStyle ? 'style_id' : 'corpus_id';
  // 两张表的切片序号列名不同：style_slices.slice_index / knowledge_samples.chunk_index，统一别名为 slice_index
  const idxCol = isStyle ? 'slice_index' : 'chunk_index';
  const loadRows = () => db.prepare(
    `SELECT id, ${idxCol} AS slice_index, text, scene_tags, keywords FROM ${table} WHERE ${ownerCol} IN (${placeholders}) ORDER BY id`
  ).all(...idList);

  const cacheKey = `${table}:${idList.slice().sort((a, b) => a - b).join(',')}`;
  let built;
  try {
    built = getCachedSliceIndex(cacheKey, loadRows);
  } catch {
    return [];
  }
  if (!built?.index || !built.docs.length) return [];

  const { index, docs } = built;
  const docById = new Map(docs.map((d) => [d.id, d]));

  const scored = (rows) => {
    const idx = buildTfIdf(rows.map((r) => ({ id: r.id, text: r.text + ' ' + (r.keywords || '') })));
    if (!idx) return [];
    const qTokens = tokenize(query);
    if (!qTokens.length) return [];
    const qTf = new Map();
    for (const t of qTokens) qTf.set(t, (qTf.get(t) || 0) + 1);
    const qVec = new Map();
    let qNorm = 0;
    for (const [t, f] of qTf) {
      const w = (f / qTokens.length) * (idx.idf.get(t) || 0);
      qVec.set(t, w);
      qNorm += w * w;
    }
    qNorm = Math.sqrt(qNorm) || 1;
    for (const [t, w] of qVec) qVec.set(t, w / qNorm);
    return idx.vectors
      .map((v) => ({ id: v.id, score: cosineSim(qVec, v.vec) }))
      .filter((s) => s.score > 0.01)
      .sort((a, b) => b.score - a.score);
  };

  // 场景标签过滤优先，不足 topK 用全量补齐
  let ranked = [];
  if (Array.isArray(sceneTags) && sceneTags.length) {
    const filtered = loadRows().filter((r) => {
      try {
        const tags = JSON.parse(r.scene_tags || '[]');
        return tags.some((t) => sceneTags.includes(t));
      } catch { return false; }
    });
    ranked = scored(filtered.slice(0, 2000));
  }
  if (ranked.length < topK) {
    const seen = new Set(ranked.map((r) => r.id));
    const allDocs = built.docs.map((d) => d.row);
    for (const s of scored(allDocs.slice(0, 5000))) {
      if (ranked.length >= topK) break;
      if (!seen.has(s.id)) { ranked.push(s); seen.add(s.id); }
    }
  }

  // 组装结果，按 maxChars 截断（首条超长时硬截到 maxChars）
  const result = [];
  let total = 0;
  for (const s of ranked) {
    const doc = docById.get(s.id);
    if (!doc) continue;
    const text = doc.row.text;
    const room = maxChars - total;
    if (room <= 0) break;
    const slice = { slice_index: doc.row.slice_index, text: text.slice(0, room), score: s.score };
    try { slice.scene_tags = JSON.parse(doc.row.scene_tags || '[]'); } catch { slice.scene_tags = []; }
    result.push(slice);
    total += slice.text.length;
    if (total >= maxChars) break;
  }
  // 兜底：检索无命中时按顺序取前 topK 片
  if (!result.length) {
    const rows = loadRows().slice(0, topK);
    let t2 = 0;
    for (const r of rows) {
      if (t2 + r.text.length > maxChars) break;
      let tags = [];
      try { tags = JSON.parse(r.scene_tags || '[]'); } catch {}
      result.push({ slice_index: r.slice_index, text: r.text, scene_tags: tags, score: 0 });
      t2 += r.text.length;
    }
  }
  return result;
}

/**
 * 章节生成用：风格范文动态召回。空结果返回 ''，由调用方回退到固定样本注入。
 */
export function getNovelStyleSnippets(styleIds, query, opts = {}) {
  const slices = retrieveFromSlices('style_slices', styleIds, query, { topK: 4, maxChars: 3000, ...opts });
  if (!slices.length) return { snippets: '', slices: [] };
  const snippets = slices
    .map((s, i) => `[范文${i + 1}]${s.scene_tags?.length ? `（${s.scene_tags.join('/')}）` : ''}\n${s.text}`)
    .join('\n\n');
  return { snippets, slices };
}

/**
 * 章节生成用：知识库参考片段动态召回。空结果返回 ''，由调用方回退固定取样。
 */
export function getNovelKnowledgeSnippets(corpusIds, query, opts = {}) {
  const slices = retrieveFromSlices('knowledge_samples', corpusIds, query, { topK: 5, maxChars: 4000, ...opts });
  if (!slices.length) return { snippets: '', slices: [] };
  return { snippets: slices.map((s) => s.text).join('\n\n---\n\n'), slices };
}
