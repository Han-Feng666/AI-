import { db } from './db.js';
import { chat } from './llm.js';
import { NOVEL_CONSTITUTION_BUILD_SYSTEM, PLOT_CONSISTENCY_CHECK_SYSTEM } from './prompts.js';

// ====================================================================
// P0-P3 长篇记忆基础设施
// ====================================================================

// ---------- P0-1: 分层摘要树 ----------

export function saveChapterSummary(novelId, chapterIdx, summary) {
  if (!summary) return;
  db.prepare(`INSERT INTO chapter_summaries (novel_id, chapter_index, level, start_chapter, end_chapter, summary)
              VALUES (?, ?, 0, ?, ?, ?)
              ON CONFLICT(novel_id, level, start_chapter) DO UPDATE SET summary = excluded.summary`)
    .run(novelId, chapterIdx, chapterIdx, chapterIdx, String(summary).trim());
}

export function getLevelSummaries(novelId, level, fromCh, toCh) {
  return db.prepare(`SELECT * FROM chapter_summaries WHERE novel_id = ? AND level = ? AND start_chapter >= ? AND start_chapter <= ? ORDER BY start_chapter`)
    .all(novelId, level, fromCh || 0, toCh || 999999);
}

// 分层组装 context：最近 N 章用 level-0 单章摘要，更远用 level-1/2/3/4。
// 自适应窗口：超长连载（几百章）时每一层只取「最近的若干块」，更早的内容交给更高层摘要，
// 避免提示词无限膨胀，同时保证最近的情节颗粒度最细。
export function buildHierarchicalContext(novelId, currentIdx) {
  const RECENT_L0 = 5;   // 最近 5 章用单章摘要
  const L1_SIZE = 5;     // level-1 覆盖 5 章
  const L2_SIZE = 25;    // level-2 覆盖 25 章
  const L3_SIZE = 100;   // level-3 覆盖 100 章
  const L4_SIZE = 400;   // level-4 覆盖 400 章（仅超长连载生成）
  // 每层最多保留的块数（更早的由更高层覆盖）
  const MAX_L1 = 8;
  const MAX_L2 = 6;
  const MAX_L3 = 3;
  const MAX_L4 = 2;

  const l0Start = Math.max(1, currentIdx - RECENT_L0);
  const l0Rows = getLevelSummaries(novelId, 0, l0Start, currentIdx - 1);
  let parts = [];

  // 最近 5 章单章摘要
  if (l0Rows.length) {
    parts.push('【最近章节摘要】');
    l0Rows.forEach((r) => parts.push(`第${r.start_chapter}章：${r.summary}`));
  }

  // level-1 节摘要：覆盖 l0Start 之前的章节，只取最近 MAX_L1 块
  const l1End = l0Start - 1;
  if (l1End >= 1) {
    const l1Rows = getLevelSummaries(novelId, 1, 1, l1End);
    if (l1Rows.length) {
      const recent = l1Rows.slice(-MAX_L1);
      if (recent.length < l1Rows.length) parts.push(`\n【更早章节节摘要（共 ${l1Rows.length} 段，此处为最近 ${recent.length} 段，更早见下方卷摘要）】`);
      else parts.push('\n【更早章节节摘要】');
      recent.forEach((r) => parts.push(`第${r.start_chapter}-${r.end_chapter}章：${r.summary}`));
    }
  }

  // level-2 卷摘要：取最近 MAX_L2 块
  const l2End = l0Start - L1_SIZE - 1;
  if (l2End >= 1) {
    const l2Rows = getLevelSummaries(novelId, 2, 1, l2End);
    if (l2Rows.length) {
      const recent = l2Rows.slice(-MAX_L2);
      if (recent.length < l2Rows.length) parts.push(`\n【早期卷摘要（共 ${l2Rows.length} 段，此处为最近 ${recent.length} 段）】`);
      else parts.push('\n【早期卷摘要】');
      recent.forEach((r) => parts.push(`第${r.start_chapter}-${r.end_chapter}章：${r.summary}`));
    }
  }

  // level-3 部摘要：取最近 MAX_L3 块
  const l3End = l0Start - L2_SIZE - 1;
  if (l3End >= 1) {
    const l3Rows = getLevelSummaries(novelId, 3, 1, l3End);
    if (l3Rows.length) {
      const recent = l3Rows.slice(-MAX_L3);
      if (recent.length < l3Rows.length) parts.push(`\n【全书早期摘要（共 ${l3Rows.length} 段，此处为最近 ${recent.length} 段）】`);
      else parts.push('\n【全书早期摘要】');
      recent.forEach((r) => parts.push(`第${r.start_chapter}-${r.end_chapter}章：${r.summary}`));
    }
  }

  // level-4 全书总览（仅超长连载，通常 1-2 段，概括最久远的历史走向）
  const l4End = l0Start - L3_SIZE - 1;
  if (l4End >= 1) {
    const l4Rows = getLevelSummaries(novelId, 4, 1, l4End);
    if (l4Rows.length) {
      const recent = l4Rows.slice(-MAX_L4);
      parts.push(`\n【全书历史总览（极早期剧情的浓缩记忆，把握长线走向）】`);
      recent.forEach((r) => parts.push(`第${r.start_chapter}-${r.end_chapter}章：${r.summary}`));
    }
  }

  return parts.length ? parts.join('\n') : '';
}

