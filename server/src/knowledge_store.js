import { db } from './db.js';

/**
 * 知识学习库管理 — 导入小说 txt，LLM 学习文笔/剧情/逻辑/世界观/人物塑造
 */

export function createCorpus({ title, genre, author, sourceFilename }) {
  const ins = db.prepare(
    'INSERT INTO knowledge_corpora (title, genre, author, source_filename, status) VALUES (?,?,?,?,?)'
  ).run(
    String(title || sourceFilename || '未命名').trim(),
    String(genre || '').trim(),
    String(author || '').trim(),
    String(sourceFilename || '').trim(),
    'pending'
  );
  return ins.lastInsertRowid;
}

export function getCorpus(id) {
  return db.prepare('SELECT * FROM knowledge_corpora WHERE id = ?').get(id);
}

export function listCorpora(genre) {
  if (genre) {
    return db.prepare(
      "SELECT id, title, genre, author, total_words, status, learned_at, created_at FROM knowledge_corpora WHERE genre LIKE ? ORDER BY created_at DESC"
    ).all(`%${genre}%`);
  }
  return db.prepare(
    'SELECT id, title, genre, author, total_words, status, learned_at, created_at FROM knowledge_corpora ORDER BY created_at DESC'
  ).all();
}

export function deleteCorpus(id) {
  db.prepare('DELETE FROM knowledge_corpora WHERE id = ?').run(id);
}

export function updateCorpusStatus(id, status, extra = {}) {
  const sets = ['status = ?'];
  const vals = [status];
  if (extra.analysis !== undefined) { sets.push('analysis = ?'); vals.push(extra.analysis); }
  if (extra.totalWords !== undefined) { sets.push('total_words = ?'); vals.push(extra.totalWords); }
  if (extra.learnedAt !== undefined) { sets.push('learned_at = ?'); vals.push(extra.learnedAt); }
  if (extra.title !== undefined) { sets.push('title = ?'); vals.push(extra.title); }
  vals.push(id);
  db.prepare(`UPDATE knowledge_corpora SET ${sets.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`).run(...vals);
}

export function saveSamples(corpusId, chunks) {
  const stmt = db.prepare('INSERT INTO knowledge_samples (corpus_id, chunk_index, text, scene_tags, keywords) VALUES (?,?,?,?,?)');
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (typeof c === 'string') {
      stmt.run(corpusId, i, c, '', '');
    } else {
      stmt.run(corpusId, c.slice_index ?? i, c.text, JSON.stringify(c.scene_tags || []), c.keywords || '');
    }
  }
}

export function clearSamples(corpusId) {
  db.prepare('DELETE FROM knowledge_samples WHERE corpus_id = ?').run(corpusId);
}

export function updateSampleTags(corpusId, sliceIndex, sceneTags) {
  db.prepare('UPDATE knowledge_samples SET scene_tags = ? WHERE corpus_id = ? AND slice_index = ?')
    .run(JSON.stringify(sceneTags || []), corpusId, sliceIndex);
}

