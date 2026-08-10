import { db, getSetting, setSetting } from './db.js';

export function countWords(text) {
  if (!text) return 0;
  const noWs = String(text).replace(/\s+/g, '');
  const cjk = (noWs.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const other = noWs.length - cjk;
  return cjk + Math.round(other / 2);
}

export function getLLMConfig() {
  try {
    return JSON.parse(getSetting('llm_config') || '{}');
  } catch {
    return {};
  }
}

export function saveLLMConfig(config) {
  setSetting('llm_config', JSON.stringify(config));
}

export function getNovel(id) {
  const n = db.prepare('SELECT * FROM novels WHERE id = ?').get(id);
  if (n) {
    try { n.style_ids = JSON.parse(n.style_ids || '[]'); } catch { n.style_ids = []; }
    try { n.style_presets = parseStylePresets(n); } catch { n.style_presets = []; }
    try { n.story_arcs = n.story_arcs ? JSON.parse(n.story_arcs) : null; } catch { n.story_arcs = null; }
    try { n.expanded_world = n.expanded_world ? JSON.parse(n.expanded_world) : null; } catch { n.expanded_world = null; }
  }
  return n;
}

export function parseStylePresets(novel) {
  if (!novel) return [];
  return String(novel.style_presets || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getStyles(ids) {
  if (!ids || !ids.length) return [];
  const unique = [...new Set(ids.map(Number).filter(Boolean))];
  if (!unique.length) return [];
  const placeholders = unique.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM styles WHERE id IN (${placeholders})`).all(...unique);
}

export function getStyle(id) {
  return db.prepare('SELECT * FROM styles WHERE id = ?').get(id);
}

export function parseStyleIds(novel) {
  if (!novel) return [];
  try { return JSON.parse(novel.style_ids || '[]'); } catch { return []; }
}

// 超长文本抽样：保留开头、均匀抽取中段、保留结尾，用于风格分析等大文本场景
export function sampleText(text, budget = 60000) {
  if (!text) return '';
  const total = text.length;
  if (total <= budget) return text;
  const KEEP_START = Math.floor(budget * 0.2);
  const KEEP_END = Math.floor(budget * 0.2);
  const middleBudget = budget - KEEP_START - KEEP_END;
  const pieces = [text.slice(0, KEEP_START)];
  const middle = text.slice(KEEP_START, total - KEEP_END);
  if (middleBudget > 0 && middle.length) {
    const pieceLen = 3000;
    const count = Math.max(1, Math.min(12, Math.floor(middleBudget / pieceLen)));
    for (let i = 0; i < count; i++) {
      const start = Math.floor(((i + 0.5) / count) * middle.length);
      pieces.push(middle.slice(start, Math.min(start + pieceLen, middle.length)));
    }
  }
  pieces.push(text.slice(total - KEEP_END));
  return pieces.join('\n\n……（此处省略，下接原文抽样）……\n\n');
}

// 伏笔清单
export function getForeshadowings(novelId) {
  return db.prepare(
    "SELECT * FROM foreshadowings WHERE novel_id = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC"
  ).all(novelId);
}

export function getOpenForeshadowings(novelId, limit = 30) {
  return db.prepare(
    'SELECT * FROM foreshadowings WHERE novel_id = ? AND status = ? ORDER BY id ASC LIMIT ?'
  ).all(novelId, 'open', limit);
}

export function formatForeshadowList(items) {
  if (!items || !items.length) return '';
  return items
    .map((f, i) => `${i + 1}. ${f.content}（第${f.chapter_index || '?'}章埋下${f.note ? '；备注：' + f.note : ''}）`)
    .join('\n');
}

// 关键剧情事实锚点：长期连载中防止设定冲突与关键信息遗忘
export function getKeyMoments(novelId, limit = 80) {
  return db.prepare(
    'SELECT * FROM novel_key_moments WHERE novel_id = ? ORDER BY id DESC LIMIT ?'
  ).all(novelId, limit).reverse();
}

export function formatKeyMoments(items) {
  if (!items || !items.length) return '';
  return items
    .map((m) => `- ${m.content}${m.chapter_index ? `（第${m.chapter_index}章）` : ''}`)
    .join('\n');
}

export function addKeyMomentUnique(novelId, content, chapterIndex) {
  const text = String(content || '').trim();
  if (!text) return null;
  const exists = db.prepare(
    "SELECT id FROM novel_key_moments WHERE novel_id = ? AND (content = ? OR instr(?, content) > 0 OR instr(content, ?) > 0)"
  ).get(novelId, text, text, text.slice(0, 20));
  if (exists) return null;
  const info = db.prepare(
    'INSERT INTO novel_key_moments (novel_id, content, chapter_index) VALUES (?,?,?)'
  ).run(novelId, text, chapterIndex || 0);
  return db.prepare('SELECT * FROM novel_key_moments WHERE id = ?').get(info.lastInsertRowid);
}

// 阶段记忆（卷快照）：每 50 章浓缩一条，超长连载中早期剧情不丢
export function getStageMemories(novelId) {
  return db.prepare(
    'SELECT * FROM novel_stage_memories WHERE novel_id = ? ORDER BY stage_no'
  ).all(novelId);
}

export function upsertStageMemory(novelId, stageNo, start, end, content) {
  const exists = db.prepare(
    'SELECT id FROM novel_stage_memories WHERE novel_id = ? AND stage_no = ?'
  ).get(novelId, stageNo);
  const text = String(content || '').trim();
  if (!text) return null;
  if (exists) {
    db.prepare(
      "UPDATE novel_stage_memories SET stage_start = ?, stage_end = ?, content = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(start, end, text, exists.id);
    return db.prepare('SELECT * FROM novel_stage_memories WHERE id = ?').get(exists.id);
  }
  const info = db.prepare(
    'INSERT INTO novel_stage_memories (novel_id, stage_no, stage_start, stage_end, content) VALUES (?,?,?,?,?)'
  ).run(novelId, stageNo, start, end, text);
  return db.prepare('SELECT * FROM novel_stage_memories WHERE id = ?').get(info.lastInsertRowid);
}

export function formatStageMemories(items, limit = 3) {
  if (!items || !items.length) return '';
  return items
    .slice(-limit)
    .map((s) => `【第${s.stage_no}阶段 · 第${s.stage_start}-${s.stage_end}章】${s.content}`)
    .join('\n\n');
}

// 角色档案：确保长篇连载中角色性格、言行、目标前后一致
export function getCharacterProfiles(novelId) {
  return db.prepare(
    'SELECT * FROM novel_character_profiles WHERE novel_id = ? ORDER BY id'
  ).all(novelId);
}

export function upsertCharacterProfile(novelId, name, profile, chapterIndex) {
  const text = String(profile || '').trim();
  const cname = String(name || '').trim();
  if (!text || !cname) return null;
  const exists = db.prepare(
    'SELECT id FROM novel_character_profiles WHERE novel_id = ? AND char_name = ?'
  ).get(novelId, cname);
  if (exists) {
    db.prepare(
      "UPDATE novel_character_profiles SET profile = ?, chapter_index = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(text, chapterIndex || 0, exists.id);
    return db.prepare('SELECT * FROM novel_character_profiles WHERE id = ?').get(exists.id);
  }
  const info = db.prepare(
    'INSERT INTO novel_character_profiles (novel_id, char_name, profile, chapter_index) VALUES (?,?,?,?)'
  ).run(novelId, cname, text, chapterIndex || 0);
  return db.prepare('SELECT * FROM novel_character_profiles WHERE id = ?').get(info.lastInsertRowid);
}

export function formatCharacterProfiles(items) {
  if (!items || !items.length) return '';
  return items.map((c) => `- ${c.char_name}：${c.profile}`).join('\n');
}

export function getRecentChapters(novelId, n = 2) {
  return db.prepare('SELECT chapter_index, title, content FROM chapters WHERE novel_id = ? AND content != \'\' ORDER BY chapter_index DESC LIMIT ?').all(novelId, n).reverse();
}

export function getCharacters(novelId) {
  return db.prepare('SELECT * FROM characters WHERE novel_id = ? ORDER BY id').all(novelId);
}

export function getFactions(novelId) {
  return db.prepare('SELECT * FROM factions WHERE novel_id = ? ORDER BY id').all(novelId);
}

export function getRelationships(novelId) {
  return db.prepare('SELECT * FROM relationships WHERE novel_id = ?').all(novelId);
}

export function getChapters(novelId) {
  return db.prepare('SELECT id, novel_id, chapter_index, title, summary, word_count, status, ai_score, created_at, updated_at FROM chapters WHERE novel_id = ? ORDER BY chapter_index').all(novelId);
}

export function getChapter(novelId, chapterIndex) {
  return db.prepare('SELECT * FROM chapters WHERE novel_id = ? AND chapter_index = ?').get(novelId, chapterIndex);
}

export function getMaxChapterIndex(novelId) {
  const row = db.prepare('SELECT MAX(chapter_index) m FROM chapters WHERE novel_id = ?').get(novelId);
  return row ? (row.m || 0) : 0;
}

// 判定是否应自动首次压缩：未启用压缩时，最近已写章节注入下章的字符数超过模型上下文预算的阈值比例
export function shouldAutoCompress(novel, config, recentChars) {
  if (config && config.autoCompress === false) return false;
  if (novel && novel.context_compressed == 1) return false;
  const ctx = Number(config?.contextLength) || 32768;
  const out = Number(config?.maxTokens) || 8192;
  const budget = Math.max(4096, Math.floor(ctx - out - 4096));
  const threshold = Number(config?.compressThreshold) || 0.5;
  // token 近似换字符：×1.5（中文），下限 4000 字避免短篇过早压缩
  const charLimit = Math.max(4000, Math.round(budget * threshold * 1.5));
  return Number(recentChars) >= charLimit;
}

export function getChapterBackups(novelId, chapterIndex) {
  return db.prepare('SELECT id, novel_id, chapter_index, title, content, reason, created_at FROM chapter_backups WHERE novel_id = ? AND chapter_index = ? ORDER BY id DESC').all(novelId, chapterIndex);
}

export function getWorldSettings(novelId) {
  return db.prepare("SELECT * FROM world_settings WHERE novel_id = ? ORDER BY CASE category WHEN '人物' THEN 0 WHEN '地点' THEN 1 WHEN '势力' THEN 2 WHEN '物品' THEN 3 WHEN '时间线' THEN 4 WHEN '其他' THEN 5 END, id").all(novelId);
}

export function formatWorldSettings(items) {
  if (!items || !items.length) return '';
  const groups = {};
  for (const s of items) {
    (groups[s.category || '其他'] = groups[s.category || '其他'] || []).push(s);
  }
  const lines = [];
  for (const [cat, list] of Object.entries(groups)) {
    lines.push(`【${cat}】`);
    for (const s of list) {
      lines.push(`- ${s.name}：${s.content}`);
    }
  }
  return lines.join('\n');
}

// 逐章摘要链：按 token 预算保留摘要，最近优先（预算不足时丢最老摘要）
export function buildHistorySummaries(novelId, budgetTokens) {
  const rows = db.prepare("SELECT chapter_index, title, summary FROM chapters WHERE novel_id = ? AND summary != '' ORDER BY chapter_index").all(novelId);
  if (!budgetTokens || budgetTokens <= 0 || rows.length <= 1) return rows;
  const kept = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = estimateTokens(`第${rows[i].chapter_index}章 ${rows[i].title}：${rows[i].summary}`) + 1;
    if (kept.length && used + t > budgetTokens) break;
    kept.unshift(rows[i]);
    used += t;
  }
  return kept;
}

export function getNovelProgressText(novel, recentChapters) {
  const lines = [];
  lines.push(`书名：${novel.title || '未命名'}`);
  lines.push(`类型：${novel.genre || '未设定'}`);
  if (novel.world_view) lines.push(`世界观：${novel.world_view.slice(0, 500)}`);
  if (novel.outline) lines.push(`大纲：${novel.outline.slice(0, 800)}`);
  if (recentChapters.length) {
    lines.push('最近剧情：');
    for (const c of recentChapters) {
      lines.push(`第${c.chapter_index}章 ${c.title}：${String(c.content).slice(0, 600)}`);
    }
  }
  return lines.join('\n');
}

// ---------- AI 高频词黑名单硬过滤 ----------
// 这些词是 AI 写作的高频指纹。真人小说偶尔也会用个别词，
// 但同一章出现过多即为"AI 味信号"，作为质量门的硬性判定依据。
const AI_BLACKLIST = [
  '仿佛', '宛如', '犹如', '好似', '不禁', '微微一怔', '喃喃自语', '呢喃',
  '心底涌起', '眸底', '眸子', '眼底深处', '五味杂陈', '若有所思', '氤氲',
  '缱绻', '旖旎', '潋滟', '时光荏苒', '岁月如梭', '岁月静好', '感慨万千',
  '深吸一口气', '久久不能平静', '嘴角勾起一抹', '闪过一丝精光', '绽放出',
  '熠熠生辉', '袅袅', '流淌着', '诉说着', '仿佛能听到', '似乎一切'
];

export function scanAiPatterns(text) {
  if (!text) return [];
  const hits = [];
  const seen = new Set();
  for (const w of AI_BLACKLIST) {
    if (seen.has(w)) continue;
    seen.add(w);
    let count = 0;
    let from = 0;
    while ((from = text.indexOf(w, from)) !== -1) {
      count++;
      from += w.length;
    }
    if (count > 0) hits.push({ word: w, count });
  }
  return hits.sort((a, b) => b.count - a.count);
}

// 质量门判定：黑名单词命中达到阈值即判"AI 味超标"，需要再润色
export function blacklistPenalty(hits) {
  if (!hits || !hits.length) return 0;
  return hits.reduce((sum, h) => sum + Math.min(h.count, 5), 0);
}

// 命中黑名单词即视为需要处理（宁严勿松）。质量门要求最终章节不再命中任何黑名单词。
export function blacklistFlagWords(hits, threshold = 1) {
  return (hits || []).filter((h) => h.count >= threshold).map((h) => h.word);
}

// 粗略估算文本 token 数（中文按约 0.7 token/字，其他按 4 字符/token）
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const other = text.length - cjk;
  return Math.round(cjk * 0.7 + other / 4);
}