// 压缩 level N：取 level N-1 的摘要合并成 level N
export async function compressSummaryLevel(novelId, level, config) {
  const SIZE = level === 1 ? 5 : level === 2 ? 25 : level === 3 ? 100 : 400;
  const prevLevel = level - 1;
  const maxCh = db.prepare('SELECT MAX(end_chapter) m FROM chapter_summaries WHERE novel_id = ? AND level = ?').get(novelId, prevLevel)?.m || 0;
  if (!maxCh) return;

  // 找到尚未压缩成 level 的 prev-level 区间
  const existingL = db.prepare('SELECT start_chapter FROM chapter_summaries WHERE novel_id = ? AND level = ? ORDER BY start_chapter').all(novelId, level);
  const existingSet = new Set(existingL.map((r) => r.start_chapter));

  for (let start = 1; start <= maxCh; start += SIZE) {
    if (existingSet.has(start)) continue;
    const end = Math.min(start + SIZE - 1, maxCh);
    const rows = getLevelSummaries(novelId, prevLevel, start, end);
    if (rows.length < Math.min(SIZE, 3)) continue; // 太少不压缩

    const combined = rows.map((r) => `第${r.start_chapter}章：${r.summary}`).join('\n');
    const r = await chat({
      config,
      task: 'summary',
      messages: [
        { role: 'system', content: '你是小说压缩器。把多章摘要合并为一段 200-400 字的节摘要，保留：关键剧情转折、角色成长、伏笔状态。直接输出摘要，不解释。' },
        { role: 'user', content: `合并以下 ${rows.length} 章的摘要为一段：\n\n${combined}` }
      ],
      maxTokens: 600
    }).catch(() => null);

    const summary = String(r?.content || '').trim();
    if (!summary) continue;

    db.prepare(`INSERT INTO chapter_summaries (novel_id, chapter_index, level, start_chapter, end_chapter, summary)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(novel_id, level, start_chapter) DO UPDATE SET summary = excluded.summary`)
      .run(novelId, start, level, start, end, summary);
  }
}

export async function compressSummariesIfNeeded(novelId, currentIdx, config) {
  // 每 5 章触发 level-1 压缩
  if (currentIdx % 5 === 0) await compressSummaryLevel(novelId, 1, config);
  // 每 25 章触发 level-2
  if (currentIdx % 25 === 0) await compressSummaryLevel(novelId, 2, config);
  // 每 100 章触发 level-3
  if (currentIdx % 100 === 0) await compressSummaryLevel(novelId, 3, config);
  // 每 400 章触发 level-4（超长连载）
  if (currentIdx % 400 === 0) await compressSummaryLevel(novelId, 4, config);
}

// ---------- P1-1: 结构化事实库 ----------