export function setCorpusTagStatus(corpusId, status) {
  db.prepare("UPDATE knowledge_corpora SET tag_status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(status, corpusId);
}

export function getSamples(corpusId, limit = 0) {
  const sql = limit > 0
    ? 'SELECT chunk_index, text FROM knowledge_samples WHERE corpus_id = ? ORDER BY chunk_index LIMIT ?'
    : 'SELECT chunk_index, text FROM knowledge_samples WHERE corpus_id = ? ORDER BY chunk_index';
  return limit > 0
    ? db.prepare(sql).all(corpusId, limit)
    : db.prepare(sql).all(corpusId);
}

export function getCorpusAnalysis(id) {
  const row = db.prepare('SELECT analysis FROM knowledge_corpora WHERE id = ?').get(id);
  return row?.analysis || '';
}

/**
 * 按题材获取已学习知识库的分析摘要（注入 prompt 用）
 */
export function getKnowledgeByGenres(genres, limit = 3) {
  if (!genres || !genres.length) return [];
  const conditions = genres.map(() => 'genre LIKE ?').join(' OR ');
  const params = genres.map((g) => `%${g}%`);
  const rows = db.prepare(
    `SELECT id, title, genre, analysis, total_words FROM knowledge_corpora WHERE status = 'learned' AND (${conditions}) ORDER BY total_words DESC LIMIT ?`
  ).all(...params, limit);
  return rows;
}

/**
 * 组装知识注入块（供方案生成/章节生成 prompt 使用）
 */
export function formatKnowledgeBlock(corporaIds) {
  if (!corporaIds || !corporaIds.length) return '';
  const ids = Array.isArray(corporaIds) ? corporaIds : String(corporaIds).split(',').filter(Boolean);
  if (!ids.length) return '';
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, title, genre, analysis, total_words FROM knowledge_corpora WHERE id IN (${placeholders}) AND status = 'learned'`
  ).all(...ids);
  if (!rows.length) return '';
  const blocks = rows.map((r, i) => {
    let analysis = r.analysis || '';
    try {
      const parsed = JSON.parse(analysis);
      if (parsed && typeof parsed === 'object') {
        const parts = [];
        if (parsed.writing_style) parts.push(`【文笔风格】${parsed.writing_style}`);
        if (parsed.plot_patterns) parts.push(`【剧情套路】${parsed.plot_patterns}`);
        if (parsed.logic_rules) parts.push(`【逻辑规律】${parsed.logic_rules}`);
        if (parsed.worldview) parts.push(`【世界观构建】${parsed.worldview}`);
        if (parsed.character_craft) parts.push(`【人物塑造】${parsed.character_craft}`);
        if (parsed.scene_patterns) parts.push(`【经典场景模式】${parsed.scene_patterns}`);
        if (parsed.replicable_techniques) parts.push(`【可复用技法】${parsed.replicable_techniques}`);
        analysis = parts.join('\n');
      }
    } catch { /* analysis 本身就是纯文本 */ }
    return `### 学习素材 ${i + 1}：《${r.title}》（${r.genre}，${r.total_words} 字）\n${analysis}`;
  });
  return `\n\n【已学习参考作品分析】\n以下是从优秀同类作品中学习到的写作经验，请在创作时充分借鉴其文笔、剧情逻辑、人物塑造和世界观构建方式，但不要照搬具体内容：\n\n${blocks.join('\n\n')}`;
}

/**
 * 获取知识库样本片段（供文风样本注入的回退路径）：按顺序填充至 maxChars
 */
export function getSampleSnippets(corpusId, maxChars = 6000) {
  const rows = getSamples(corpusId);
  if (!rows.length) return '';
  let result = '';
  for (const r of rows) {
    if (result.length >= maxChars) break;
    const t = String(r.text || '');
    result += t.slice(0, maxChars - result.length) + '\n\n';
  }
  return result.trim();
}

/**
 * 知识库场景标签分布统计（详情页展示用）
 */
export function getCorpusTagStats(corpusId) {
  const rows = db.prepare('SELECT scene_tags FROM knowledge_samples WHERE corpus_id = ?').all(corpusId);
  const stats = {};
  let tagged = 0;
  for (const r of rows) {
    try {
      const tags = JSON.parse(r.scene_tags || '[]');
      if (tags.length) tagged++;
      for (const t of tags) stats[t] = (stats[t] || 0) + 1;
    } catch { /* 忽略损坏数据 */ }
  }
  return { total: rows.length, tagged, distribution: stats };
}

/**
 * 从小说获取关联的知识库 IDs
 */
export function getNovelKnowledgeIds(novel) {
  const raw = novel?.knowledge_corpus_ids || '';
  if (!raw) return [];
  return String(raw).split(',').filter(Boolean).map(Number);
}


