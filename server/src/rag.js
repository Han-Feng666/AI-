import { db } from './db.js';

// ====================================================================
// P0-2: 向量检索 RAG — 纯 JS TF-IDF + 余弦相似度
// 不依赖 embedding API，适用于 500 章以内 (4000 chunks) 的检索
// ====================================================================

// 中文 2-gram 分词
function tokenize(text) {
  const clean = String(text || '').replace(/\s+/g, '');
  const tokens = [];
  for (let i = 0; i < clean.length - 1; i++) {
    tokens.push(clean.slice(i, i + 2));
  }
  // 也加入单字
  for (const ch of clean) tokens.push(ch);
  return tokens;
}

// 构建 TF-IDF 向量
function buildTfIdf(docs) {
  // docs: [{id, text}]
  const N = docs.length;
  if (!N) return null;

  // 文档频率
  const df = new Map();
  for (const doc of docs) {
    const tokens = new Set(tokenize(doc.text));
    for (const t of tokens) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }

  // IDF
  const idf = new Map();
  for (const [t, count] of df) {
    idf.set(t, Math.log((N + 1) / (count + 1)) + 1);
  }

  // 每个文档的 TF-IDF 向量
  const vectors = docs.map((doc) => {
    const tokens = tokenize(doc.text);
    const tf = new Map();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    const vec = new Map();
    let norm = 0;
    for (const [t, freq] of tf) {
      const weight = (freq / tokens.length) * (idf.get(t) || 0);
      vec.set(t, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    // 归一化
    for (const [t, w] of vec) {
      vec.set(t, w / norm);
    }
    return { id: doc.id, vec, norm };
  });

  return { idf, vectors, N };
}

// 余弦相似度
function cosineSim(queryVec, docVec) {
  let dot = 0;
  for (const [t, q] of queryVec) {
    const d = docVec.get(t);
    if (d) dot += q * d;
  }
  return dot; // 已归一化
}

// 分章为 chunks（按段落，每块约 500 字）
export function chunkChapter(novelId, chapterIdx, content) {
  const text = String(content || '');
  if (!text) return [];
  const paragraphs = text.split(/\n+/).filter((p) => p.trim().length > 50);
  const chunks = [];
  let buf = '';
  let chunkIdx = 0;
  for (const p of paragraphs) {
    if (buf.length + p.length > 600) {
      if (buf) {
        chunks.push({ novel_id: novelId, chapter_index: chapterIdx, chunk_index: chunkIdx++, text: buf });
        buf = p;
      } else {
        chunks.push({ novel_id: novelId, chapter_index: chapterIdx, chunk_index: chunkIdx++, text: p });
      }
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  if (buf) chunks.push({ novel_id: novelId, chapter_index: chapterIdx, chunk_index: chunkIdx++, text: buf });
  return chunks;
}

// 存储章节 chunks 到 DB
export function storeChunks(novelId, chapterIdx, content) {
  // 先删旧 chunks
  db.prepare('DELETE FROM chapter_chunks WHERE novel_id = ? AND chapter_index = ?').run(novelId, chapterIdx);
  // 失效缓存（章节被修改）
  invalidateIndex(novelId);
  const chunks = chunkChapter(novelId, chapterIdx, content);
  const ins = db.prepare('INSERT INTO chapter_chunks (novel_id, chapter_index, chunk_index, text, keywords) VALUES (?,?,?,?,?)');
  // 提取关键词（高频 2-gram）
  for (const c of chunks) {
    const tokens = tokenize(c.text);
    const freq = new Map();
    for (const t of tokens) {
      if (t.length === 2) freq.set(t, (freq.get(t) || 0) + 1);
    }
    const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map((e) => e[0]).join(' ');
    ins.run(c.novel_id, c.chapter_index, c.chunk_index, c.text, keywords);
  }
  return chunks.length;
}

// 检索与 query 最相关的 top-K chunks
export function retrieveRelevant(novelId, query, topK = 5, beforeIndex = null) {
  const rows = beforeIndex !== null
    ? db.prepare('SELECT id, chapter_index, chunk_index, text, keywords FROM chapter_chunks WHERE novel_id = ? AND chapter_index < ? ORDER BY chapter_index, chunk_index').all(novelId, beforeIndex)
    : db.prepare('SELECT id, chapter_index, chunk_index, text, keywords FROM chapter_chunks WHERE novel_id = ? ORDER BY chapter_index, chunk_index').all(novelId);
  if (!rows.length || !query) return [];

  const docs = rows.map((r) => ({ id: r.id, text: r.text + ' ' + (r.keywords || '') }));
  const index = buildTfIdf(docs);
  if (!index) return [];

  // 构建 query 向量
  const qTokens = tokenize(query);
  const qTf = new Map();
  for (const t of qTokens) {
    qTf.set(t, (qTf.get(t) || 0) + 1);
  }
  const qVec = new Map();
  let qNorm = 0;
  for (const [t, freq] of qTf) {
    const weight = (freq / qTokens.length) * (index.idf.get(t) || 0);
    qVec.set(t, weight);
    qNorm += weight * weight;
  }
  qNorm = Math.sqrt(qNorm) || 1;
  for (const [t, w] of qVec) {
    qVec.set(t, w / qNorm);
  }

  // 计算相似度并排序
  const scored = index.vectors.map((v) => ({
    id: v.id,
    score: cosineSim(qVec, v.vec)
  }));
  scored.sort((a, b) => b.score - a.score);

  // 取 top-K，过滤掉分数为 0 的
  const topIds = scored.filter((s) => s.score > 0.01).slice(0, topK).map((s) => s.id);
  if (!topIds.length) return [];

  const result = db.prepare(`SELECT cc.id, cc.chapter_index, cc.chunk_index, cc.text
                             FROM chapter_chunks cc WHERE cc.id IN (${topIds.map(() => '?').join(',')})`).all(...topIds);

  // 按 score 排序返回
  const idMap = new Map(result.map((r) => [r.id, r]));
  return topIds.map((id) => idMap.get(id)).filter(Boolean);
}

// 格式化 RAG 检索结果为 context 块
export function formatRagBlock(chunks) {
  if (!chunks || !chunks.length) return '';
  const lines = chunks.map((c) => `【第${c.chapter_index}章片段】${String(c.text).slice(0, 300)}`);
  return `【已发生的历史片段（RAG 检索，按与上一章结尾/本章概要的相关度匹配）】
以下均为已经发生过的剧情节选，仅供人物关系、设定与前后呼应保持一致时参考。严禁把它们当作"本章即将发生的情节"直接照抄；本章剧情必须紧接上一章结尾的场面往后推进。
${lines.join('\n')}`;
}

// ====================================================================
// RAG 缓存层 — 避免每次检索都重建 TF-IDF 索引
// ====================================================================

const _indexCache = new Map(); // novelId -> { index, chunkCount, lastUpdate }

/**
 * 获取或构建某小说的 TF-IDF 索引（带缓存）
 */
export function getCachedIndex(novelId) {
  const rows = db.prepare('SELECT COUNT(*) as count FROM chapter_chunks WHERE novel_id = ?').get(novelId);
  const chunkCount = rows?.count || 0;

  const cached = _indexCache.get(novelId);
  if (cached && cached.chunkCount === chunkCount) {
    return cached.index;
  }

  // 重新构建索引
  const chunks = db.prepare('SELECT id, text, keywords FROM chapter_chunks WHERE novel_id = ? ORDER BY chapter_index, chunk_index').all(novelId);
  if (!chunks.length) {
    _indexCache.set(novelId, { index: null, chunkCount: 0, lastUpdate: Date.now() });
    return null;
  }

  const docs = chunks.map((r) => ({ id: r.id, text: r.text + ' ' + (r.keywords || '') }));
  const index = buildTfIdf(docs);

  _indexCache.set(novelId, { index, chunkCount, lastUpdate: Date.now() });
  return index;
}

/**
 * 增量更新索引（新增一个 chunk 后追加到缓存索引）
 */
export function appendChunkToIndex(novelId, chunkId, text) {
  const cached = _indexCache.get(novelId);
  if (!cached || !cached.index) {
    // 缓存不存在，下次 getCachedIndex 会重建
    _indexCache.delete(novelId);
    return;
  }

  const { index } = cached;
  const N = index.N + 1;

  // 更新 DF
  const tokens = new Set(tokenize(text));
  for (const t of tokens) {
    const df = index.idf.get(t) || 0;
    index.idf.set(t, df + 1);
  }

  // 重建 IDF（因为 N 变了）
  for (const [t, df] of index.idf) {
    index.idf.set(t, Math.log((N + 1) / (df + 1)) + 1);
  }

  // 添加新文档向量
  const docTokens = tokenize(text);
  const tf = new Map();
  for (const t of docTokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  const vec = new Map();
  let norm = 0;
  for (const [t, freq] of tf) {
    const weight = (freq / docTokens.length) * (index.idf.get(t) || 0);
    vec.set(t, weight);
    norm += weight * weight;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of vec) {
    vec.set(t, w / norm);
  }
  index.vectors.push({ id: chunkId, vec, norm });
  index.N = N;

  // 更新缓存计数
  cached.chunkCount = N;
  cached.lastUpdate = Date.now();
}

/**
 * 失效某小说的索引缓存（章节被修改/删除时调用）
 */
export function invalidateIndex(novelId) {
  _indexCache.delete(novelId);
}

/**
 * 使用缓存的索引进行检索（性能优化版）
 */
export function retrieveRelevantCached(novelId, query, topK = 5) {
  const index = getCachedIndex(novelId);
  if (!index || !query) return [];

  // 构建 query 向量
  const qTokens = tokenize(query);
  const qTf = new Map();
  for (const t of qTokens) {
    qTf.set(t, (qTf.get(t) || 0) + 1);
  }
  const qVec = new Map();
  let qNorm = 0;
  for (const [t, freq] of qTf) {
    const weight = (freq / qTokens.length) * (index.idf.get(t) || 0);
    qVec.set(t, weight);
    qNorm += weight * weight;
  }
  qNorm = Math.sqrt(qNorm) || 1;
  for (const [t, w] of qVec) {
    qVec.set(t, w / qNorm);
  }

  // 计算相似度并排序
  const scored = index.vectors.map((v) => ({
    id: v.id,
    score: cosineSim(qVec, v.vec)
  }));
  scored.sort((a, b) => b.score - a.score);

  const topIds = scored.filter((s) => s.score > 0.01).slice(0, topK).map((s) => s.id);
  if (!topIds.length) return [];

  const result = db.prepare(`SELECT cc.id, cc.chapter_index, cc.chunk_index, cc.text
                             FROM chapter_chunks cc WHERE cc.id IN (${topIds.map(() => '?').join(',')})`).all(...topIds);

  const idMap = new Map(result.map((r) => [r.id, r]));
  return topIds.map((id) => idMap.get(id)).filter(Boolean);
}

/**
 * 获取 RAG 缓存状态
 */
export function getRagCacheStatus(novelId) {
  const cached = _indexCache.get(novelId);
  const rows = db.prepare('SELECT COUNT(*) as count FROM chapter_chunks WHERE novel_id = ?').get(novelId);
  return {
    cached: !!cached,
    chunkCount: rows?.count || 0,
    indexSize: cached?.index?.N || 0,
    lastUpdate: cached?.lastUpdate ? new Date(cached.lastUpdate).toISOString() : null,
  };
}

/**
 * 清空所有缓存
 */
export function clearAllRagCache() {
  _indexCache.clear();
}