export function getActiveFacts(novelId, currentIdx = null) {
  if (currentIdx !== null) {
    return db.prepare(`SELECT * FROM novel_facts WHERE novel_id = ? AND superseded_by IS NULL AND chapter_index < ? ORDER BY chapter_index`).all(novelId, currentIdx);
  }
  return db.prepare(`SELECT * FROM novel_facts WHERE novel_id = ? AND superseded_by IS NULL ORDER BY chapter_index`).all(novelId);
}

export function saveFact(novelId, fact, chapterIdx) {
  // 检查同 subject + key 是否已有值
  const existing = db.prepare(`SELECT id, fact_value FROM novel_facts WHERE novel_id = ? AND subject_type = ? AND subject_name = ? AND fact_key = ? AND superseded_by IS NULL`)
    .get(novelId, fact.subject_type, fact.subject_name, fact.fact_key);
  if (existing) {
    if (String(existing.fact_value).trim() === String(fact.fact_value).trim()) return null; // 无变化
    // 标记旧值为已废弃
    db.prepare('UPDATE novel_facts SET superseded_by = ? WHERE id = ?').run(-1, existing.id);
  }
  const info = db.prepare('INSERT INTO novel_facts (novel_id, subject_type, subject_name, fact_key, fact_value, chapter_index) VALUES (?,?,?,?,?,?)')
    .run(novelId, fact.subject_type, fact.subject_name, fact.fact_key, String(fact.fact_value), chapterIdx);
  return info.lastInsertRowid;
}

export function checkFactConflicts(novelId, newFacts, chapterIdx) {
  const conflicts = [];
  for (const f of newFacts) {
    const existing = db.prepare(`SELECT fact_value, chapter_index FROM novel_facts WHERE novel_id = ? AND subject_type = ? AND subject_name = ? AND fact_key = ? AND superseded_by IS NULL`)
      .get(novelId, f.subject_type, f.subject_name, f.fact_key);
    if (existing && String(existing.fact_value).trim() !== String(f.fact_value).trim()) {
      conflicts.push({
        subject: f.subject_name,
        key: f.fact_key,
        old: existing.fact_value,
        oldChapter: existing.chapter_index,
        new: f.fact_value,
        newChapter: chapterIdx
      });
    }
  }
  return conflicts;
}

export function formatFactsBlock(novelId, currentIdx = null) {
  const facts = getActiveFacts(novelId, currentIdx);
  if (!facts.length) return '';
  const grouped = {};
  for (const f of facts) {
    const k = `${f.subject_type}:${f.subject_name}`;
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(`${f.fact_key}=${f.fact_value}（第${f.chapter_index}章确立）`);
  }
  const lines = Object.entries(grouped).map(([k, items]) => `- ${k}：${items.join('；')}`);
  return lines.join('\n');
}

// ---------- P1-2: 角色时间线 ----------

export function saveCharacterChange(novelId, characterId, chapterIdx, field, oldVal, newVal, reason) {
  db.prepare('INSERT INTO character_timeline (novel_id, character_id, chapter_index, field, old_value, new_value, reason) VALUES (?,?,?,?,?,?,?)')
    .run(novelId, characterId, chapterIdx, field, oldVal || '', newVal, reason || '');
}

export function getCharacterTimeline(novelId, characterId, limit = 20) {
  return db.prepare(`SELECT * FROM character_timeline WHERE novel_id = ? AND character_id = ? ORDER BY id DESC LIMIT ?`)
    .all(novelId, characterId, limit);
}

export function formatTimelineBlock(novelId, currentIdx = null) {
  const rows = currentIdx !== null
    ? db.prepare(`SELECT ct.character_id, ct.chapter_index, ct.field, ct.old_value, ct.new_value, ct.reason, c.name
                           FROM character_timeline ct LEFT JOIN characters c ON ct.character_id = c.id
                           WHERE ct.novel_id = ? AND ct.chapter_index < ? ORDER BY ct.id DESC LIMIT 30`).all(novelId, currentIdx)
    : db.prepare(`SELECT ct.character_id, ct.chapter_index, ct.field, ct.old_value, ct.new_value, ct.reason, c.name
                           FROM character_timeline ct LEFT JOIN characters c ON ct.character_id = c.id
                           WHERE ct.novel_id = ? ORDER BY ct.id DESC LIMIT 30`).all(novelId);
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    const name = r.name || `角色#${r.character_id}`;
    return `- 第${r.chapter_index}章 ${name} ${r.field}：${r.old_value || '—'} → ${r.new_value}${r.reason ? `（${r.reason}）` : ''}`;
  });
  return lines.join('\n');
}

// ---------- P2-1: 伏笔自动追踪增强 ----------

export function getOverdueForeshadowings(novelId, currentIdx) {
  return db.prepare(`SELECT * FROM foreshadowings WHERE novel_id = ? AND status = 'open' AND chapter_index < ? AND expected_recall_chapter IS NOT NULL AND expected_recall_chapter <= ?`)
    .all(novelId, currentIdx, currentIdx);
}

export function setExpectedRecall(novelId, foreshadowId, chapter) {
  db.prepare('UPDATE foreshadowings SET expected_recall_chapter = ? WHERE id = ?').run(chapter, foreshadowId);
}

// ---------- P2-2: 文笔漂移检测 ----------

export function saveDriftScore(novelId, chapterIdx, score, notes) {
  db.prepare('INSERT INTO style_drift_log (novel_id, chapter_index, drift_score, notes) VALUES (?,?,?,?)')
    .run(novelId, chapterIdx, score, notes || '');
}

export function getLatestDriftScore(novelId) {
  return db.prepare('SELECT * FROM style_drift_log WHERE novel_id = ? ORDER BY id DESC LIMIT 1').get(novelId);
}

export async function detectStyleDrift(novelId, currentIdx, config) {
  const chapters = db.prepare("SELECT chapter_index, content FROM chapters WHERE novel_id = ? AND content != '' ORDER BY chapter_index").all(novelId);
  if (chapters.length < 10) return null;

  const early = chapters[0];
  const recent = chapters[chapters.length - 1];
  const earlySample = String(early.content).slice(0, 800);
  const recentSample = String(recent.content).slice(0, 800);

  const r = await chat({
    config,
    task: 'analysis',
    messages: [
      { role: 'system', content: '你是文风分析器。对比两段文字的文风差异，输出一个 0-1 的分数（0=完全一致，1=完全不同），并用一句话说明差异。格式：{"score": 0.xx, "notes": "..."}' },
      { role: 'user', content: `早期章节（第${early.chapter_index}章）：\n${earlySample}\n\n最近章节（第${recent.chapter_index}章）：\n${recentSample}` }
    ],
    maxTokens: 200
  }).catch(() => null);

  const text = String(r?.content || '').trim();
  let score = 0;
  let notes = '';
  try {
    const m = text.match(/\{[^}]+\}/);
    if (m) {
      const obj = JSON.parse(m[0]);
      score = Number(obj.score) || 0;
      notes = String(obj.notes || '');
    }
  } catch { /* ignore */ }

  saveDriftScore(novelId, currentIdx, score, notes);
  return { score, notes, earlyChapter: early.chapter_index, recentChapter: recent.chapter_index };
}

// ---------- P3: 时间线管理 ----------

export function saveTimelineEvent(novelId, chapterIdx, storyTime, event) {
  if (!event) return;
  db.prepare('INSERT INTO novel_timeline (novel_id, chapter_index, story_time, event_description) VALUES (?,?,?,?)')
    .run(novelId, chapterIdx, storyTime || '', event);
}

export function formatTimelineSummary(novelId, currentIdx) {
  const rows = db.prepare(`SELECT * FROM novel_timeline WHERE novel_id = ? AND chapter_index < ? ORDER BY chapter_index DESC LIMIT 20`).all(novelId, currentIdx);
  if (!rows.length) return '';
  const lines = rows.reverse().map((r) => {
    const t = r.story_time ? `[${r.story_time}] ` : '';
    return `- 第${r.chapter_index}章 ${t}${r.event_description}`;
  });
  return lines.join('\n');
}

// ---------- 组合：生成前注入 context 的增强记忆块 ----------

export function buildEnhancedMemoryBlock(novelId, currentIdx) {
  const parts = [];

  // P0-1: 分层摘要
  const hierCtx = buildHierarchicalContext(novelId, currentIdx);
  if (hierCtx) parts.push(`【分层摘要树（按距离自动选取摘要层级）】\n${hierCtx}`);

  // P1-1: 结构化事实
  const factsBlock = formatFactsBlock(novelId, currentIdx);
  if (factsBlock) parts.push(`【硬事实库（角色属性/能力/世界状态，创作时必须遵循，发现矛盾须以最新事实为准）】\n${factsBlock}`);

  // P1-2: 角色时间线（最近 30 条变化）
  const tlBlock = formatTimelineBlock(novelId, currentIdx);
  if (tlBlock) parts.push(`【角色成长轨迹（按时间排列的变化记录）】\n${tlBlock}`);

  // P3: 时间线
  const timeBlock = formatTimelineSummary(novelId, currentIdx);
  if (timeBlock) parts.push(`【故事时间线（故事内时间流逝与关键事件）】\n${timeBlock}`);

  // P2-1: 过期待回收伏笔
  const overdue = getOverdueForeshadowings(novelId, currentIdx);
  if (overdue.length) {
    const lines = overdue.map((f) => `- 第${f.chapter_planted}章埋下：${f.description}（预期第${f.expected_recall_chapter}章回收，已逾期！）`);
    parts.push(`【逾期伏笔警告（这些伏笔已超过预期回收章节，本章应优先回收！）】\n${lines.join('\n')}`);
  }

  // P2-2: 文笔漂移
  const drift = getLatestDriftScore(novelId);
  if (drift && drift.drift_score > 0.5) {
    parts.push(`【文风漂移警告（当前漂移分 ${drift.drift_score.toFixed(2)}，请回看早期章节文风，保持一致性）${drift.notes ? '：' + drift.notes : ''}】`);
  }

  return parts.length ? parts.join('\n\n') : '';
}

// ====================================================================
// 质量增强：角色语音 / 小说宪法 / 剧情一致性校验
// ====================================================================

// ---------- 角色语音档案 ----------

export function saveCharacterVoice(novelId, name, voice, chapterIdx) {
  if (!name || !voice) return;
  db.prepare(`INSERT INTO character_voices (novel_id, character_id, character_name, speech_pattern, vocabulary, catchphrases, tone, updated_chapter)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(novel_id, character_name) DO UPDATE SET
                speech_pattern = excluded.speech_pattern,
                vocabulary = excluded.vocabulary,
                catchphrases = excluded.catchphrases,
                tone = excluded.tone,
                updated_chapter = excluded.updated_chapter`)
    .run(novelId, voice.character_id || null, name,
      voice.speech_pattern || '', voice.vocabulary || '',
      voice.catchphrases || '', voice.tone || '', chapterIdx);
}

export function getCharacterVoices(novelId) {
  return db.prepare('SELECT * FROM character_voices WHERE novel_id = ? ORDER BY id').all(novelId);
}

export function formatCharacterVoices(novelId) {
  const rows = getCharacterVoices(novelId);
  if (!rows.length) return '';
  const lines = rows.map((r) => {
    const parts = [r.character_name];
    if (r.speech_pattern) parts.push(`说话方式：${r.speech_pattern}`);
    if (r.vocabulary) parts.push(`惯用词：${r.vocabulary}`);
    if (r.catchphrases) parts.push(`口头禅：${r.catchphrases}`);
    if (r.tone) parts.push(`基调：${r.tone}`);
    return `- ${parts.join('；')}`;
  });
  return lines.join('\n');
}

// ---------- 小说宪法 ----------

export function getConstitution(novelId) {
  return db.prepare('SELECT constitution FROM novels WHERE id = ?').get(novelId)?.constitution || '';
}

export async function buildConstitution(novelId, config) {
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId);
  if (!novel) return '';
  const characters = db.prepare('SELECT name, role_type, personality, background, description FROM characters WHERE novel_id = ?').all(novelId);
  const facts = getActiveFacts(novelId);
  const keyMoments = db.prepare('SELECT content FROM novel_key_moments WHERE novel_id = ? ORDER BY id DESC LIMIT 30').all(novelId);
  const foreshadowings = db.prepare("SELECT content, chapter_index, status FROM foreshadowings WHERE novel_id = ? AND status = 'open'").all(novelId);
  const voices = getCharacterVoices(novelId);
  const maxCh = db.prepare("SELECT MAX(chapter_index) m FROM chapters WHERE novel_id = ? AND content != ''").get(novelId)?.m || 0;

  const charBlock = characters.map((c) => {
    const v = voices.find((v) => v.character_name === c.name);
    return `${c.name}（${c.role_type}）：${c.personality || ''}${v ? `；说话方式：${v.speech_pattern || ''}${v.catchphrases ? '，口头禅：' + v.catchphrases : ''}` : ''}`;
  }).join('\n');

  const factBlock = facts.map((f) => `${f.subject_name}.${f.fact_key} = ${f.fact_value}（第${f.chapter_index}章）`).join('；');

  const kmBlock = keyMoments.map((m) => m.content).join('；');

  const foresBlock = foreshadowings.map((f) => `${f.content}（第${f.chapter_index}章埋）`).join('；');

  const r = await chat({
    config,
    task: 'analysis',
    messages: [
      { role: 'system', content: NOVEL_CONSTITUTION_BUILD_SYSTEM },
      { role: 'user', content: `请根据以下信息为《${novel.title}》编写宪法。\n\n【类型】${novel.genre}\n【世界观】${novel.world_view || ''}\n【大纲】${novel.outline || ''}\n【已写章节数】${maxCh}\n【文风基准】${novel.style_baseline || ''}\n\n【角色信息】\n${charBlock || '（暂无）'}\n\n【硬事实库】\n${factBlock || '（暂无）'}\n\n【关键剧情事实】\n${kmBlock || '（暂无）'}\n\n【未回收伏笔】\n${foresBlock || '（暂无）'}` }
    ],
    maxTokens: 2000
  }).catch(() => null);

  const text = String(r?.content || '').trim();
  if (text) {
    db.prepare("UPDATE novels SET constitution = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(text, novelId);
  }
  return text;
}

// ---------- 剧情一致性校验 ----------

export async function checkPlotConsistency(novelId, chapterIdx, chapterText, config) {
  const novel = db.prepare('SELECT title, genre, world_view, outline FROM novels WHERE id = ?').get(novelId);
  if (!novel) return { issues: [], overall_consistency: 'consistent' };
  const facts = getActiveFacts(novelId);
  const keyMoments = db.prepare('SELECT content FROM novel_key_moments WHERE novel_id = ? ORDER BY id DESC LIMIT 20').all(novelId);
  const voices = getCharacterVoices(novelId);
  const characters = db.prepare('SELECT name, personality, role_type FROM characters WHERE novel_id = ?').all(novelId);

  const factBlock = facts.map((f) => `${f.subject_name}.${f.fact_key} = ${f.fact_value}（第${f.chapter_index}章）`).join('；');
  const kmBlock = keyMoments.map((m) => m.content).join('；');
  const voiceBlock = voices.map((v) => `${v.character_name}：${v.speech_pattern || ''}${v.catchphrases ? '（口头禅：' + v.catchphrases + '）' : ''}`).join('；');
  const charBlock = characters.map((c) => `${c.name}（${c.role_type}）：${c.personality || ''}`).join('\n');

  const r = await chat({
    config,
    task: 'analysis',
    messages: [
      { role: 'system', content: PLOT_CONSISTENCY_CHECK_SYSTEM },
      { role: 'user', content: `【作品】《${novel.title}》${novel.genre}\n【世界观】${novel.world_view || ''}\n\n【角色设定】\n${charBlock || '（暂无）'}\n\n【角色语音档案】\n${voiceBlock || '（暂无）'}\n\n【硬事实库】\n${factBlock || '（暂无）'}\n\n【关键剧情事实】\n${kmBlock || '（暂无）'}\n\n【本章正文（第${chapterIdx}章）】\n${String(chapterText).slice(0, 5000)}` }
    ],
    maxTokens: 1500
  }).catch(() => null);

  const result = extractJsonSafe(r?.content);
  return result || { issues: [], overall_consistency: 'consistent' };
}

function extractJsonSafe(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* */ }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch { /* */ }
  }
  return null;
}
