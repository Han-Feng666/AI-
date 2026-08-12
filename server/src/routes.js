import express from 'express';
import { db, touchNovel, setSetting, getSetting } from './db.js';
import {
  countWords, getLLMConfig, getNovel, getCharacters, getFactions, getRelationships,
  getChapters, getChapter, getMaxChapterIndex, buildHistorySummaries, shouldAutoCompress,
  getRecentChapters, getNovelProgressText, getStyles, getStyle, parseStyleIds,
  parseStylePresets,
  sampleText, getForeshadowings, getOpenForeshadowings, formatForeshadowList,
  getWorldSettings, formatWorldSettings, getChapterBackups,
  getKeyMoments, formatKeyMoments, addKeyMomentUnique,
  getStageMemories, formatStageMemories, upsertStageMemory,
  getCharacterProfiles, upsertCharacterProfile, formatCharacterProfiles,
  scanAiPatterns, blacklistPenalty, blacklistFlagWords,
  parseTxtChapters
} from './lib.js';
import {
  getNovelsRoot, ensureRoot, setNovelsRoot, ensureNovelFolder, novelFolderPath,
  writeChapterTxt, deleteChapterTxt, renameNovelFolder, deleteNovelFolder,
  readMemoryFile, writeMemoryFile
} from './storage.js';
import { chat, contextBudget } from './llm.js';
import {
  getModels, saveModels, getTaskConfig, getActiveModels, genModelId, TASK_TYPES
} from './model_router.js';
import {
  NOVEL_PLAN_SYSTEM, PLAN_SKELETON_SYSTEM, PLAN_CHAPTERS_SYSTEM, PLAN_REVISE_SYSTEM,
  CHAPTER_SYSTEM, CHAPTER_TITLE_SYSTEM,
  CHAPTER_SUMMARY_SYSTEM, POLISH_SYSTEM, STYLE_ANALYZE_SYSTEM,
  CHAT_SYSTEM, COMPRESS_SYSTEM, COMPRESS_UPDATE_SYSTEM,
  FORESHADOW_ANALYZE_SYSTEM, AI_DETECT_SYSTEM, KEY_MOMENTS_SYSTEM, PLAN_ADVANCE_SYSTEM, STAGE_SUMMARY_SYSTEM, CHARACTER_CONSISTENCY_SYSTEM,
  FACT_EXTRACT_SYSTEM, CHAR_CHANGE_EXTRACT_SYSTEM, FORESHADOW_RECALL_PREDICT_SYSTEM, TIMELINE_EXTRACT_SYSTEM, HIERARCHICAL_SUMMARY_SYSTEM,
  CHARACTER_VOICE_EXTRACT_SYSTEM, PLOT_CONSISTENCY_CHECK_SYSTEM, NOVEL_CONSTITUTION_BUILD_SYSTEM,
  CHAPTER_BEAT_SYSTEM, AUTO_SUMMARY_SYSTEM, STYLE_LEARN_APPLY_SYSTEM, NAMEGEN_SYSTEM,
  ARC_PLAN_SYSTEM, WORLD_EXPAND_SYSTEM, EMOTION_CURVE_SYSTEM,
  ADAPTATION_PLAN_SYSTEM, ADAPTATION_CHAPTER_SYSTEM,
  buildNovelContext, buildChapterSystem, buildPolishSystem,
  buildPolishWithIssues, extractJson
} from './prompts.js';
import {
  createJob, updateJob, getJob, listJobsByNovel, getActiveJobByNovel,
  listActiveJobs, tryCreateJob, subscribeJobEvents
} from './jobs.js';
import {
  saveVersion, listVersions, getVersion, getLatestPending,
  acceptVersion as acceptVersionRow, appendChangeLog,
  saveDraft, getDraft, buildSnapshot
} from './planVersions.js';
import { toolRegistry, getToolSchemas } from './tools.js';
import { randomUUID } from 'node:crypto';
import { relationshipRouter, sharedCharactersRouter } from './routes/relationshipAndShared.js';
import { managerMemoryRouter } from './routes/managerMemory.js';
import {
  buildEnhancedMemoryBlock, saveChapterSummary, compressSummariesIfNeeded,
  getActiveFacts, saveFact, checkFactConflicts, formatFactsBlock,
  saveCharacterChange, formatTimelineBlock,
  getOverdueForeshadowings, setExpectedRecall,
  detectStyleDrift, saveTimelineEvent, formatTimelineSummary,
  saveCharacterVoice, getCharacterVoices, formatCharacterVoices,
  getConstitution, buildConstitution, checkPlotConsistency
} from './memory.js';
import { storeChunks, retrieveRelevant, formatRagBlock } from './rag.js';
import {
  createCorpus, getCorpus, listCorpora, deleteCorpus,
  updateCorpusStatus, saveSamples, getSamples, getCorpusAnalysis,
  getKnowledgeByGenres, formatKnowledgeBlock, getSampleSnippets,
  getNovelKnowledgeIds
} from './knowledge_store.js';
import { KNOWLEDGE_LEARN_SYSTEM, KNOWLEDGE_SAMPLE_INTRO } from './prompts.js';
import {
  detectOllama, ollamaListModels, getLocalModelStatus,
  localChat, shouldUseLocal, autoLearnInBackground
} from './local_llm.js';
import { offlineAnalyzeStyle, offlineLearnNovelStyle } from './offline_learn.js';
import {
  startAutoLearn, stopAutoLearn, getAutoLearnStatus,
  triggerPendingTasks, enqueueAutoLearnTask
} from './auto_learn.js';
import { buildNovelKnowledgeGraph, buildKnowledgeGraph, formatKnowledgeGraphBlock } from './knowledge_graph.js';
import { getRagCacheStatus, clearAllRagCache, retrieveRelevantCached } from './rag.js';
import { installOllama, isOllamaInstalled, getInstallStatus, pullModel, getRecommendedModels, startOllamaService } from './ollama_installer.js';
import { localGenerateChapterSmart, installTransformersModel, getTransformersStatus, getBuiltinModels } from './local_llm.js';
import { generateName, generatePlaceName, generateTechniqueName, generateForceName, generateNames, normalizeGenre, getGenreTemplates, generatePersonalityDialog } from './genre_engine.js';
import { webSearch, formatSearchResults, SEARCH_SYSTEM_PROMPT } from './web_search.js';

const router = express.Router();

// Phase 增强 5：把可独立分组路由挂到子文件，主 routes.js 保留业务核心
router.use(sharedCharactersRouter);
router.use(relationshipRouter);
router.use(managerMemoryRouter);

// ---------- SSE helper ----------
function startSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  const ctrl = new AbortController();
  let finished = false;
  let keepaliveTimer = null;
  const stopKeepalive = () => {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  };
  res.on('close', () => {
    stopKeepalive(); // 必须清理心跳定时器，否则流挂起会无限泄漏定时器
    if (!finished && !res.writableEnded) ctrl.abort();
  });
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const end = (obj) => {
    finished = true;
    stopKeepalive();
    if (obj) send(obj);
    if (!res.writableEnded) res.end();
  };
  // keepalive：每 15 秒发心跳注释，防止前端 idle 超时误杀长耗时任务
  keepaliveTimer = setInterval(() => {
    if (!finished && !res.writableEnded) res.write(`:keepalive\n\n`);
  }, 15000);
  return { ctrl, send, end };
}

// ---------- AI 味检测与质量门（铁律模式） ----------
const AI_SCORE_PASS = 30; // 达标阈值：30 以下视为合格的人类文风
const AI_MAX_ROUNDS = 3;  // 质量门最多迭代轮数

// 铁律模式开关（设置项 strict_ai_mode，默认开启）
function strictMode() {
  const v = getSetting('strict_ai_mode', '1');
  return v === '' ? true : v !== '0';
}

function saveDetection(novelId, idx, score, issues, blacklist, source) {
  const scoreInt = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  db.prepare(
    'INSERT INTO ai_detections (novel_id, chapter_index, score, issues, blacklist, source) VALUES (?,?,?,?,?,?)'
  ).run(novelId, idx, scoreInt, JSON.stringify(issues || []), JSON.stringify(blacklist || []), source);
  db.prepare('UPDATE chapters SET ai_score = ? WHERE novel_id = ? AND chapter_index = ?')
    .run(scoreInt, novelId, idx);
}

async function runDetection(config, text) {
  const r = await chat({
    config,
    task: 'analysis',
    messages: [
      { role: 'system', content: AI_DETECT_SYSTEM },
      { role: 'user', content: `请检测以下章节的 AI 痕迹。\n\n${String(text).slice(0, 6000)}` }
    ],
    maxTokens: 2500
  });
  const det = extractJson(r.content) || {};
  return {
    score: Math.max(0, Math.min(100, Number(det.score) || 0)),
    issues: Array.isArray(det.issues)
      ? det.issues.filter((i) => i && i.quote)
      : []
  };
}

// 质量门核心：润色 → 检测 → 未达标再润色（带上轮 issues + 黑名单），直到达标或达轮次上限
async function iteratePolish(config, novel, text, { onStatus, maxRounds = AI_MAX_ROUNDS } = {}) {
  let current = String(text || '').trim();
  let lastDetect = { score: 0, issues: [] };
  let blacklist = [];
  const rounds = [];

  for (let round = 0; round < maxRounds; round++) {
    const hitsBefore = scanAiPatterns(current);
    const flagWords = blacklistFlagWords(hitsBefore);

    if (onStatus) {
      onStatus(round === 0 ? '正在去除 AI 味…' : `检测到 AI 味，正在再润色（第 ${round + 1} 轮）…`);
      if (flagWords.length) onStatus(`命中 AI 高频词：${flagWords.join('、')}，将强制改写…`);
    }

    const pRes = await chat({
      config,
      task: 'writing',
      messages: [
        { role: 'system', content: buildPolishWithIssues(
          getStyles(parseStyleIds(novel)),
          novel.style_baseline,
          novel.style_samples,
          round === 0 ? [] : lastDetect.issues,
          flagWords,
          parseStylePresets(novel)
        ) },
        { role: 'user', content: `以下是一章小说原稿。请按人类写作风格整体改写，彻底去除一切 AI 痕迹，保留剧情与人设。\n\n原稿：\n${current}` }
      ],
      maxTokens: Math.max(4000, Math.min(32000, (current.length + 2000) * 2))
    });
    const polished = (pRes.content || '').trim();
    if (!polished) break;
    current = polished;

    // 检测 + 黑名单硬过滤，合并评分
    let det = { score: 0, issues: [] };
    try { det = await runDetection(config, current); } catch { /* 检测失败不阻塞 */ }
    lastDetect = det;
    const hitsAfter = scanAiPatterns(current);
    blacklist = blacklistFlagWords(hitsAfter);
    const total = Math.min(100, det.score + blacklistPenalty(hitsAfter));
    rounds.push({ round: round + 1, detectScore: det.score, blacklistPenalty: blacklistPenalty(hitsAfter), score: total, blacklist });
    if (onStatus && blacklist.length) onStatus(`仍命中 AI 高频词：${blacklist.join('、')}…`);

    if (total <= AI_SCORE_PASS && blacklist.length === 0) break;
  }
  return { text: current, lastDetect, blacklist, rounds };
}

function requireLLM() {
  const config = getLLMConfig();
  // ollama 本地模型无需 API Key
  if (!config || !config.model || (!config.apiKey && config.provider !== 'ollama')) {
    const e = new Error('尚未配置大模型 API（请先在「设置」中配置 API Key 与模型）');
    e.code = 'NO_LLM';
    return { config: null, error: e };
  }
  return { config, error: null };
}

function runLLMStream(config, messages, { onDelta, ctrl, maxTokens, task } = {}) {
  return chat({
    config,
    task,
    messages,
    maxTokens,
    signal: ctrl.signal,
    onDelta
  });
}

// 续写提示：截取已写末尾，要求紧接续写至自然收尾，不重复内容
function buildContinuePrompt(full, targetWordsN) {
  const tail = String(full).slice(-1500);
  return `以下是一章小说已写部分的末尾节选。请紧接最后一句话继续往下写：不要重复已写内容，不要输出标题，不要总结，自然推进剧情直到本章收尾。

本章目标字数：约 ${targetWordsN} 字（当前已写 ${countWords(full)} 字，请继续写到目标附近并给本章一个自然结尾）

【末尾节选】
${tail}`;
}

// ---------- 长效记忆文件：小说文件夹下的「记忆.txt」 ----------
// 组装全书记忆文本（设定 + 角色 + 每章摘要链），供写入记忆文件
function buildMemoryText(novel) {
  const chars = getCharacters(novel.id);
  const rows = db.prepare("SELECT chapter_index, title, summary FROM chapters WHERE novel_id = ? AND summary != '' ORDER BY chapter_index").all(novel.id);
  const lines = [];
  lines.push(`【作品记忆】《${novel.title || '未命名'}》`);
  lines.push(`类型：${novel.genre || ''}`);
  if (novel.world_view) lines.push(`世界观设定：${novel.world_view}`);
  if (novel.outline) lines.push(`剧情大纲：${novel.outline}`);
  lines.push('主要角色：');
  for (const c of chars) lines.push(`- ${c.name}（${c.role_type}）：${c.personality || c.description || ''}`);
  lines.push('【章节记忆】');
  for (const c of rows) lines.push(`第${c.chapter_index}章 ${c.title}：${c.summary}`);
  return lines.join('\n');
}

// 从 DB 重建记忆文件（方案生成后 / 每章摘要生成后调用）
function refreshMemoryFile(novelId) {
  try {
    const novel = getNovel(novelId);
    if (!novel) return;
    writeMemoryFile(novel, buildMemoryText(novel));
  } catch { /* 记忆文件写入失败不阻塞 */ }
}

// 按上下文预算截断记忆文本：优先保留设定/角色，章节记忆从最老开始丢弃（最近优先）
function trimMemoryToBudget(text, budgetTokens) {
  if (!text || estimateTokens(text) <= budgetTokens) return text;
  const marker = '【章节记忆】';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    return text.slice(0, Math.floor(budgetTokens * 1.3)) + '\n…（记忆过长，已按上下文上限截断）';
  }
  const head = text.slice(0, idx + marker.length);
  const lines = text.slice(idx + marker.length).split('\n').filter(Boolean);
  const kept = [];
  let used = estimateTokens(head);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = estimateTokens(lines[i]);
    if (used + t > budgetTokens) break;
    kept.unshift(lines[i]);
    used += t;
  }
  return head + '\n' + kept.join('\n');
}

// 两条文本的最长公共子串长度（用于伏笔回收的模糊匹配）
function sharedSubstring(a, b) {
  const aa = String(a || '').slice(0, 24);
  const bb = String(b || '').slice(0, 24);
  let best = 0;
  for (let i = 0; i < aa.length; i++) {
    for (let j = 0; j < bb.length; j++) {
      let k = 0;
      while (i + k < aa.length && j + k < bb.length && aa[i + k] === bb[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

// 新增伏笔去重：与已存在的 open 伏笔高度相似则不重复插入，返回是否插入
function insertForeshadowUnique(novelId, content, idx) {
  const dup = getOpenForeshadowings(novelId, 200).find(
    (f) => f.content.includes(content) || content.includes(f.content) || sharedSubstring(content, f.content) >= 4
  );
  if (dup) return null;
  const info = db.prepare('INSERT INTO foreshadowings (novel_id, content, chapter_index) VALUES (?,?,?)').run(novelId, content, idx);
  return db.prepare('SELECT * FROM foreshadowings WHERE id = ?').get(info.lastInsertRowid);
}

// 章节覆盖前备份旧内容，防止误覆盖丢失（生成/润色/重新生成时调用）
function backupChapter(novelId, chapterIndex, reason) {
  const ch = db.prepare("SELECT title, content FROM chapters WHERE novel_id = ? AND chapter_index = ?").get(novelId, chapterIndex);
  if (!ch || !ch.content) return;
  db.prepare(
    'INSERT INTO chapter_backups (novel_id, chapter_index, title, content, reason) VALUES (?,?,?,?,?)'
  ).run(novelId, chapterIndex, ch.title || '', ch.content, reason || '');
  // 每章最多保留 20 个历史版本
  db.prepare(
    `DELETE FROM chapter_backups WHERE novel_id = ? AND chapter_index = ? AND id NOT IN (
      SELECT id FROM chapter_backups WHERE novel_id = ? AND chapter_index = ? ORDER BY id DESC LIMIT 20
    )`
  ).run(novelId, chapterIndex, novelId, chapterIndex);
}

// ---------- 小说 CRUD ----------
router.get('/novels', (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, 
      (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id) AS chapter_count,
      (SELECT COALESCE(SUM(c.word_count),0) FROM chapters c WHERE c.novel_id = n.id) AS total_words,
      (SELECT COUNT(*) FROM characters ch WHERE ch.novel_id = n.id) AS character_count
    FROM novels n ORDER BY n.updated_at DESC
  `).all();
  for (const r of rows) {
    try { r.style_ids = JSON.parse(r.style_ids || '[]'); } catch { r.style_ids = []; }
    try { r.style_presets = parseStylePresets(r); } catch { r.style_presets = []; }
  }
  res.json(rows);
});

router.post('/novels', async (req, res) => {
  const { title = '', genre = '', concept = '', chapterWordCount = 2000, targetChapters = 20, stylePresets = [], knowledgeCorpusIds = [] } = req.body || {};
  const stylePresetsStr = Array.isArray(stylePresets)
    ? stylePresets.map((s) => String(s).trim()).filter(Boolean).join(',')
    : '';
  const knowledgeIdsStr = Array.isArray(knowledgeCorpusIds)
    ? knowledgeCorpusIds.map((id) => Number(id)).filter(Boolean).join(',')
    : '';
  const info = db.prepare(
    'INSERT INTO novels (title, genre, concept, chapter_word_count, target_chapters, style_presets, knowledge_corpus_ids) VALUES (?,?,?,?,?,?,?)'
  ).run(title, genre, concept, chapterWordCount, targetChapters, stylePresetsStr, knowledgeIdsStr);
  const novel = getNovel(info.lastInsertRowid);
  // 创建独立作品文件夹（以小说名命名）
  try {
    await ensureNovelFolder(novel);
  } catch { /* 目录创建失败不阻塞 */ }
  res.json(novel);
});

// TXT 导入：把一本已有小说解析为章节，作为全新小说落库（改编底稿）
router.post('/novels/import-txt', async (req, res) => {
  const { title = '', content = '', genre = '' } = req.body || {};
  const rawTitle = String(title).trim();
  const rawContent = String(content || '');
  if (!rawTitle) return res.status(400).json({ error: '缺少书名' });
  if (!rawContent.trim()) return res.status(400).json({ error: '导入内容为空' });

  const { chapters, splitted } = parseTxtChapters(rawContent);
  if (!chapters.length) return res.status(400).json({ error: '未能从 TXT 中解析出任何章节内容' });

  try {
    // 事务：建 novel + 章节；任何一步失败整体回滚，不残留半成品
    const info = db.prepare(
      'INSERT INTO novels (title, genre, concept, chapter_word_count, target_chapters) VALUES (?,?,?,?,?)'
    ).run(rawTitle, genre || '', `从 TXT 导入：${chapters.length} 章`, 2000, chapters.length);
    const novelId = Number(info.lastInsertRowid);
    const insertChapter = db.prepare(
      'INSERT INTO chapters (novel_id, chapter_index, title, content, summary, word_count) VALUES (?,?,?,?,?,?)'
    );
    const insertAll = db.prepare('BEGIN');
    insertAll.run();
    try {
      chapters.forEach((ch, i) => {
        insertChapter.run(novelId, i + 1, ch.title, ch.content, '', countWords(ch.content));
      });
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
    const novel = getNovel(novelId);
    try { await ensureNovelFolder(novel); } catch { /* 目录失败不阻塞 */ }
    const chs = getChapters(novelId);
    for (const ch of chs) {
      try {
        const full = getChapter(novelId, ch.chapter_index);
        if (full && full.content) await writeChapterTxt(novel, full);
      } catch { /* TXT 副本失败不阻塞 */ }
    }
    return res.json({ novel, splitted, imported: chs.length });
  } catch (e) {
    return res.status(500).json({ error: `TXT 导入失败：${e.message}` });
  }
});

router.get('/novels/:id', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  novel.characters = getCharacters(novel.id);
  novel.factions = getFactions(novel.id);
  novel.relationships = getRelationships(novel.id);
  novel.chapters = getChapters(novel.id);
  novel.foreshadowings = getForeshadowings(novel.id);
  novel.total_words = novel.chapters.reduce((s, c) => s + c.word_count, 0);
  try {
    await ensureNovelFolder(novel);
    novel.folder_path = novelFolderPath(novel);
  } catch { novel.folder_path = null; }
  res.json(novel);
});

router.put('/novels/:id', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const fields = ['title', 'genre', 'concept', 'world_view', 'outline', 'status', 'cover_color', 'style_baseline'];
  const nums = ['chapter_word_count', 'target_chapters'];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  for (const f of nums) {
    if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(Number(req.body[f]) || 0); }
  }
  if (req.body.style_ids !== undefined) {
    sets.push('style_ids = ?');
    vals.push(JSON.stringify(Array.isArray(req.body.style_ids) ? req.body.style_ids : []));
  }
  if (req.body.style_presets !== undefined) {
    sets.push('style_presets = ?');
    vals.push(
      Array.isArray(req.body.style_presets)
        ? req.body.style_presets.map((s) => String(s).trim()).filter(Boolean).join(',')
        : String(req.body.style_presets || '')
    );
  }
  if (req.body.length_class !== undefined) {
    const allowed = ['short', 'medium', 'long'];
    const lc = allowed.includes(String(req.body.length_class)) ? String(req.body.length_class) : 'medium';
    sets.push('length_class = ?');
    vals.push(lc);
  }
  if (req.body.knowledge_corpus_ids !== undefined) {
    sets.push('knowledge_corpus_ids = ?');
    vals.push(
      Array.isArray(req.body.knowledge_corpus_ids)
        ? req.body.knowledge_corpus_ids.map((id) => Number(id)).filter(Boolean).join(',')
        : String(req.body.knowledge_corpus_ids || '')
    );
  }
  if (sets.length) {
    vals.push(req.params.id);
    db.prepare(`UPDATE novels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  // 小说改名：同步重命名本地作品文件夹
  if (req.body.title !== undefined && String(req.body.title).trim() && String(req.body.title).trim() !== novel.title) {
    try {
      await renameNovelFolder(novel, req.body.title);
    } catch { /* 重命名失败不阻塞 */ }
  }
  touchNovel(novel.id);
  res.json(getNovel(novel.id));
});

router.delete('/novels/:id', async (req, res) => {
  const novel = getNovel(req.params.id);
  db.prepare('DELETE FROM novels WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM chapters WHERE novel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM characters WHERE novel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM relationships WHERE novel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM foreshadowings WHERE novel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM world_settings WHERE novel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM chat_messages WHERE novel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM ai_detections WHERE novel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM chapter_backups WHERE novel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM novel_key_moments WHERE novel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM novel_stage_memories WHERE novel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM novel_character_profiles WHERE novel_id = ?').run(req.params.id);
  if (novel) {
    try {
      await deleteNovelFolder(novel);
    } catch { /* 目录清理失败不阻塞 */ }
  }
  res.json({ ok: true });
});

// ---------- 大纲生成（流式） ----------
// 检测尊号/职位型角色名（不是真正的姓名）
const HONORIFIC_WORDS = new Set([
  '掌门','长老','师尊','阁主','城主','将军','老者','少年','少女','船夫',
  '师父','师傅','师伯','师叔','师兄','师姐','师弟','师妹',
  '皇上','陛下','王爷','王妃','皇后','贵妃','太子','公主',
  '大人','太守','县令','知府','巡抚','掌柜','老板','小二','伙计',
  '黑衣人','白衣人','蒙面人','神秘人','少妇','妇人','汉子','书生',
  '大哥','二哥','三哥','大姐','二姐','小弟',
  '父亲','母亲','爷爷','奶奶','叔叔','伯伯','婶婶','婆婆',
]);
const HONORIFIC_SUFFIXES = ['掌门','长老','师尊','阁主','城主','将军','大人','师父','师傅','殿下','陛下'];

function looksLikeHonorific(name) {
  const n = String(name).trim();
  if (!n || n.length > 5) return false;
  if (HONORIFIC_WORDS.has(n)) return true;
  for (const s of HONORIFIC_SUFFIXES) {
    if (n.endsWith(s) && n.length <= s.length + 2) return true;
  }
  return false;
}

async function fixHonorificNames(chars, config) {
  const bad = chars.filter((c) => c && c.name && looksLikeHonorific(c.name));
  if (!bad.length) return chars;
  const prompt = `以下角色名是尊号或职位，不是真正的姓名。请为每个角色取一个正式的中文名字（2-4字），保留角色的性格和背景信息。只输出 JSON 数组，格式：
[{"old_name":"原尊号","new_name":"正式姓名"}]

角色列表：
${bad.map((c) => `- ${c.name}（${c.role_type || '配角'}）：${c.personality || ''} ${c.description || ''}`).join('\n')}`;
  try {
    const r = await chat({ config, messages: [{ role: 'user', content: prompt }], maxTokens: 2048 });
    const fixes = extractJson(r.content);
    if (Array.isArray(fixes)) {
      const map = {};
      for (const f of fixes) { if (f && f.old_name && f.new_name) map[String(f.old_name)] = String(f.new_name); }
      return chars.map((c) => {
        if (c && c.name && map[c.name]) return { ...c, name: map[c.name] };
        return c;
      });
    }
  } catch { /* LLM 补名失败则保留原名 */ }
  return chars;
}

// 应用创作方案（生成或修订共用）：更新小说信息，重建角色/关系/章节规划
async function applyPlan(novel, plan, opts = {}) {
  const words = opts.words || novel.chapter_word_count || 2000;
  const target = opts.target || novel.target_chapters || 20;
  const concept = opts.concept || novel.concept || '';
  const title = String(plan.title || novel.title || '未命名').trim();
  const genreV = String(plan.genre || novel.genre || '').trim();
  const worldView = String(plan.world_view || '').trim();
  const outline = String(plan.outline || '').trim();
  const storyArcs = Array.isArray(plan.story_arcs) ? JSON.stringify(plan.story_arcs) : (novel.story_arcs || null);

  db.prepare('UPDATE novels SET title = ?, genre = ?, world_view = ?, outline = ?, concept = ?, chapter_word_count = ?, target_chapters = ?, status = ?, story_arcs = ? WHERE id = ?')
    .run(title, genreV, worldView, outline, concept, words, target, 'planned', storyArcs, novel.id);

  db.prepare('DELETE FROM relationships WHERE novel_id = ?').run(novel.id);
  db.prepare('DELETE FROM characters WHERE novel_id = ?').run(novel.id);
  db.prepare('DELETE FROM chapters WHERE novel_id = ?').run(novel.id);
  db.prepare('DELETE FROM factions WHERE novel_id = ?').run(novel.id);

  // 保存势力
  let factionMap = {};
  const factions = Array.isArray(plan.factions) ? plan.factions : [];
  for (const f of factions) {
    if (!f || !f.name) continue;
    const info = db.prepare('INSERT INTO factions (novel_id, name, type, description, power_level, territory, leader, stance) VALUES (?,?,?,?,?,?,?,?)')
      .run(novel.id, String(f.name), String(f.type || '帮派'), String(f.description || ''), String(f.power_level || ''), String(f.territory || ''), String(f.leader || ''), String(f.stance || '中立'));
    factionMap[String(f.name)] = info.lastInsertRowid;
  }

  let charMap = {};
  let chars = Array.isArray(plan.characters) ? plan.characters : [];
  // 检测尊号型名字，尝试 LLM 补名
  const llmCfg = getLLMConfig();
  if (llmCfg && llmCfg.apiKey && chars.some((c) => c && c.name && looksLikeHonorific(c.name))) {
    try { chars = await fixHonorificNames(chars, llmCfg); } catch { /* 补名失败保留原名 */ }
    plan = { ...plan, characters: chars };
  }
  for (const c of chars) {
    if (!c || !c.name) continue;
    const factionName = String(c.faction || '');
    const factionId = factionMap[factionName] || null;
    const info = db.prepare('INSERT INTO characters (novel_id, name, role_type, personality, background, description, faction, age, goal, ability) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(novel.id, String(c.name), String(c.role_type || '配角'), String(c.personality || ''), String(c.background || ''), String(c.description || ''), factionName, String(c.age || ''), String(c.goal || ''), String(c.ability || ''));
    charMap[String(c.name)] = info.lastInsertRowid;
  }

  const rels = Array.isArray(plan.relationships) ? plan.relationships : [];
  for (const r of rels) {
    if (!r || !r.a || !r.b) continue;
    const a = charMap[String(r.a)];
    const b = charMap[String(r.b)];
    if (!a || !b) continue;
    db.prepare('INSERT INTO relationships (novel_id, source_id, target_id, relation_type, description) VALUES (?,?,?,?,?)')
      .run(novel.id, a, b, String(r.relation_type || '朋友'), String(r.description || ''));
  }

  const chapters = Array.isArray(plan.chapters) ? plan.chapters : [];
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    db.prepare('INSERT INTO chapters (novel_id, chapter_index, title, summary, content, status) VALUES (?,?,?,?,?,?)')
      .run(novel.id, i + 1, String(ch?.title || `第${i + 1}章`), String(ch?.summary || ''), '', 'planned');
  }

  touchNovel(novel.id);
  const updated = getNovel(novel.id);
  updated.characters = getCharacters(novel.id);
  updated.factions = getFactions(novel.id);
  updated.relationships = getRelationships(novel.id);
  updated.chapters = getChapters(novel.id);
  updated.total_words = updated.chapters.reduce((s, c) => s + c.word_count, 0);
  // 方案已定，初始化小说文件夹下的「记忆.txt」
  refreshMemoryFile(novel.id);
  return updated;
}

// 把方案骨架组装成文本快照（供章节规划阶段作为上下文）
function buildSkeletonBrief(s) {
  const chars = Array.isArray(s.characters)
    ? s.characters.map((c) => `- ${c.name}（${c.role_type || '配角'}）：${c.personality || c.description || ''}${c.faction ? '【' + c.faction + '】' : ''}`).join('\n')
    : '';
  const factions = Array.isArray(s.factions)
    ? s.factions.map((f) => `- ${f.name}（${f.type || '帮派'}）：${f.description || ''}`).join('\n')
    : '';
  const rels = Array.isArray(s.relationships)
    ? s.relationships.map((r) => `- ${r.a} —${r.relation_type || '关系'}→ ${r.b}`).join('\n')
    : '';
  const arcs = Array.isArray(s.story_arcs)
    ? s.story_arcs.map((a) => `- ${a.name}（${a.type || '主线'}，${a.chapter_range || ''}）：${a.description || ''}`).join('\n')
    : '';
  return `书名：${s.title || '未命名'}
类型：${s.genre || ''}
世界观：
${s.world_view || ''}
剧情大纲：
${s.outline || ''}
剧情弧线：
${arcs || '（无）'}
势力：
${factions || '（无）'}
角色：
${chars}
人物关系：
${rels}`;
}

// 把当前方案组装成文本快照（供修订时作为上下文）
function buildPlanSnapshot(novel) {
  const chars = getCharacters(novel.id);
  const factions = getFactions(novel.id);
  const rels = getRelationships(novel.id);
  const chapters = getChapters(novel.id).filter((c) => !c.content);
  const nameMap = {};
  for (const c of chars) nameMap[c.id] = c.name;
  const lines = [];
  lines.push(`书名：${novel.title || '未命名'}`);
  lines.push(`类型：${novel.genre || ''}`);
  const presets = parseStylePresets(novel);
  if (presets.length) lines.push(`创作风格：${presets.join('、')}`);
  lines.push(`世界观设定：\n${novel.world_view || ''}`);
  lines.push(`剧情大纲：\n${novel.outline || ''}`);
  if (novel.story_arcs && novel.story_arcs.length) {
    lines.push('剧情弧线：');
    for (const a of novel.story_arcs) lines.push(`- ${a.name}（${a.type || '主线'}，${a.chapter_range || ''}）：${a.description || ''}`);
  }
  if (factions.length) {
    lines.push('势力：');
    for (const f of factions) lines.push(`- ${f.name}（${f.type}）：${f.description || ''}`);
  }
  lines.push('角色：');
  for (const c of chars) lines.push(`- ${c.name}（${c.role_type}）：${c.personality || c.description || ''}${c.faction ? '【' + c.faction + '】' : ''}${c.goal ? ' 目标：' + c.goal : ''}`);
  lines.push('人物关系：');
  for (const r of rels) {
    lines.push(`- ${nameMap[r.source_id] || '?'} —${r.relation_type}→ ${nameMap[r.target_id] || '?'}${r.description ? '：' + r.description : ''}`);
  }
  lines.push(`章节规划（共 ${chapters.length} 章）：`);
  for (const c of chapters) lines.push(`- 第${c.chapter_index}章 ${c.title}：${c.summary || ''}`);
  return lines.join('\n');
}

// 生成创作方案（初稿）
router.post('/novels/:id/plan', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { concept, genre, chapterWordCount, targetChapters, stylePresets, lengthClass } = req.body || {};
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  // Job 化：拒绝同节段并发新建
  const jobTry = tryCreateJob(novel.id, 'plan', { concept, genre, chapterWordCount, targetChapters, lengthClass });
  if (jobTry.conflict) {
    return res.status(409).json({ error: '该小说已有进行中的方案生成任务', jobId: jobTry.jobId });
  }
  const job = jobTry.job;

  const { ctrl, send, end } = startSSE(req, res);
  send({ type: 'job', jobId: job.id, stage: 'plan' });
  send({ type: 'progress', progress: 5, message: '正在初始化…' });
  updateJob(job.id, { progress: 5 });

  // 重新生成方案会重建全部章节/角色/关系，旧伏笔指向已失效，一并清空
  db.prepare('DELETE FROM foreshadowings WHERE novel_id = ?').run(novel.id);

  const target = Math.max(1, Math.min(2000, Number(targetChapters) || novel.target_chapters || 20));
  const words = Number(chapterWordCount) || novel.chapter_word_count || 2000;
  const presets = Array.isArray(stylePresets)
    ? stylePresets.map((s) => String(s).trim()).filter(Boolean)
    : parseStylePresets(novel);

  const userPrompt = `用户的灵感想法：${concept || novel.concept || ''}
类型：${genre || novel.genre || '不限（请根据内容判断）'}
创作风格：${presets.length ? presets.join('、') : '由你判断，选择适合该题材的风格基调'}
计划章节数：${target} 章
每章目标字数：${words} 字

请输出创作方案骨架 JSON。`;

  if (presets.length) {
    db.prepare('UPDATE novels SET style_presets = ? WHERE id = ?').run(presets.join(','), novel.id);
  }
  if (lengthClass) {
    const allowed = ['short', 'medium', 'long'];
    const lc = allowed.includes(String(lengthClass)) ? String(lengthClass) : 'medium';
    db.prepare('UPDATE novels SET length_class = ? WHERE id = ?').run(lc, novel.id);
  }

  const maxOut = Math.max(4096, Number(config.maxTokens) || 8192);

  // 流式生成并把内容透传给前端（进度可见），返回完整文本
  // 单批次 idle 超时：5 分钟无数据则判定超时
  const streamCollect = async (messages, label) => {
    let full = '';
    send({ type: 'status', message: label });
    await runLLMStream(config, messages, {
      ctrl,
      task: 'planning',
      maxTokens: maxOut,
      onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
    });
    return full;
  };

  // 指数退避
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 流式生成 + 解析 JSON，最多重试 5 次（流式 + 非流式交替 + 指数退避）
  // 重试时追加格式强化提示，降低格式出错率
  const FORMAT_REMINDER = '\n\n【重要提醒】你之前的输出无法被解析为 JSON。请严格只输出一个 JSON 对象/数组，不要输出任何说明文字、markdown 代码块标记（```）、注释或多余字符。确保所有字符串值中的双引号用 \\" 转义，换行用 \\n 转义。';
  const jsonFrom = async (messages, label) => {
    let lastText = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) {
        const waitSec = Math.pow(2, attempt - 1); // 2s, 4s, 8s, 16s
        send({ type: 'status', message: `AI 返回格式异常，第 ${attempt} 次重试（等待 ${waitSec}s 后重试）…` });
        await sleep(waitSec * 1000);
      }
      // 重试时追加格式强化提示
      const useMessages = attempt > 1
        ? messages.map((m) => m.role === 'user' ? { ...m, content: m.content + FORMAT_REMINDER } : m)
        : messages;
      try {
        lastText = await streamCollect(useMessages, attempt === 1 ? label : `${label}（重试 ${attempt}，已强化格式要求）`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // 流式失败，尝试非流式
        send({ type: 'status', message: `流式请求失败，正在用非流式重试（第 ${attempt} 次）…` });
        try {
          const retry = await chat({ config, messages: useMessages, maxTokens: maxOut });
          lastText = retry?.content || '';
        } catch (e2) {
          if (e2.name === 'AbortError') throw e2;
          send({ type: 'status', message: `第 ${attempt} 次重试失败：${e2.message}，继续重试…` });
          lastText = '';
        }
      }
      const obj = extractJson(lastText);
      if (obj) return obj;
      // 记录解析失败的原始内容片段，便于排查
      if (attempt < 5) {
        const preview = lastText.slice(0, 120).replace(/\n/g, ' ');
        send({ type: 'status', message: `解析失败（返回内容开头：${preview}…），将重试…` });
      }
    }
    return null;
  };

  // 章节生成降级：批次解析失败后，基于大纲自动生成占位章节，保证不中断
  const generateFallbackChapters = (start, end, brief) => {
    const chapters = [];
    for (let i = start; i <= end; i++) {
      chapters.push({
        title: `第${i}章`,
        summary: `（自动生成占位）根据大纲推进剧情，具体内容在创作时补充。`
      });
    }
    return chapters;
  };

  try {
    // 无总超时上限：只要模型持续返回数据就继续生成
    // 只用 per-batch idle timeout（runLLMStream 内部的 idle timer 已实现）
    const estimatedBatches = Math.ceil(target / 30);
    send({ type: 'status', message: `开始生成方案（目标 ${target} 章，预计 ${estimatedBatches} 批，无总超时限制，逐批完成）…` });
    send({ type: 'progress', progress: 8, message: '正在构思世界观、角色与剧情大纲…' });

    // 注入知识学习库分析
    const knowledgeIds = getNovelKnowledgeIds(novel);
    const knowledgeBlock = formatKnowledgeBlock(knowledgeIds);
    if (knowledgeBlock) {
      send({ type: 'status', message: '已加载知识学习库参考，正在生成方案…' });
    }

    // 阶段 1：作品骨架
    let skeleton = await jsonFrom(
      [
        { role: 'system', content: PLAN_SKELETON_SYSTEM + knowledgeBlock },
        { role: 'user', content: userPrompt }
      ],
      '正在构思世界观、角色与剧情大纲…'
    );
    if (!skeleton) {
      // 骨架降级：基于用户输入生成基础骨架
      send({ type: 'status', message: '骨架解析失败 5 次，正在生成基础骨架…' });
      skeleton = {
        title: (concept || '未命名小说').slice(0, 20),
        genre: genre || '通用',
        world_view: '（待补充）',
        outline: concept || '（待补充）',
        characters: [],
        relationships: [],
        chapters: []
      };
      send({ type: 'status', message: '已生成基础骨架，继续规划章节…' });
    }
    send({ type: 'progress', progress: 30, message: '骨架已生成，正在规划章节…' });
    updateJob(job.id, { progress: 30, stream_cursor: '骨架已生成，正在规划章节…' });

    // 阶段 2：章节规划（分批，每批 30 章，失败自动降级不中断）
    const skeletonChapters = Array.isArray(skeleton.chapters)
      ? skeleton.chapters.filter((c) => c && c.title).map((c) => ({ title: String(c.title), summary: String(c.summary || '') }))
      : [];
    const allChapters = skeletonChapters.slice(0, target);
    const brief = buildSkeletonBrief(skeleton);

    if (allChapters.length < target) {
      let start = allChapters.length + 1;
      let consecutiveFallbacks = 0;
      const MAX_CONSECUTIVE_FALLBACKS = 3;

      while (start <= target) {
        const batchEnd = Math.min(target, start + 29);
        const batchSize = batchEnd - start + 1;

        const batch = await jsonFrom(
          [
            { role: 'system', content: PLAN_CHAPTERS_SYSTEM },
            { role: 'user', content: `作品骨架：\n${brief}\n\n计划章节数：${target} 章。\n请规划第 ${start} 至第 ${batchEnd} 章的标题与剧情概要（共 ${batchSize} 章），必须完整覆盖此编号范围。` }
          ],
          `正在规划章节 ${start}-${batchEnd}（已完成 ${allChapters.length}/${target}）…`
        );

        const list = Array.isArray(batch) ? batch : (Array.isArray(batch?.chapters) ? batch.chapters : []);
        const clean = list
          .filter((c) => c && (c.title || c.summary))
          .map((c) => ({ title: String(c.title || `第${start}章`), summary: String(c.summary || '') }));

        if (!clean.length) {
          // 降级：生成占位章节，不中断
          consecutiveFallbacks++;
          send({ type: 'status', message: `章节规划（${start}-${batchEnd}）解析失败 5 次，已自动生成占位章节（降级 ${consecutiveFallbacks}/${MAX_CONSECUTIVE_FALLBACKS}）。` });
          const fallback = generateFallbackChapters(start, batchEnd, brief);
          allChapters.push(...fallback);

          if (consecutiveFallbacks >= MAX_CONSECUTIVE_FALLBACKS) {
            send({ type: 'status', message: '连续 3 批降级，剩余章节将全部使用占位生成。建议生成完成后用修订功能补充。' });
            // 剩余全部占位
            const remainingStart = batchEnd + 1;
            if (remainingStart <= target) {
              const remaining = generateFallbackChapters(remainingStart, target, brief);
              allChapters.push(...remaining);
            }
            break;
          }
        } else {
          consecutiveFallbacks = 0; // 成功则重置
          allChapters.push(...clean);
        }

        start = batchEnd + 1;
        const pct = 30 + Math.round((allChapters.length / target) * 65);
        send({ type: 'progress', progress: pct, message: `已规划 ${allChapters.length}/${target} 章` });
        updateJob(job.id, { progress: pct, word_count: allChapters.length, stream_cursor: `已规划 ${allChapters.length}/${target} 章` });

        // 保存中间进度到 job
        if (allChapters.length % 60 === 0) {
          send({ type: 'status', message: `进度：${allChapters.length}/${target} 章（${Math.round((allChapters.length / target) * 100)}%）` });
        }
      }
    }

    const plan = { ...skeleton, chapters: allChapters.slice(0, target) };
    send({ type: 'progress', progress: 96, message: '正在应用方案到小说…' });
    const result = await applyPlan(novel, plan, { words, target, concept });
    send({ type: 'progress', progress: 100, message: '方案生成完成' });
    updateJob(job.id, { status: 'done', progress: 100, result_ref: String(novel.id) });
    return end({ type: 'done', data: { novel: result, jobId: job.id, totalChapters: allChapters.length } });
  } catch (e) {
    const userAborted = e.name === 'AbortError' && ctrl.signal.aborted;
    if (userAborted) {
      updateJob(job.id, { status: 'aborted', error: e.message });
      return end({ type: 'aborted', message: '已停止生成' });
    }
    updateJob(job.id, { status: 'failed', error: e.message });
    return end({ type: 'error', message: e.message });
  }
});

// 策划模式：按用户反馈修订创作方案（可多轮）
router.post('/novels/:id/plan/revise', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const feedback = String((req.body || {}).feedback || '').trim();
  if (!feedback) return res.status(400).json({ error: '请先填写修改意见' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const jobTry = tryCreateJob(novel.id, 'revise', { feedback });
  if (jobTry.conflict) {
    return res.status(409).json({ error: '该小说已有进行中的方案修订任务', jobId: jobTry.jobId });
  }
  const job = jobTry.job;

  const { ctrl, send, end } = startSSE(req, res);
  send({ type: 'job', jobId: job.id, stage: 'revise' });
  send({ type: 'progress', progress: 10, message: '正在按你的意见修订方案…' });
  send({ type: 'status', message: '正在按你的意见修订方案…' });
  updateJob(job.id, { progress: 10 });

  const maxOut = Math.max(4096, Number(config.maxTokens) || 8192);
  const snapshot = buildPlanSnapshot(novel);
  // REQ-02：注入"不可变锚点"——列出当前已采纳方案的角色名表与章节标题表
  const curChars = getCharacters(novel.id).map((c) => c.name).filter(Boolean);
  const curChapters = getChapters(novel.id).map((c) => `第${c.chapter_index}章 ${c.title}`);
  const anchor = `\n\n【不可变锚点】\n当前角色名清单：${curChars.length ? curChars.join('、') : '（无）'}\n当前章节标题清单：${curChapters.length ? curChapters.join('；') : '（无）'}\n（用户未明确提及替换的角色名/章节标题 MUST 保持不变。）`;

  const userPrompt = `以下是当前的小说创作方案：

${snapshot}${anchor}

用户提出的修改意见（请据此修订；除用户明确指明的改动外，其他字段 MUST 保持原样，绝不让角色改名或主线错位）：
${feedback}

请输出修订后的完整创作方案 JSON，字段与结构必须与当前方案完全一致：{"title": "...", "genre": "...", "world_view": "...", "outline": "...", "characters": [{"name": "...", "role_type": "...", "personality": "...", "background": "...", "description": "...", "faction": "...", "goal": "...", "ability": "..."}], "factions": [{"name": "...", "type": "...", "description": "..."}], "relationships": [{"a": "角色名", "b": "角色名", "relation_type": "朋友", "description": "..."}], "chapters": [{"title": "...", "summary": "..."}]}`;

  try {
    let full = '';
    await runLLMStream(config, [
      { role: 'system', content: PLAN_REVISE_SYSTEM },
      { role: 'user', content: userPrompt }
    ], {
      ctrl,
      maxTokens: maxOut,
      onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
    });

    const plan = extractJson(full);
    if (!plan) {
      updateJob(job.id, { status: 'failed', error: 'AI 返回内容无法解析为方案', stream_cursor: full });
      // REQ-01 AC3：不进重试死循环，一次失败即告知用户，旧版方案保留不变
      return end({ type: 'error', message: 'AI 返回的内容无法解析为方案，当前方案保留不变。原始输出已附在返回内 raw 字段，可参考后重试。', raw: full });
    }
    // Phase3：写候选版本，不直接落库；用户在前端 diff 视图点"采纳"才落库
    const snapshot = { ...plan };
    try { snapshot.title = String(snapshot.title || novel.title); snapshot.genre = String(snapshot.genre || novel.genre); } catch { /* ignore */ }
    send({ type: 'progress', progress: 95, message: '正在生成候选方案…' });
    const version = saveVersion(novel.id, snapshot, 'revise', feedback);
    send({ type: 'progress', progress: 100, message: '修订完成' });
    updateJob(job.id, { progress: 95 });
    appendChangeLog(novel.id, null, version.version_no, feedback, '候选方案生成');
    updateJob(job.id, { status: 'done', progress: 100, result_ref: String(version.id) });
    return end({ type: 'done', data: { novel, version, jobId: job.id } });
  } catch (e) {
    if (e.name === 'AbortError') {
      updateJob(job.id, { status: 'aborted', error: e.message });
      return end({ type: 'aborted', message: '已停止生成' });
    }
    updateJob(job.id, { status: 'failed', error: e.message });
    return end({ type: 'error', message: e.message });
  }
});

// ===== 整本改编：生成改编方案（SSE） =====
router.post('/novels/:id/adaptation/plan', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const intent = String((req.body || {}).intent || '').trim();
  if (!intent) return res.status(400).json({ error: '请先描述改编意图' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  // 检查是否有进行中的改编任务（plan 生成中 或 adapting 中）
  const activeJob = db.prepare(
    "SELECT id FROM adaptation_jobs WHERE novel_id = ? AND status IN ('drafting_plan','adapting') ORDER BY id DESC LIMIT 1"
  ).get(novel.id);
  if (activeJob) {
    return res.status(409).json({ error: '该小说已有进行中的改编任务', jobId: activeJob.id });
  }

  const info = db.prepare(
    "INSERT INTO adaptation_jobs (novel_id, intent, status, total_chapters) VALUES (?,?,?,?)"
  ).run(novel.id, intent, 'drafting_plan', getChapters(novel.id).length);
  const jobId = Number(info.lastInsertRowid);

  const { ctrl, send, end } = startSSE(req, res);
  send({ type: 'job', jobId, stage: 'adaptation_plan' });
  send({ type: 'progress', progress: 10, message: '正在根据你的改编意图生成改编方案…' });
  send({ type: 'status', message: '正在根据你的改编意图生成改编方案…' });
  db.prepare('UPDATE adaptation_jobs SET updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(jobId);

  const chs = db.prepare("SELECT chapter_index, title FROM chapters WHERE novel_id = ? AND content != '' ORDER BY chapter_index").all(novel.id);
  const chapterList = chs.map((c) => `第${c.chapter_index}章 ${c.title}`).join('\n');

  const userPrompt = `以下是待改编的小说章节清单：\n\n${chapterList || '（无章节）'}\n\n用户的改编意图：\n${intent}\n\n请输出完整的改编方案 JSON。`;

  try {
    let full = '';
    await runLLMStream(config, [
      { role: 'system', content: ADAPTATION_PLAN_SYSTEM },
      { role: 'user', content: userPrompt }
    ], {
      ctrl,
      task: 'planning',
      maxTokens: Math.max(4096, Number(config.maxTokens) || 8192),
      onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
    });

    const plan = extractJson(full);
    if (!plan) {
      db.prepare("UPDATE adaptation_jobs SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?").run('AI 返回内容无法解析为改编方案', jobId);
      return end({ type: 'error', message: 'AI 返回的内容无法解析为改编方案，请重试。原始输出已附在 raw 字段。', raw: full });
    }
    db.prepare("UPDATE adaptation_jobs SET plan = ?, status = 'plan_ready', updated_at = datetime('now','localtime') WHERE id = ?").run(JSON.stringify(plan), jobId);
    send({ type: 'progress', progress: 100, message: '改编方案已生成' });
    return end({ type: 'done', data: { jobId, plan } });
  } catch (e) {
    if (e.name === 'AbortError') {
      db.prepare("UPDATE adaptation_jobs SET status = 'aborted', updated_at = datetime('now','localtime') WHERE id = ?").run(jobId);
      return end({ type: 'aborted', message: '已停止生成' });
    }
    db.prepare("UPDATE adaptation_jobs SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(e.message, jobId);
    return end({ type: 'error', message: e.message });
  }
});

// 获取当前改编任务状态（含全部候选），供刷新/切书后恢复进度
router.get('/novels/:id/adaptation', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const job = db.prepare(
    "SELECT * FROM adaptation_jobs WHERE novel_id = ? ORDER BY id DESC LIMIT 1"
  ).get(novel.id);
  if (!job) return res.json({ job: null, candidates: [] });
  let plan = null;
  try { plan = job.plan ? JSON.parse(job.plan) : null; } catch { plan = null; }
  const candidates = db.prepare(
    'SELECT * FROM adaptation_candidates WHERE job_id = ? ORDER BY chapter_index'
  ).all(job.id);
  return res.json({ job: { ...job, plan }, candidates });
});

// 开始逐章改编（用户在方案确认后调用）
router.post('/novels/:id/adaptation/start', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const job = db.prepare(
    "SELECT * FROM adaptation_jobs WHERE novel_id = ? AND status = 'plan_ready' ORDER BY id DESC LIMIT 1"
  ).get(novel.id);
  if (!job) return res.status(409).json({ error: '没有待开始的改编方案' });
  db.prepare("UPDATE adaptation_jobs SET status = 'adapting', current_index = 0, updated_at = datetime('now','localtime') WHERE id = ?").run(job.id);
  res.json({ ok: true, jobId: job.id });
});

// 生成当前章的候选内容（SSE）：取该章原文 + 意图 + 方案要点 + 前 N 章已采纳摘要
router.post('/novels/:id/adaptation/next', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const job = db.prepare(
    "SELECT * FROM adaptation_jobs WHERE novel_id = ? AND status = 'adapting' ORDER BY id DESC LIMIT 1"
  ).get(novel.id);
  if (!job) return res.status(409).json({ error: '当前没有进行中的改编任务' });

  const allChs = db.prepare("SELECT chapter_index, title, content FROM chapters WHERE novel_id = ? AND content != '' ORDER BY chapter_index").all(novel.id);
  if (!allChs.length) return res.status(400).json({ error: '小说没有可改编的章节' });
  const total = allChs.length;
  let currentIndex = Number(job.current_index) || 0;

  // 找到下一个待改编章节：优先处理 retrying/failed 状态的候选，否则选未生成候选的章
  const existing = db.prepare('SELECT chapter_index, status FROM adaptation_candidates WHERE job_id = ?').all(job.id);
  const existingMap = new Map(existing.map((c) => [c.chapter_index, c.status]));
  let target = null;
  // 1) 优先 retrying / failed 的章
  for (const [idx, status] of existingMap) {
    if (status === 'retrying' || status === 'failed') {
      const ch = allChs.find((c) => c.chapter_index === idx);
      if (ch) { target = ch; break; }
    }
  }
  // 2) 否则找未生成候选的章
  if (!target) {
    for (const ch of allChs) {
      if (!existingMap.has(ch.chapter_index)) { target = ch; break; }
    }
  }
  if (!target) {
    db.prepare("UPDATE adaptation_jobs SET status = 'done', updated_at = datetime('now','localtime') WHERE id = ?").run(job.id);
    return res.status(400).json({ error: '所有章节均已生成候选，请采纳/跳过处理' });
  }

  let plan = null;
  try { plan = job.plan ? JSON.parse(job.plan) : null; } catch { plan = null; }
  const chapterAction = (plan?.chapters || []).find((c) => c.chapter_index === target.chapter_index);
  const globalNotes = plan?.global_notes || '';

  // 前 N 章已采纳摘要（滚动上下文保证连贯性）
  const acceptedChs = db.prepare(
    "SELECT chapter_index, candidate_content FROM adaptation_candidates WHERE job_id = ? AND status = 'accepted' ORDER BY chapter_index"
  ).all(job.id).slice(-5);
  const adoptedSummaries = acceptedChs.map((c) => `第${c.chapter_index}章：${String(c.candidate_content).slice(0, 400)}`).join('\n\n');

  const { ctrl, send, end } = startSSE(req, res);
  send({ type: 'job', jobId: job.id, stage: 'adaptation_chapter', chapterIndex: target.chapter_index });
  send({ type: 'progress', progress: Math.round((currentIndex / total) * 100), message: `正在改编第 ${target.chapter_index}/${total} 章…` });
  send({ type: 'status', message: `正在改编第 ${target.chapter_index}/${total} 章…` });

  const userPrompt = `【本章原文】\n第${target.chapter_index}章 ${target.title}\n\n${target.content}

【改编意图】${job.intent}

【全局改编说明】${globalNotes || '（无）'}

【本章改造要点】${chapterAction ? chapterAction.actions.map((a) => `- ${a}`).join('\n') : '（无，按意图自然改编）'}

【已采纳前情摘要】${adoptedSummaries || '（无）'}

请按改编方案改写本章。`;

  try {
    let full = '';
    await runLLMStream(config, [
      { role: 'system', content: ADAPTATION_CHAPTER_SYSTEM },
      { role: 'user', content: userPrompt }
    ], {
      ctrl,
      task: 'writing',
      maxTokens: Math.max(6000, Math.min(32000, (target.content.length + 4000) * 2)),
      onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
    });

    const candidateContent = full.trim();
    if (!candidateContent) {
      db.prepare("UPDATE adaptation_jobs SET failed_count = failed_count + 1, updated_at = datetime('now','localtime') WHERE id = ?").run(job.id);
      return end({ type: 'error', message: 'AI 未返回内容，请重试该章。' });
    }

    // 写入候选（唯一索引 (job_id, chapter_index)，重复则更新）
    db.prepare(
      `INSERT INTO adaptation_candidates (novel_id, job_id, chapter_index, original_title, original_content, candidate_title, candidate_content, status)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(job_id, chapter_index) DO UPDATE SET candidate_title = excluded.candidate_title, candidate_content = excluded.candidate_content, status = 'pending', error = ''`
    ).run(
      novel.id, job.id, target.chapter_index, target.title, target.content,
      target.title, candidateContent, 'pending'
    );
    db.prepare("UPDATE adaptation_jobs SET current_index = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(target.chapter_index, job.id);
    send({ type: 'progress', progress: Math.round(((target.chapter_index) / total) * 100), message: `第 ${target.chapter_index} 章候选已生成` });

    const cand = db.prepare("SELECT * FROM adaptation_candidates WHERE job_id = ? AND chapter_index = ?").get(job.id, target.chapter_index);
    return end({ type: 'done', data: { jobId: job.id, candidate: cand, total, current: target.chapter_index } });
  } catch (e) {
    if (e.name === 'AbortError') return end({ type: 'aborted', message: '已停止' });
    db.prepare("UPDATE adaptation_jobs SET failed_count = failed_count + 1, updated_at = datetime('now','localtime') WHERE id = ?").run(job.id);
    return end({ type: 'error', message: e.message });
  }
});

// 候选：采纳（写入正式章节）
router.post('/adaptation-candidates/:cid/accept', async (req, res) => {
  const cand = db.prepare('SELECT * FROM adaptation_candidates WHERE id = ?').get(Number(req.params.cid));
  if (!cand) return res.status(404).json({ error: '候选不存在' });
  const novel = getNovel(cand.novel_id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });

  backupChapter(novel.id, cand.chapter_index, '整本改编');
  db.prepare('UPDATE chapters SET title = ?, content = ?, word_count = ?, updated_at = datetime(\'now\',\'localtime\') WHERE novel_id = ? AND chapter_index = ?')
    .run(cand.candidate_title || cand.original_title, cand.candidate_content, countWords(cand.candidate_content), novel.id, cand.chapter_index);
  touchNovel(novel.id);
  db.prepare("UPDATE adaptation_candidates SET status = 'accepted' WHERE id = ?").run(cand.id);
  db.prepare("UPDATE adaptation_jobs SET accepted_count = accepted_count + 1, current_index = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(cand.chapter_index, cand.job_id);

  // 同步 TXT 副本 + 生成章节摘要（尽力而为）
  try {
    const full = getChapter(novel.id, cand.chapter_index);
    if (full) await writeChapterTxt(novel, full);
  } catch { /* 不阻塞 */ }
  try {
    const c = cand.candidate_content || '';
    const sentences = String(c).split(/[。！？\n]/).filter((s) => s.trim().length > 10);
    const picks = [];
    if (sentences.length > 0) picks.push(sentences[0].trim());
    if (sentences.length > 4) picks.push(sentences[Math.floor(sentences.length * 0.3)].trim());
    if (sentences.length > 8) picks.push(sentences[Math.floor(sentences.length * 0.6)].trim());
    if (sentences.length > 2) picks.push(sentences[sentences.length - 1].trim());
    const summary = picks.join('。') + '。';
    if (summary) {
      db.prepare('UPDATE chapters SET summary = ? WHERE id = ?').run(summary, getChapter(novel.id, cand.chapter_index).id);
    }
  } catch { /* 不阻塞 */ }

  return res.json({ ok: true, chapter: getChapter(novel.id, cand.chapter_index) });
});

// 候选：跳过（保留原文）
router.post('/adaptation-candidates/:cid/skip', async (req, res) => {
  const cand = db.prepare('SELECT * FROM adaptation_candidates WHERE id = ?').get(Number(req.params.cid));
  if (!cand) return res.status(404).json({ error: '候选不存在' });
  db.prepare("UPDATE adaptation_candidates SET status = 'skipped' WHERE id = ?").run(cand.id);
  db.prepare("UPDATE adaptation_jobs SET skipped_count = skipped_count + 1, updated_at = datetime('now','localtime') WHERE id = ?").run(cand.job_id);
  return res.json({ ok: true });
});

// 候选：重试（重新生成该章候选）
router.post('/adaptation-candidates/:cid/retry', async (req, res) => {
  const cand = db.prepare('SELECT * FROM adaptation_candidates WHERE id = ?').get(Number(req.params.cid));
  if (!cand) return res.status(404).json({ error: '候选不存在' });
  db.prepare("UPDATE adaptation_candidates SET status = 'retrying', error = '' WHERE id = ?").run(cand.id);
  // 重试 = 回到该章重新生成；前端随后调用 /adaptation/next 时用 job.current_index 回退该章
  db.prepare("UPDATE adaptation_jobs SET current_index = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(Math.max(0, cand.chapter_index - 1), cand.job_id);
  return res.json({ ok: true, candidateId: cand.id });
});

// 导出全书（Markdown 文本）
router.get('/novels/:id/export', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const chapters = db.prepare("SELECT chapter_index, title, content FROM chapters WHERE novel_id = ? AND content != '' ORDER BY chapter_index").all(novel.id);
  const parts = [];
  parts.push(`《${novel.title || '未命名'}》`);
  parts.push(`类型：${novel.genre || ''}`);
  if (novel.world_view) parts.push(`\n【世界观设定】\n${novel.world_view}`);
  if (novel.outline) parts.push(`\n【剧情大纲】\n${novel.outline}`);
  for (const c of chapters) {
    parts.push(`\n\n# 第${c.chapter_index}章 ${c.title || ''}\n\n${c.content}`);
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(parts.join('\n'));
});

// ---------- 章节 ----------
router.get('/novels/:id/chapters', (req, res) => {
  res.json(getChapters(req.params.id));
});

router.get('/novels/:id/chapters/:idx', (req, res) => {
  const ch = getChapter(req.params.id, Number(req.params.idx));
  if (!ch) return res.status(404).json({ error: '章节不存在' });
  res.json(ch);
});

router.put('/novels/:id/chapters/:idx', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const idx = Number(req.params.idx);
  const ch = getChapter(novel.id, idx);
  if (!ch) return res.status(404).json({ error: '章节不存在' });
  const { title, content } = req.body || {};
  const newTitle = title !== undefined ? title : ch.title;
  const newContent = content !== undefined ? content : ch.content;
  db.prepare('UPDATE chapters SET title = ?, content = ?, word_count = ?, status = ? WHERE id = ?')
    .run(newTitle, newContent, countWords(newContent), newContent ? 'draft' : ch.status, ch.id);
  touchNovel(novel.id);
  try {
    await writeChapterTxt(novel, { chapter_index: idx, title: newTitle, content: newContent });
  } catch { /* 文件写入失败不阻塞 */ }
  res.json(getChapter(novel.id, idx));
});

router.delete('/novels/:id/chapters/:idx', async (req, res) => {
  db.prepare('DELETE FROM chapters WHERE novel_id = ? AND chapter_index = ?').run(req.params.id, Number(req.params.idx));
  touchNovel(req.params.id);
  try {
    await deleteChapterTxt(getNovel(req.params.id), Number(req.params.idx));
  } catch { /* 文件清理失败不阻塞 */ }
  res.json({ ok: true });
});

// 生成/续写章节（流式）
router.post('/novels/:id/chapters/generate', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const { mode = 'next', chapterIndex, targetWords, overrideTitle } = req.body || {};
  const { ctrl, send, end } = startSSE(req, res);

  let idx;
  if (mode === 'regenerate') {
    idx = Number(chapterIndex);
  } else {
    // 优先填充空内容的占位章节
    const firstEmpty = db.prepare("SELECT chapter_index FROM chapters WHERE novel_id = ? AND content = '' ORDER BY chapter_index LIMIT 1").get(novel.id);
    idx = firstEmpty ? firstEmpty.chapter_index : getMaxChapterIndex(novel.id) + 1;
  }
  if (mode === 'regenerate' && (!idx || idx < 1)) {
    return end({ type: 'error', message: '缺少章节号' });
  }

  // Job 化
  const jobTry = tryCreateJob(novel.id, 'generate_chapter', { mode, chapterIndex: idx, targetWords });
  if (jobTry.conflict) {
    return end({ type: 'error', message: '该小说已有进行中的章节生成任务', jobId: jobTry.jobId });
  }
  const job = jobTry.job;
  send({ type: 'job', jobId: job.id, stage: 'generate_chapter', chapterIndex: idx });
  send({ type: 'progress', progress: 5, message: `正在准备第 ${idx} 章…` });
  updateJob(job.id, { progress: 5, stream_cursor: `正在准备第 ${idx} 章…` });

  const targetWordsN = Number(targetWords) || novel.chapter_word_count || 2000;

  // 已有章节（用于记忆），过滤掉正在生成的章
  const existing = getChapter(novel.id, idx);
  const recentChapters = getRecentChapters(novel.id, 3).filter((c) => c.chapter_index !== idx);
  const historySummaries = buildHistorySummaries(novel.id, Math.floor(contextBudget(config) * 0.6)).filter((s) => s.chapter_index !== idx);
  const characters = getCharacters(novel.id);
  const novelFactions = getFactions(novel.id);

  // 章节标题：优先级 覆盖标题 > 已有标题 > 大纲占位 > AI 生成
  let title = overrideTitle && String(overrideTitle).trim() ? String(overrideTitle).trim()
    : (existing && existing.title && !existing.content ? existing.title : null);

  try {
    if (!title) {
      send({ type: 'status', message: `正在构思第 ${idx} 章标题…` });
      send({ type: 'progress', progress: 10, message: `正在构思第 ${idx} 章标题…` });
      const planned = novel.outline && Array.isArray(novel.outline) ? null : null;
      const planChapter = db.prepare('SELECT title, summary FROM chapters WHERE novel_id = ? AND chapter_index = ?').get(novel.id, idx);
      if (planChapter?.title) {
        title = planChapter.title;
      } else {
        const tRes = await chat({
          config,
          messages: [
            { role: 'system', content: CHAPTER_TITLE_SYSTEM },
            { role: 'user', content: buildNovelContext(novel, characters, [], [], 0, '', novelFactions) + `\n\n即将创作第 ${idx} 章的剧情概要：${planChapter?.summary || '承接前文继续推进'}\n\n请为这一章拟标题。` }
          ],
          maxTokens: 200
        });
        title = (tRes.content || '').replace(/["'《》]/g, '').trim() || `第${idx}章`;
      }
    }

    send({ type: 'status', message: `正在创作「${title}」（目标 ${targetWordsN} 字）…` });
    send({ type: 'progress', progress: 15, message: `正在创作「${title}」…` });

    // 上下文记忆：压缩模式下用故事状态简报替代前情摘要 + 最近章节全文
    const useCompressed = novel.context_compressed == 1 && novel.compressed_context;
    let memoryBlock = '';
    if (!useCompressed) {
      try {
        const memText = await readMemoryFile(novel);
        if (memText) memoryBlock = trimMemoryToBudget(memText, Math.floor(contextBudget(config) * 0.55));
      } catch { memoryBlock = ''; }
    }
    const context = useCompressed
      ? buildNovelContext(novel, characters, [], [], 0, '', novelFactions) + `\n\n【故事状态简报（已压缩，替代前情摘要与最近章节全文）】\n${novel.compressed_context}`
      : memoryBlock
        ? buildNovelContext(novel, characters, recentChapters, [], contextBudget(config), memoryBlock, novelFactions)
        : buildNovelContext(novel, characters, recentChapters, historySummaries, contextBudget(config), 0, novelFactions);

    // 待回收伏笔注入：防止前期埋下的坑被遗忘
    const openFores = getOpenForeshadowings(novel.id, 60);
    const foresBlock = formatForeshadowList(openFores)
      ? `【待回收伏笔（前面埋下的线索，本章如未回收也须自然呼应或保持存在感，不可遗忘）】\n${formatForeshadowList(openFores)}`
      : '';

    // 世界观设定注入：保证长篇写作的世界观一致性
    const worldBlock = formatWorldSettings(getWorldSettings(novel.id))
      ? `【世界观设定（创作时须严格遵守，不得与既定设定冲突）】\n${formatWorldSettings(getWorldSettings(novel.id))}`
      : '';

    // 关键剧情事实锚点：长期连载中防设定冲突与关键信息遗忘
    const kmItems = getKeyMoments(novel.id, 80);
    const kmBlock = formatKeyMoments(kmItems)
      ? `【本书已确立的关键剧情事实（长期记忆锚点，创作时必须遵循，不得与已发生事实矛盾，也不要重复叙述已明确交代过的事）】\n${formatKeyMoments(kmItems)}`
      : '';

    // 阶段记忆（卷快照）：超长连载中早期剧情不丢，注入最近阶段快照
    const stageBlock = formatStageMemories(getStageMemories(novel.id), 3)
      ? `【前情阶段摘要（更早章节的长效记忆浓缩，供把握历史走向；创作时须与之一致，可自然延续其局势）】\n${formatStageMemories(getStageMemories(novel.id), 3)}`
      : '';

    // 角色档案：性格核心与言行习惯，创作时必须保持，防角色性格突变
    const profileBlock = formatCharacterProfiles(getCharacterProfiles(novel.id))
      ? `【角色档案（性格核心与说话风格，创作时必须保持，不得让角色性格突变、言行前后矛盾）】\n${formatCharacterProfiles(getCharacterProfiles(novel.id))}`
      : '';

    // P0-P3 增强记忆块：分层摘要树 + 结构化事实 + 角色时间线 + 故事时间线 + 逾期伏笔 + 文笔漂移
    const enhancedMemBlock = buildEnhancedMemoryBlock(novel.id, idx);

    // P0-2: RAG 检索 — 根据本章概要检索相关历史片段
    let ragBlock = '';
    try {
      const ragChunks = retrieveRelevant(novel.id, existing?.summary || title, 5);
      ragBlock = formatRagBlock(ragChunks);
    } catch { /* RAG 检索失败不阻塞 */ }

    // 小说宪法 + 角色语音档案（跨模型一致性锚点）
    const constitution = getConstitution(novel.id);
    const charVoices = formatCharacterVoices(novel.id);
    // 知识学习库注入
    const knowledgeIds = getNovelKnowledgeIds(novel);
    const knowledgeBlock = formatKnowledgeBlock(knowledgeIds);
    let knowledgeSamples = '';
    if (knowledgeIds.length) {
      knowledgeSamples = knowledgeIds.map((id) => getSampleSnippets(id, 3000)).filter(Boolean).join('\n\n').slice(0, 8000);
    }
    const chapterSysOpts = {
      constitution: constitution || '',
      characterVoices: charVoices || '',
      knowledgeBlock: (knowledgeBlock + (knowledgeSamples ? KNOWLEDGE_SAMPLE_INTRO + knowledgeSamples : '')).trim()
    };

    const userPrompt = `${context}
 ${foresBlock}
 ${worldBlock}
 ${kmBlock}
 ${stageBlock}
 ${profileBlock}
 ${enhancedMemBlock}
 ${ragBlock}
 
 本章信息：
- 章节序号：第 ${idx} 章
- 章节标题：${title}
- 本章剧情概要：${existing?.summary || ''}
- 目标字数：约 ${targetWordsN} 字

请开始创作本章正文。`;

    let full = '';
    let finishReason = 'stop';
    const perMax = Math.max(4000, Math.min(32000, targetWordsN * 4));
    // 自动续写：单次输出被 max_tokens 截断（finish_reason=length）时继续往下写，直到达到目标字数或模型自然收尾
    for (let round = 0; round < 8; round++) {
      const msgs = round === 0
        ? [
            { role: 'system', content: buildChapterSystem(getStyles(parseStyleIds(novel)), novel.style_baseline, novel.style_samples, parseStylePresets(novel), chapterSysOpts) },
            { role: 'user', content: userPrompt }
          ]
        : [
            { role: 'system', content: buildChapterSystem(getStyles(parseStyleIds(novel)), novel.style_baseline, novel.style_samples, parseStylePresets(novel), chapterSysOpts) },
            { role: 'user', content: buildContinuePrompt(full, targetWordsN) }
          ];
      if (round > 0) {
        send({ type: 'status', message: `正在续写第 ${idx} 章剩余部分…` });
        const contPct = Math.min(70, 15 + round * 8);
        send({ type: 'progress', progress: contPct, message: `正在续写第 ${idx} 章（第 ${round + 1} 轮）…` });
      }
      const r = await runLLMStream(config, msgs, {
        ctrl,
        task: 'writing',
        maxTokens: perMax,
        onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
      });
      finishReason = r?.finishReason || 'stop';
      if (finishReason !== 'length' || countWords(full) >= targetWordsN) break;
    }

    if (!full.trim()) {
      return end({ type: 'error', message: 'AI 未返回内容，请重试。' });
    }

    // 保存章节
    let chapterId = existing ? existing.id : null;
    const wc = countWords(full);
    if (existing) {
      backupChapter(novel.id, idx, mode === 'regenerate' ? '重新生成' : '生成覆盖');
      db.prepare('UPDATE chapters SET title = ?, content = ?, word_count = ?, status = ? WHERE id = ?')
        .run(title, full, wc, 'draft', existing.id);
    } else {
      const ins = db.prepare('INSERT INTO chapters (novel_id, chapter_index, title, content, summary, word_count, status) VALUES (?,?,?,?,?,?,?)')
        .run(novel.id, idx, title, full, existing?.summary || '', wc, 'draft');
      chapterId = ins.lastInsertRowid;
    }
    touchNovel(novel.id);
    try {
      await writeChapterTxt(novel, { chapter_index: idx, title, content: full });
    } catch { /* 文件写入失败不阻塞 */ }

    // 强制质量门：先检测 AI 味 → 超标(>30分或有黑名单词)才润色 → 润色后复检 → 达标为止
    try {
      send({ type: 'status', message: '正在检测 AI 味…' });
      send({ type: 'progress', progress: 75, message: '正在检测 AI 味…' });
      let preScore = 0;
      let preIssues = [];
      let preBlacklist = [];
      try {
        const det = await runDetection(config, full);
        preScore = det.score;
        preIssues = det.issues;
        const hits = scanAiPatterns(full);
        preBlacklist = blacklistFlagWords(hits);
        preScore = Math.min(100, preScore + blacklistPenalty(hits));
      } catch { /* 检测失败不阻塞 */ }

      if (preScore > AI_SCORE_PASS || preBlacklist.length > 0) {
        const iter = await iteratePolish(config, novel, full, {
          onStatus: (m) => send({ type: 'status', message: m })
        });
        full = iter.text;
        saveDetection(novel.id, idx, iter.rounds.at(-1)?.score ?? preScore, iter.lastDetect.issues, iter.blacklist, 'quality_gate');
        db.prepare('UPDATE chapters SET content = ?, word_count = ? WHERE id = ?')
          .run(full, countWords(full), chapterId);
        send({ type: 'status', message: `第 ${idx} 章已通过质量门（${iter.rounds.length} 轮润色，终评 ${iter.rounds.at(-1)?.score ?? preScore} 分）` });
        try {
          await writeChapterTxt(novel, { chapter_index: idx, title, content: full });
        } catch { /* 文件写入失败不阻塞 */ }
      } else {
        saveDetection(novel.id, idx, preScore, preIssues, preBlacklist, 'quality_gate');
        send({ type: 'status', message: `第 ${idx} 章 AI 味检测通过（${preScore} 分）` });
      }
    } catch { /* 质量门失败不阻塞 */ }

    // 生成章节摘要（用于长篇小说记忆）
    try {
      const sRes = await chat({
        config,
        task: 'summary',
        messages: [
          { role: 'system', content: AUTO_SUMMARY_SYSTEM },
          { role: 'user', content: `第${idx}章 标题：${title}\n\n${full.slice(0, 4000)}` }
        ],
        maxTokens: 500
      });
      let summary = (sRes.content || '').trim();
      if (!summary) {
        // AI 摘要失败，用离线方式降级
        const sentences = full.split(/[。！？\n]/).filter((s) => s.trim().length > 10);
        const picks = [];
        if (sentences.length > 0) picks.push(sentences[0].trim());
        if (sentences.length > 4) picks.push(sentences[Math.floor(sentences.length * 0.3)].trim());
        if (sentences.length > 8) picks.push(sentences[Math.floor(sentences.length * 0.6)].trim());
        if (sentences.length > 2) picks.push(sentences[sentences.length - 1].trim());
        summary = picks.join('。') + '。';
      }
      if (summary) {
        db.prepare('UPDATE chapters SET summary = ? WHERE id = ?').run(summary, chapterId);
      }
      // 章节记忆已更新，重建小说文件夹下的「记忆.txt」
      refreshMemoryFile(novel.id);
    } catch { /* 摘要失败不阻塞 */ }

    // 关键剧情事实锚点：提炼本章确立的关键事实，长期连载中防设定冲突与关键信息遗忘
    try {
      send({ type: 'status', message: '正在记录关键剧情事实…' });
      const kRes = await chat({
        config,
        messages: [
          { role: 'system', content: KEY_MOMENTS_SYSTEM },
          { role: 'user', content: `第${idx}章 标题：${title}\n\n${full.slice(0, 4000)}` }
        ],
        maxTokens: 1000
      });
      const km = extractJson(kRes.content);
      if (Array.isArray(km)) {
        for (const m of km.filter(Boolean).map(String).slice(0, 8)) {
          addKeyMomentUnique(novel.id, m, idx);
        }
      }
    } catch { /* 关键事实记录失败不阻塞 */ }

    // 伏笔追踪：分析本章新埋下/已回收的伏笔，防止前期埋的坑被遗忘
    try {
      send({ type: 'status', message: '正在更新伏笔记忆…' });
      const fRes = await chat({
        config,
        messages: [
          { role: 'system', content: FORESHADOW_ANALYZE_SYSTEM },
          { role: 'user', content: `第${idx}章 标题：${title}\n\n${full.slice(0, 4000)}` }
        ],
        maxTokens: 1000
      });
      const fo = extractJson(fRes.content);
      if (fo) {
        const newList = Array.isArray(fo.new) ? fo.new.filter(Boolean).map(String).slice(0, 10) : [];
        for (const c of newList) {
          insertForeshadowUnique(novel.id, c, idx);
        }
        const resolved = Array.isArray(fo.resolved) ? fo.resolved.filter(Boolean).map(String) : [];
        if (resolved.length) {
          const openOnes = getOpenForeshadowings(novel.id, 200);
          for (const r of resolved) {
            const hit = openOnes.find((f) => f.content.includes(r) || r.includes(f.content) || sharedSubstring(r, f.content) >= 4);
            if (hit) {
              db.prepare("UPDATE foreshadowings SET status = 'closed', note = note || '（第' || ? || '章回收）', updated_at = datetime('now','localtime') WHERE id = ?").run(idx, hit.id);
            }
          }
        }
      }
    } catch { /* 伏笔分析失败不阻塞 */ }

    // 增量压缩：已启用压缩时，每新写满 5 章自动把新增剧情合并进简报
    if (novel.context_compressed == 1) {
      const maxIdx = getMaxChapterIndex(novel.id);
      const upto = Number(novel.compressed_upto_chapter) || 0;
      if (maxIdx - upto >= 5) {
        try {
          send({ type: 'status', message: '正在增量更新故事状态简报…' });
          const newChapters = db.prepare(
            "SELECT chapter_index, title, summary, content FROM chapters WHERE novel_id = ? AND chapter_index > ? AND content != '' ORDER BY chapter_index"
          ).all(novel.id, upto);
          const updInput = newChapters.map((c) => `第${c.chapter_index}章 ${c.title}：${c.summary || c.content.slice(0, 400)}`).join('\n');
          const uRes = await chat({
            config,
            messages: [
              { role: 'system', content: COMPRESS_UPDATE_SYSTEM },
              { role: 'user', content: `【当前故事状态简报】\n${novel.compressed_context}\n\n【新增章节】\n${updInput}` }
            ],
            maxTokens: 2000
          });
          const upd = (uRes.content || '').trim();
          if (upd) {
            db.prepare("UPDATE novels SET compressed_context = ?, compressed_upto_chapter = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(upd, maxIdx, novel.id);
          }
        } catch { /* 增量压缩失败不阻塞 */ }
      }
    }

    // 自动首次压缩：未启用压缩时，若最近已写章节占用上下文占比超过阈值，自动压缩为故事简报
    if (shouldAutoCompress(novel, config, getRecentChapters(novel.id, 3).reduce((s, c) => s + countWords(c.content || ''), 0))) {
      try {
        send({ type: 'status', message: '已写章节较多，正在自动压缩上下文…' });
        await compressNovelContext(novel, config, { send, ctrl });
        send({ type: 'status', message: '上下文已自动压缩为故事简报，后续生成将更省 tokens' });
      } catch { /* 自动压缩失败不阻塞，下次生成再试 */ }
    }

    // 大纲进度跟踪：每 5 章让 AI 校准大纲，防止长篇后期剧情偏离原大纲
    if (idx % 5 === 0) {
      try {
        send({ type: 'status', message: '正在校准剧情大纲…' });
        const recentRows = db.prepare(
          "SELECT chapter_index, title, summary FROM chapters WHERE novel_id = ? AND summary != '' ORDER BY chapter_index DESC LIMIT 15"
        ).all(novel.id).reverse();
        const chSum = recentRows.map((c) => `第${c.chapter_index}章 ${c.title}：${c.summary}`).join('\n');
        const momentsText = formatKeyMoments(getKeyMoments(novel.id, 30));
        const aRes = await chat({
          config,
          messages: [
            { role: 'system', content: PLAN_ADVANCE_SYSTEM },
            { role: 'user', content: `当前大纲：\n${novel.outline || '（未设置）'}\n\n最近已写章节概要：\n${chSum || '（暂无）'}\n\n已确立的关键剧情事实：\n${momentsText || '（暂无）'}` }
          ],
          maxTokens: 3000
        });
        const po = extractJson(aRes.content);
        const revised = po && po.revised_outline ? String(po.revised_outline).trim() : '';
        if (revised && revised !== (novel.outline || '')) {
          db.prepare("UPDATE novels SET outline = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(revised, novel.id);
          refreshMemoryFile(novel.id);
          send({ type: 'status', message: '大纲已根据最新剧情校准' });
        }
      } catch { /* 大纲校准失败不阻塞 */ }
    }

    // 阶段记忆 + 风格重锚定：每 50 章封存一个剧情阶段快照，并重提炼当前文风基准，超长连载不丢早期剧情、文风不漂移
    if (idx % 50 === 0) {
      const stageNo = Math.floor(idx / 50);
      const sStart = (stageNo - 1) * 50 + 1;
      const sEnd = stageNo * 50;
      // 1) 封存本阶段剧情快照
      try {
        send({ type: 'status', message: `正在封存第 ${sStart}-${sEnd} 章剧情阶段记忆…` });
        const stageRows = db.prepare(
          "SELECT chapter_index, title, summary, content FROM chapters WHERE novel_id = ? AND chapter_index BETWEEN ? AND ? AND content != '' ORDER BY chapter_index"
        ).all(novel.id, sStart, sEnd);
        if (stageRows.length) {
          const stageInput = stageRows.map((c) => `第${c.chapter_index}章 ${c.title}：${c.summary || c.content.slice(0, 300)}`).join('\n');
          const sRes = await chat({
            config,
            messages: [
              { role: 'system', content: STAGE_SUMMARY_SYSTEM },
              { role: 'user', content: `本阶段为《${novel.title}》第 ${sStart}-${sEnd} 章，请浓缩为阶段快照。\n\n${stageInput}` }
            ],
            maxTokens: 2500
          });
          const sText = (sRes.content || '').trim();
          if (sText) {
            upsertStageMemory(novel.id, stageNo, sStart, sEnd, sText);
          }
        }
      } catch { /* 阶段封存失败不阻塞 */ }
      // 2) 重提炼文风基准：用最近 5 章锁定当前文风，防长期连载漂移
      try {
        send({ type: 'status', message: '正在重锚定文风基准…' });
        const styleChapters = getRecentChapters(novel.id, 5);
        if (styleChapters.length) {
          const styleSample = styleChapters.map((c) => `第${c.chapter_index}章\n${c.content.slice(0, 2000)}`).join('\n\n').slice(0, 20000);
          const stRes = await chat({
            config,
            messages: [
              { role: 'system', content: STYLE_ANALYZE_SYSTEM },
              { role: 'user', content: `请分析以下本书最近章节的写作风格，提炼一段可作为长期基准的"文风说明"。\n\n【文本】\n${styleSample}` }
            ],
            maxTokens: 4096
          });
          const stAnalysis = extractJson(stRes.content);
          if (stAnalysis && typeof stAnalysis === 'object') {
            const newBaseline = (stAnalysis.overview || JSON.stringify(stAnalysis)).trim();
            if (newBaseline) {
              db.prepare("UPDATE novels SET style_baseline = ?, style_samples = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newBaseline, JSON.stringify(stAnalysis.example || []), novel.id);
            }
          }
        }
      } catch { /* 风格重锚定失败不阻塞 */ }
    }

    // 角色档案更新：每 10 章基于最近剧情维护角色一致性，防性格突变
    if (idx % 10 === 0) {
      try {
        send({ type: 'status', message: '正在更新角色档案…' });
        const profChapters = getRecentChapters(novel.id, 5);
        if (profChapters.length) {
          const profSample = profChapters.map((c) => `第${c.chapter_index}章\n${c.content.slice(0, 1500)}`).join('\n\n').slice(0, 20000);
          const initChars = getCharacters(novel.id).map((c) => `${c.name}（${c.role_type}）：${c.personality || c.description || ''}`).join('\n');
          const existingProfiles = formatCharacterProfiles(getCharacterProfiles(novel.id)) || '（暂无）';
          const cpRes = await chat({
            config,
            messages: [
              { role: 'system', content: CHARACTER_CONSISTENCY_SYSTEM },
              { role: 'user', content: `角色初始设定：\n${initChars || '（暂无）'}\n\n已有角色档案：\n${existingProfiles}\n\n最近章节正文：\n${profSample}` }
            ],
            maxTokens: 3000
          });
          const cp = extractJson(cpRes.content);
          const list = cp && Array.isArray(cp.characters) ? cp.characters : [];
          for (const c of list) {
            if (c && c.name && c.profile) upsertCharacterProfile(novel.id, String(c.name).trim(), String(c.profile).trim(), idx);
          }
        }
      } catch { /* 角色档案更新失败不阻塞 */ }
    }

    // ===== P0-P3 长篇记忆后处理 =====

    // P0-1: 保存分层摘要 level-0 + 触发层级压缩
    try {
      const chSum = db.prepare('SELECT summary FROM chapters WHERE id = ?').get(chapterId)?.summary || '';
      if (chSum) saveChapterSummary(novel.id, idx, chSum);
      await compressSummariesIfNeeded(novel.id, idx, config);
    } catch { /* 分层摘要失败不阻塞 */ }

    // P0-2: 存储章节 chunks 供 RAG 检索
    try { storeChunks(novel.id, idx, full); } catch { /* chunk 存储失败不阻塞 */ }

    // P1-1: 结构化事实抽取 + 冲突检测
    try {
      send({ type: 'status', message: '正在记录结构化事实…' });
      const fRes = await chat({
        config,
        messages: [
          { role: 'system', content: FACT_EXTRACT_SYSTEM },
          { role: 'user', content: `第${idx}章 标题：${title}\n\n${full.slice(0, 4000)}` }
        ],
        maxTokens: 1500
      });
      const facts = extractJson(fRes.content);
      if (Array.isArray(facts)) {
        const conflicts = checkFactConflicts(novel.id, facts, idx);
        if (conflicts.length) {
          send({ type: 'status', message: `检测到 ${conflicts.length} 处事实变更，已更新事实库` });
        }
        for (const f of facts.filter(Boolean).slice(0, 15)) {
          saveFact(novel.id, f, idx);
        }
      }
    } catch { /* 事实抽取失败不阻塞 */ }

    // P1-2: 角色变化抽取 + 时间线记录
    try {
      send({ type: 'status', message: '正在追踪角色变化…' });
      const cRes = await chat({
        config,
        messages: [
          { role: 'system', content: CHAR_CHANGE_EXTRACT_SYSTEM },
          { role: 'user', content: `第${idx}章 标题：${title}\n\n${full.slice(0, 4000)}` }
        ],
        maxTokens: 1200
      });
      const changes = extractJson(cRes.content);
      if (Array.isArray(changes)) {
        const chars = getCharacters(novel.id);
        for (const c of changes.filter(Boolean).slice(0, 10)) {
          const char = chars.find((ch) => ch.name === c.name);
          saveCharacterChange(novel.id, char?.id || null, idx, c.field, c.old_value, c.new_value, c.reason);
        }
      }
    } catch { /* 角色变化抽取失败不阻塞 */ }

    // P2-1: 伏笔预期回收章节预测
    try {
      const fRes = await chat({
        config,
        messages: [
          { role: 'system', content: FORESHADOW_RECALL_PREDICT_SYSTEM },
          { role: 'user', content: `第${idx}章 标题：${title}\n\n${full.slice(0, 4000)}` }
        ],
        maxTokens: 800
      });
      const preds = extractJson(fRes.content);
      if (Array.isArray(preds)) {
        const openOnes = getOpenForeshadowings(novel.id, 200);
        for (const p of preds.filter(Boolean).slice(0, 5)) {
          const hit = openOnes.find((f) => f.content.includes(p.description) || p.description.includes(f.content));
          if (hit && p.expected_recall_after) {
            setExpectedRecall(novel.id, hit.id, idx + Number(p.expected_recall_after));
          }
        }
      }
    } catch { /* 伏笔回收预测失败不阻塞 */ }

    // P2-2: 文笔漂移检测（每 10 章）
    if (idx % 10 === 0) {
      try {
        send({ type: 'status', message: '正在检测文风漂移…' });
        await detectStyleDrift(novel.id, idx, config);
      } catch { /* 文风漂移检测失败不阻塞 */ }
    }

    // P3: 时间线事件抽取
    try {
      const tRes = await chat({
        config,
        messages: [
          { role: 'system', content: TIMELINE_EXTRACT_SYSTEM },
          { role: 'user', content: `第${idx}章 标题：${title}\n\n${full.slice(0, 4000)}` }
        ],
        maxTokens: 600
      });
      const tl = extractJson(tRes.content);
      if (tl && tl.events) {
        for (const evt of tl.events.filter(Boolean).slice(0, 5)) {
          saveTimelineEvent(novel.id, idx, tl.story_time, String(evt));
        }
      }
    } catch { /* 时间线提取失败不阻塞 */ }

    // 角色语音档案提取：每章分析出场角色的说话方式，跨模型保持角色口吻一致
    try {
      const vRes = await chat({
        config,
        messages: [
          { role: 'system', content: CHARACTER_VOICE_EXTRACT_SYSTEM },
          { role: 'user', content: `第${idx}章 标题：${title}\n\n${full.slice(0, 4000)}` }
        ],
        maxTokens: 1500
      });
      const voices = extractJson(vRes.content);
      if (voices && Array.isArray(voices.characters)) {
        const chars = getCharacters(novel.id);
        for (const v of voices.characters.filter(Boolean).slice(0, 8)) {
          if (!v.name) continue;
          const char = chars.find((c) => c.name === v.name);
          saveCharacterVoice(novel.id, v.name, {
            character_id: char?.id,
            speech_pattern: v.speech_pattern,
            vocabulary: v.vocabulary,
            catchphrases: v.catchphrases,
            tone: v.tone
          }, idx);
        }
      }
    } catch { /* 角色语音提取失败不阻塞 */ }

    // 剧情一致性校验：检查本章是否与已确立事实/角色设定矛盾
    try {
      send({ type: 'status', message: '正在校验剧情一致性…' });
      const consistency = await checkPlotConsistency(novel.id, idx, full, config);
      if (consistency && consistency.overall_consistency === 'major_issues') {
        const issues = (consistency.issues || []).filter((i) => i.severity === 'high');
        if (issues.length) {
          send({ type: 'status', message: `检测到 ${issues.length} 处严重剧情矛盾：${issues.slice(0, 3).map((i) => i.description).join('；')}` });
        }
      }
    } catch { /* 一致性校验失败不阻塞 */ }

    // 小说宪法重建：每 20 章重新生成一次，吸收最新事实/角色变化
    if (idx % 20 === 0) {
      try {
        send({ type: 'status', message: '正在更新小说宪法…' });
        await buildConstitution(novel.id, config);
      } catch { /* 宪法重建失败不阻塞 */ }
    }

    // 自动提取新角色入库：从本章内容中发现尚未在角色表中的角色并添加
    try {
      const existing = getCharacters(novel.id);
      const existingNames = new Set(existing.map((c) => c.name));
      const aRes = await chat({
        config,
        messages: [{ role: 'user', content: `请分析以下小说章节内容，提取其中出现的重要角色（有名字且有戏份的，不包括仅一笔带过的龙套）。只输出 JSON 数组：
[{"name":"角色名","role_type":"主角|反派|重要配角|配角","personality":"性格","background":"背景","description":"简介"}]
只输出 JSON。

第${idx}章 ${title}
${full.slice(0, 4000)}` }],
        maxTokens: 1500
      });
      const found = extractJson(aRes.content);
      if (Array.isArray(found)) {
        let added = 0;
        for (const c of found.filter(Boolean)) {
          if (!c.name || existingNames.has(String(c.name)) || looksLikeHonorific(c.name)) continue;
          db.prepare('INSERT INTO characters (novel_id, name, role_type, personality, background, description) VALUES (?,?,?,?,?,?)')
            .run(novel.id, String(c.name), String(c.role_type || '配角'), String(c.personality || ''), String(c.background || ''), String(c.description || ''));
          existingNames.add(String(c.name));
          added++;
        }
        if (added) send({ type: 'status', message: `自动发现 ${added} 个新角色并已入库` });
      }
    } catch { /* 角色提取失败不阻塞 */ }

    const updatedNovel = getNovel(novel.id);
    updatedNovel.chapters = getChapters(novel.id);
    updatedNovel.total_words = updatedNovel.chapters.reduce((s, c) => s + c.word_count, 0);
    send({ type: 'progress', progress: 100, message: `第 ${idx} 章创作完成` });
    updateJob(job.id, { status: 'done', progress: 100, word_count: (getChapter(novel.id, idx)?.word_count || 0), result_ref: String(idx) });
    end({ type: 'done', data: { novel: updatedNovel, chapter: getChapter(novel.id, idx), autoPolished: !!config.autoPolish, foreshadowings: getForeshadowings(novel.id), jobId: job.id } });
  } catch (e) {
    if (e.name === 'AbortError') {
      updateJob(job.id, { status: 'aborted', error: e.message });
      return end({ type: 'aborted', message: '已停止生成' });
    }
    updateJob(job.id, { status: 'failed', error: e.message });
    return end({ type: 'error', message: e.message });
  }
});

// ===== P0-P3 长篇记忆查询 API =====

// 分层摘要树
router.get('/novels/:id/summaries', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { level } = req.query;
  const rows = level != null
    ? db.prepare('SELECT * FROM chapter_summaries WHERE novel_id = ? AND level = ? ORDER BY start_chapter').all(novel.id, Number(level))
    : db.prepare('SELECT * FROM chapter_summaries WHERE novel_id = ? ORDER BY level, start_chapter').all(novel.id);
  res.json(rows);
});

// 结构化事实库
router.get('/novels/:id/facts', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  res.json(getActiveFacts(novel.id));
});

// 角色时间线
router.get('/novels/:id/character-timeline', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { characterId, limit } = req.query;
  const rows = characterId
    ? db.prepare('SELECT ct.*, c.name FROM character_timeline ct LEFT JOIN characters c ON ct.character_id = c.id WHERE ct.novel_id = ? AND ct.character_id = ? ORDER BY ct.id DESC LIMIT ?').all(novel.id, Number(characterId), Number(limit) || 20)
    : db.prepare('SELECT ct.*, c.name FROM character_timeline ct LEFT JOIN characters c ON ct.character_id = c.id WHERE ct.novel_id = ? ORDER BY ct.id DESC LIMIT ?').all(novel.id, Number(limit) || 50);
  res.json(rows);
});

// 文笔漂移历史
router.get('/novels/:id/style-drift', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const rows = db.prepare('SELECT * FROM style_drift_log WHERE novel_id = ? ORDER BY id DESC LIMIT 20').all(novel.id);
  res.json(rows);
});

// 故事时间线
router.get('/novels/:id/timeline', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const rows = db.prepare('SELECT * FROM novel_timeline WHERE novel_id = ? ORDER BY chapter_index').all(novel.id);
  res.json(rows);
});

// RAG 检索测试
router.post('/novels/:id/rag-search', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { query, topK } = req.body || {};
  if (!query) return res.status(400).json({ error: '缺少 query' });
  const chunks = retrieveRelevant(novel.id, query, Number(topK) || 5);
  res.json(chunks);
});

// 增强记忆块预览（查看生成时注入的完整记忆块）
router.get('/novels/:id/enhanced-memory', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { chapterIndex } = req.query;
  const idx = Number(chapterIndex) || (getMaxChapterIndex(novel.id) + 1);
  const block = buildEnhancedMemoryBlock(novel.id, idx);
  res.json({ chapterIndex: idx, memoryBlock: block });
});

// 去AI味润色：按人类写作风格重写章节（流式）。铁律模式下走质量门：多轮迭代达标才写入
router.post('/novels/:id/chapters/:idx/polish', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const idx = Number(req.params.idx);
  const chapter = getChapter(novel.id, idx);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  if (!chapter.content) return res.status(400).json({ error: '本章还没有内容可润色' });

  const { ctrl, send, end } = startSSE(req, res);
  send({ type: 'status', message: `正在去除「${chapter.title}」的 AI 味…` });
  send({ type: 'progress', progress: 5, message: `正在去除「${chapter.title}」的 AI 味…` });

  backupChapter(novel.id, idx, '去AI味润色');

  try {
    if (strictMode()) {
      // 质量门模式：润色 → 检测 → 未达标再润色（带上轮 issues + 黑名单），达标才写入
      const iter = await iteratePolish(config, novel, chapter.content, {
        onStatus: (m) => send({ type: 'status', message: m }),
        maxRounds: AI_MAX_ROUNDS
      });
      if (!iter.text.trim()) return end({ type: 'error', message: 'AI 未返回内容，请重试。' });
      const finalText = iter.text.trim();
      db.prepare('UPDATE chapters SET content = ?, word_count = ?, status = ? WHERE id = ?')
        .run(finalText, countWords(finalText), 'draft', chapter.id);
      touchNovel(novel.id);
      try {
        await writeChapterTxt(novel, { chapter_index: idx, title: chapter.title, content: finalText });
      } catch { /* 文件写入失败不阻塞 */ }
      const finalScore = iter.rounds.at(-1)?.score ?? 0;
      const passed = finalScore <= AI_SCORE_PASS && iter.blacklist.length === 0;
      saveDetection(novel.id, idx, finalScore, iter.lastDetect.issues, iter.blacklist, 'polish');
      send({ type: 'progress', progress: 100, message: '润色完成' });
      end({
        type: 'done',
        data: {
          chapter: getChapter(novel.id, idx),
          detect: { score: finalScore, issues: iter.lastDetect.issues, blacklist: iter.blacklist },
          rounds: iter.rounds,
          passed
        }
      });
    } else {
      // 铁律模式关闭时的单轮旧行为
      let full = '';
      await runLLMStream(config, [
        { role: 'system', content: buildPolishSystem(getStyles(parseStyleIds(novel)), novel.style_baseline, novel.style_samples, parseStylePresets(novel)) },
        { role: 'user', content: `以下是一章小说原稿。请按人类写作风格整体改写，彻底去除一切 AI 痕迹，保留剧情与人设。\n\n原稿：\n${chapter.content}` }
      ], {
        ctrl,
        task: 'writing',
        maxTokens: Math.max(4000, Math.min(32000, (chapter.content.length + 2000) * 2)),
        onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
      });
      if (!full.trim()) return end({ type: 'error', message: 'AI 未返回内容，请重试。' });
      full = full.trim();
      db.prepare('UPDATE chapters SET content = ?, word_count = ?, status = ? WHERE id = ?')
        .run(full, countWords(full), 'draft', chapter.id);
      touchNovel(novel.id);
      try {
        await writeChapterTxt(novel, { chapter_index: idx, title: chapter.title, content: full });
      } catch { /* 文件写入失败不阻塞 */ }
      let detect = { score: 0, issues: [] };
      try { detect = await runDetection(config, full); } catch { /* 检测失败不阻塞 */ }
      const bl = blacklistFlagWords(scanAiPatterns(full));
      saveDetection(novel.id, idx, detect.score, detect.issues, bl, 'polish');
      send({ type: 'progress', progress: 100, message: '润色完成' });
      end({ type: 'done', data: { chapter: getChapter(novel.id, idx), detect, rounds: [], passed: detect.score <= AI_SCORE_PASS } });
    }
  } catch (e) {
    if (e.name === 'AbortError') return end({ type: 'aborted', message: '已停止润色' });
    return end({ type: 'error', message: e.message });
  }
});

// ---------- 对话（记忆 + 流式） ----------
router.get('/novels/:id/chat', (req, res) => {
  const msgs = db.prepare('SELECT * FROM chat_messages WHERE novel_id = ? ORDER BY id').all(req.params.id);
  res.json(msgs);
});

router.delete('/novels/:id/chat', (req, res) => {
  db.prepare('DELETE FROM chat_messages WHERE novel_id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/novels/:id/chat', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const { content } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: '内容不能为空' });

  db.prepare('INSERT INTO chat_messages (novel_id, role, content) VALUES (?,?,?)').run(novel.id, 'user', String(content));

  const { ctrl, send, end } = startSSE(req, res);
  const characters = getCharacters(novel.id);
  const recentChapters = getRecentChapters(novel.id, 3);
  const progressText = getNovelProgressText(novel, recentChapters);

  const history = db.prepare('SELECT role, content FROM chat_messages WHERE novel_id = ? ORDER BY id DESC LIMIT 20').all(novel.id).reverse();

  const messages = [
    { role: 'system', content: CHAT_SYSTEM(novel, characters, progressText) },
    ...history.map((m) => ({ role: m.role, content: m.content }))
  ];

  try {
    let full = '';
    await runLLMStream(config, messages, {
      ctrl,
      task: 'chat',
      maxTokens: 4096,
      onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
    });
    const reply = full.trim();
    if (reply) {
      db.prepare('INSERT INTO chat_messages (novel_id, role, content) VALUES (?,?,?)').run(novel.id, 'assistant', reply);
    }
    end({ type: 'done', data: { reply } });
  } catch (e) {
    if (e.name === 'AbortError') return end({ type: 'aborted', message: '已停止' });
    // 用户消息已入库，报错返回
    return end({ type: 'error', message: e.message });
  }
});

// ---------- 角色 ----------
router.get('/novels/:id/characters', (req, res) => {
  res.json(getCharacters(req.params.id));
});

router.post('/novels/:id/characters', (req, res) => {
  const { name, role_type, personality, background, description, faction, age, goal, ability } = req.body || {};
  if (!name) return res.status(400).json({ error: '角色名不能为空' });
  const info = db.prepare('INSERT INTO characters (novel_id, name, role_type, personality, background, description, faction, age, goal, ability) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(req.params.id, name, role_type || '配角', personality || '', background || '', description || '', faction || '', age || '', goal || '', ability || '');
  touchNovel(req.params.id);
  res.json(db.prepare('SELECT * FROM characters WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/novels/:id/characters/:cid', (req, res) => {
  const ch = db.prepare('SELECT * FROM characters WHERE id = ? AND novel_id = ?').get(req.params.cid, req.params.id);
  if (!ch) return res.status(404).json({ error: '角色不存在' });
  const sets = [];
  const vals = [];
  for (const f of ['name', 'role_type', 'personality', 'background', 'description', 'faction', 'age', 'goal', 'ability']) {
    if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (sets.length) {
    vals.push(ch.id);
    db.prepare(`UPDATE characters SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  touchNovel(req.params.id);
  res.json(db.prepare('SELECT * FROM characters WHERE id = ?').get(ch.id));
});

router.delete('/novels/:id/characters/:cid', (req, res) => {
  db.prepare('DELETE FROM relationships WHERE source_id = ? OR target_id = ?').run(req.params.cid, req.params.cid);
  db.prepare('DELETE FROM characters WHERE id = ? AND novel_id = ?').run(req.params.cid, req.params.id);
  touchNovel(req.params.id);
  res.json({ ok: true });
});

// ---------- 势力/组织 ----------
router.get('/novels/:id/factions', (req, res) => {
  res.json(getFactions(req.params.id));
});

router.post('/novels/:id/factions', (req, res) => {
  const { name, type, description, power_level, territory, leader, stance } = req.body || {};
  if (!name) return res.status(400).json({ error: '势力名不能为空' });
  const info = db.prepare('INSERT INTO factions (novel_id, name, type, description, power_level, territory, leader, stance) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.params.id, name, type || '帮派', description || '', power_level || '', territory || '', leader || '', stance || '中立');
  touchNovel(req.params.id);
  res.json(db.prepare('SELECT * FROM factions WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/novels/:id/factions/:fid', (req, res) => {
  const fa = db.prepare('SELECT * FROM factions WHERE id = ? AND novel_id = ?').get(req.params.fid, req.params.id);
  if (!fa) return res.status(404).json({ error: '势力不存在' });
  const sets = [];
  const vals = [];
  for (const f of ['name', 'type', 'description', 'power_level', 'territory', 'leader', 'stance']) {
    if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (sets.length) {
    vals.push(fa.id);
    db.prepare(`UPDATE factions SET ${sets.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`).run(...vals);
  }
  touchNovel(req.params.id);
  res.json(db.prepare('SELECT * FROM factions WHERE id = ?').get(fa.id));
});

router.delete('/novels/:id/factions/:fid', (req, res) => {
  db.prepare('DELETE FROM factions WHERE id = ? AND novel_id = ?').run(req.params.fid, req.params.id);
  touchNovel(req.params.id);
  res.json({ ok: true });
});

// 从现有章节智能提取角色建议
router.post('/novels/:id/characters/analyze', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const chapters = db.prepare("SELECT chapter_index, title, content FROM chapters WHERE novel_id = ? AND content != '' ORDER BY chapter_index").all(novel.id);
  if (!chapters.length) return res.status(400).json({ error: '还没有已生成的章节可供分析' });

  const sample = chapters.map((c) => `第${c.chapter_index}章 ${c.title}\n${c.content}`).join('\n\n').slice(0, 15000);
  const prompt = `请分析以下小说内容中出现的所有重要角色，输出 JSON 数组：
[{"name":"角色名","role_type":"主角|反派|重要配角|配角","personality":"性格","background":"背景","description":"简介"}]
只输出 JSON。\n\n${sample}`;

  try {
    const r = await chat({ config, messages: [{ role: 'user', content: prompt }], maxTokens: 4096 });
    const data = extractJson(r.content);
    if (!data || !Array.isArray(data)) return res.json([]);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 关系 ----------
router.get('/novels/:id/relationships', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, ca.name AS source_name, cb.name AS target_name
    FROM relationships r
    JOIN characters ca ON ca.id = r.source_id
    JOIN characters cb ON cb.id = r.target_id
    WHERE r.novel_id = ?
  `).all(req.params.id);
  res.json(rows);
});

router.post('/novels/:id/relationships', (req, res) => {
  const { source_id, target_id, relation_type, description } = req.body || {};
  if (!source_id || !target_id) return res.status(400).json({ error: '缺少角色' });
  const info = db.prepare('INSERT INTO relationships (novel_id, source_id, target_id, relation_type, description) VALUES (?,?,?,?,?)')
    .run(req.params.id, source_id, target_id, relation_type || '朋友', description || '');
  touchNovel(req.params.id);
  res.json(db.prepare('SELECT * FROM relationships WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/novels/:id/relationships/:rid', (req, res) => {
  const r = db.prepare('SELECT * FROM relationships WHERE id = ? AND novel_id = ?').get(req.params.rid, req.params.id);
  if (!r) return res.status(404).json({ error: '关系不存在' });
  const sets = [];
  const vals = [];
  for (const f of ['source_id', 'target_id', 'relation_type', 'description']) {
    if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (sets.length) {
    vals.push(r.id);
    db.prepare(`UPDATE relationships SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  touchNovel(req.params.id);
  res.json(db.prepare('SELECT * FROM relationships WHERE id = ?').get(r.id));
});

router.delete('/novels/:id/relationships/:rid', (req, res) => {
  db.prepare('DELETE FROM relationships WHERE id = ? AND novel_id = ?').run(req.params.rid, req.params.id);
  touchNovel(req.params.id);
   res.json({ ok: true });
});

// Phase 8：关系节点坐标持久化（已抽到 routes/relationshipAndShared.js，主文件用 router.use 挂载）

// ---------- 上下文压缩 ----------
// 把全部已写章节压缩成一份故事状态简报，之后生成章节时用它替代"前情摘要 + 最近章节全文"，节省 tokens
// 抽出的可复用压缩实现：供 /compress 路由与章节生成末尾的自动首次压缩共用
async function compressNovelContext(novel, config, { send, ctrl } = {}) {
  const chapters = db.prepare("SELECT chapter_index, title, summary, content FROM chapters WHERE novel_id = ? AND content != '' ORDER BY chapter_index").all(novel.id);
  if (!chapters.length) throw new Error('还没有已写章节可压缩');
  if (send) send({ type: 'status', message: `正在压缩 ${chapters.length} 章内容…` });
  let input = '';
  let omitted = 0;
  for (const c of chapters) {
    const line = `第${c.chapter_index}章 ${c.title}：${c.summary || c.content.slice(0, 300)}`;
    if (input.length + line.length > 60000) { omitted++; continue; }
    input += line + '\n';
  }
  if (omitted) input += `\n……（另有 ${omitted} 章因篇幅省略，请基于已有信息保持剧情连贯）`;
  let full = '';
  await runLLMStream(config, [
    { role: 'system', content: COMPRESS_SYSTEM },
    { role: 'user', content: `请把以下已写章节压缩为一份故事状态简报。\n\n【章节内容】\n${input}` }
  ], {
    ctrl,
    maxTokens: 3000,
    onDelta: (d) => { full += d; if (send) send({ type: 'delta', content: d }); }
  });
  if (!full.trim()) throw new Error('压缩失败：AI 未返回内容，请重试。');
  const maxIdx = chapters.at(-1)?.chapter_index || getMaxChapterIndex(novel.id);
  db.prepare("UPDATE novels SET compressed_context = ?, context_compressed = 1, compressed_upto_chapter = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(full.trim(), maxIdx, novel.id);
  return full.trim();
}

router.post('/novels/:id/compress', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });
  const { ctrl, send, end } = startSSE(req, res);
  try {
    await compressNovelContext(novel, config, { send, ctrl });
    end({ type: 'done', data: { novel: getNovel(novel.id) } });
  } catch (e) {
    if (e.name === 'AbortError') return end({ type: 'aborted', message: '已停止' });
    return end({ type: 'error', message: e.message });
  }
});

// 恢复完整上下文（撤销压缩）
router.post('/novels/:id/compress/restore', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  db.prepare("UPDATE novels SET context_compressed = 0, updated_at = datetime('now','localtime') WHERE id = ?").run(novel.id);
  res.json({ ok: true, novel: getNovel(novel.id) });
});

// ---------- 伏笔追踪 ----------
router.get('/novels/:id/foreshadowings', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  res.json(getForeshadowings(novel.id));
});

router.post('/novels/:id/foreshadowings', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { content, chapter_index, note } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: '请填写伏笔内容' });
  const info = db.prepare('INSERT INTO foreshadowings (novel_id, content, chapter_index, note) VALUES (?,?,?,?)')
    .run(novel.id, String(content).trim(), Number(chapter_index) || 0, note || '');
  touchNovel(novel.id);
  res.json(db.prepare('SELECT * FROM foreshadowings WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/novels/:id/foreshadowings/:fid', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const f = db.prepare('SELECT * FROM foreshadowings WHERE id = ? AND novel_id = ?').get(req.params.fid, novel.id);
  if (!f) return res.status(404).json({ error: '伏笔不存在' });
  const sets = [];
  const vals = [];
  for (const k of ['content', 'status', 'note']) {
    if (req.body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(String(req.body[k])); }
  }
  if (req.body.chapter_index !== undefined) { sets.push('chapter_index = ?'); vals.push(Number(req.body.chapter_index) || 0); }
  if (sets.length) {
    vals.push(f.id);
    db.prepare(`UPDATE foreshadowings SET ${sets.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`).run(...vals);
  }
  touchNovel(novel.id);
  res.json(db.prepare('SELECT * FROM foreshadowings WHERE id = ?').get(f.id));
});

router.delete('/novels/:id/foreshadowings/:fid', (req, res) => {
  db.prepare('DELETE FROM foreshadowings WHERE id = ? AND novel_id = ?').run(req.params.fid, req.params.id);
  res.json({ ok: true });
});

// 手动伏笔分析：分析最近一章的伏笔埋设与回收
router.post('/novels/:id/foreshadowings/analyze', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });
  const last = db.prepare("SELECT chapter_index, title, content FROM chapters WHERE novel_id = ? AND content != '' ORDER BY chapter_index DESC LIMIT 1").get(novel.id);
  if (!last) return res.status(400).json({ error: '还没有已写章节' });

  try {
    const fRes = await chat({
      config,
      messages: [
        { role: 'system', content: FORESHADOW_ANALYZE_SYSTEM },
        { role: 'user', content: `第${last.chapter_index}章 标题：${last.title}\n\n${last.content.slice(0, 4000)}` }
      ],
      maxTokens: 1000
    });
    const fo = extractJson(fRes.content);
    if (!fo) return res.status(400).json({ error: '伏笔分析失败，请重试' });
    const added = [];
    const closed = [];
    for (const c of (Array.isArray(fo.new) ? fo.new : []).filter(Boolean).map(String).slice(0, 10)) {
      const row = insertForeshadowUnique(novel.id, c, last.chapter_index);
      if (row) added.push(row);
    }
    const openOnes = getOpenForeshadowings(novel.id, 200);
    for (const r of (Array.isArray(fo.resolved) ? fo.resolved : []).filter(Boolean).map(String)) {
      const hit = openOnes.find((f) => f.content.includes(r) || r.includes(f.content) || sharedSubstring(r, f.content) >= 4);
      if (hit) {
        db.prepare("UPDATE foreshadowings SET status = 'closed', note = note || '（第' || ? || '章回收）', updated_at = datetime('now','localtime') WHERE id = ?").run(last.chapter_index, hit.id);
        closed.push(hit.id);
      }
    }
    touchNovel(novel.id);
    res.json({ ok: true, added, closed, foreshadowings: getForeshadowings(novel.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 世界观设定 CRUD ----------
router.get('/novels/:id/world-settings', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  res.json(getWorldSettings(novel.id));
});

router.post('/novels/:id/world-settings', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { category = '其他', name = '', content = '' } = req.body || {};
  if (!name.trim()) return res.status(400).json({ error: '请填写设定名称' });
  const info = db.prepare('INSERT INTO world_settings (novel_id, category, name, content) VALUES (?,?,?,?)')
    .run(novel.id, category, name.trim(), content);
  touchNovel(novel.id);
  res.json(db.prepare('SELECT * FROM world_settings WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/novels/:id/world-settings/:sid', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const s = db.prepare('SELECT * FROM world_settings WHERE id = ? AND novel_id = ?').get(req.params.sid, novel.id);
  if (!s) return res.status(404).json({ error: '设定不存在' });
  const { category, name, content } = req.body || {};
  db.prepare("UPDATE world_settings SET category = ?, name = ?, content = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(category || s.category, name || s.name, content ?? s.content, s.id);
  touchNovel(novel.id);
  res.json(db.prepare('SELECT * FROM world_settings WHERE id = ?').get(s.id));
});

router.delete('/novels/:id/world-settings/:sid', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  db.prepare('DELETE FROM world_settings WHERE id = ? AND novel_id = ?').run(req.params.sid, novel.id);
  touchNovel(novel.id);
  res.json({ ok: true });
});

// ---------- 章节历史备份 ----------
router.get('/novels/:id/chapters/:idx/backups', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  res.json(getChapterBackups(novel.id, Number(req.params.idx)));
});

router.post('/novels/:id/chapters/:idx/backups/:bid/restore', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const idx = Number(req.params.idx);
  const b = db.prepare('SELECT * FROM chapter_backups WHERE id = ? AND novel_id = ? AND chapter_index = ?').get(req.params.bid, novel.id, idx);
  if (!b) return res.status(404).json({ error: '历史版本不存在' });
  // 恢复前备份当前内容
  backupChapter(novel.id, idx, '恢复历史版本');
  db.prepare('UPDATE chapters SET title = ?, content = ?, word_count = ?, status = ? WHERE novel_id = ? AND chapter_index = ?')
    .run(b.title, b.content, countWords(b.content), 'draft', novel.id, idx);
  touchNovel(novel.id);
  try {
    await writeChapterTxt(novel, { chapter_index: idx, title: b.title, content: b.content });
  } catch { /* 文件写入失败不阻塞 */ }
  res.json({ ok: true, chapter: getChapter(novel.id, idx) });
});

// ---------- AI 味检测 ----------
router.post('/novels/:id/chapters/:idx/detect', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const idx = Number(req.params.idx);
  const chapter = getChapter(novel.id, idx);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  if (!chapter.content) return res.status(400).json({ error: '本章还没有内容可检测' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  try {
    const det = await runDetection(config, chapter.content);
    const hits = scanAiPatterns(chapter.content);
    const bl = blacklistFlagWords(hits);
    const total = Math.min(100, det.score + blacklistPenalty(hits));
    saveDetection(novel.id, idx, total, det.issues, bl, 'detect');
    res.json({
      ok: true,
      chapter_index: idx,
      score: total,
      detectScore: det.score,
      blacklist: bl,
      issues: det.issues,
      passed: total <= AI_SCORE_PASS && bl.length === 0
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 全书 AI 味走势：每章最近一次检测分数
router.get('/novels/:id/ai-trend', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const rows = db.prepare(
    `SELECT d.chapter_index, d.score, d.source, d.created_at
     FROM ai_detections d
     INNER JOIN chapters c ON c.novel_id = d.novel_id AND c.chapter_index = d.chapter_index
     WHERE d.novel_id = ? ORDER BY d.chapter_index, d.id`
  ).all(novel.id);
  const byChapter = new Map();
  for (const r of rows) byChapter.set(r.chapter_index, r);
  const points = [...byChapter.entries()]
    .map(([chapter_index, r]) => ({ chapter_index, score: r.score, source: r.source, created_at: r.created_at }))
    .sort((a, b) => a.chapter_index - b.chapter_index);
  res.json({ ok: true, points });
});

// 设置本作真人文风参照（真人作家片段，注入生成与润色）
router.post('/novels/:id/style-samples', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const samples = String(req.body?.samples || '').trim().slice(0, 20000);
  db.prepare("UPDATE novels SET style_samples = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(samples, novel.id);
  res.json({ ok: true, style_samples: samples });
});

// ---------- 文风基准提取 ----------
// 一键从已写章节提炼"本作文风基准"，切换模型后写法也能保持一致
router.post('/novels/:id/extract-style', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });
  const chapters = db.prepare(
    "SELECT chapter_index, title, content FROM chapters WHERE novel_id = ? AND content != '' ORDER BY chapter_index DESC LIMIT 3"
  ).all(novel.id);
  if (!chapters.length) return res.status(400).json({ error: '还没有已写章节，无法提取文风' });
  const sample = chapters.map((c) => `第${c.chapter_index}章 ${c.title}\n${c.content.slice(0, 2000)}`).join('\n\n').slice(0, 20000);

  try {
    const r = await chat({
      config,
      messages: [
        { role: 'system', content: STYLE_ANALYZE_SYSTEM },
        { role: 'user', content: `请分析以下本章本作最近章节的写作风格，提炼一段可作为长期基准的"文风说明"。\n\n【文本】\n${sample}` }
      ],
      maxTokens: 4096
    });
    const analysis = extractJson(r.content);
    if (!analysis) return res.status(400).json({ error: '文风提取失败，请重试' });
    const baseline = typeof analysis === 'object' && analysis !== null
      ? (analysis.overview || JSON.stringify(analysis))
      : String(analysis).trim();
    if (!baseline.trim()) return res.status(400).json({ error: '未能提炼出文风说明' });
    db.prepare("UPDATE novels SET style_baseline = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(baseline.trim(), novel.id);
    res.json({ ok: true, style_baseline: baseline.trim() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 风格库 ----------
function normalizeStyle(s) {
  if (!s) return null;
  try { s.analysis = JSON.parse(s.analysis || '{}'); } catch { s.analysis = {}; }
  return s;
}

router.get('/styles', (req, res) => {
  res.json(db.prepare('SELECT * FROM styles ORDER BY updated_at DESC').all().map(normalizeStyle));
});

router.get('/styles/:id', (req, res) => {
  const s = getStyle(req.params.id);
  if (!s) return res.status(404).json({ error: '风格不存在' });
  res.json(normalizeStyle(s));
});

// 导入文本并分析写作风格
router.post('/styles', async (req, res) => {
  const { name, notes, sourceText } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写风格名称' });
  if (!sourceText || !String(sourceText).trim()) return res.status(400).json({ error: '请粘贴要分析的小说文本' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const { ctrl, send, end } = startSSE(req, res);
  send({ type: 'status', message: '正在抽样文本并分析写作风格…' });

  const sample = sampleText(String(sourceText), 60000);

  try {
    const r = await chat({
      config,
      messages: [
        { role: 'system', content: STYLE_ANALYZE_SYSTEM },
        { role: 'user', content: `请分析以下小说文本的写作风格，输出风格分析 JSON。\n\n【文本开始】\n${sample}\n【文本结束】` }
      ],
      maxTokens: 8192
    });
    const analysis = extractJson(r.content);
    if (!analysis) {
      return end({ type: 'error', message: '风格分析失败：AI 返回内容无法解析，请重试或更换模型。' });
    }

    const info = db.prepare('INSERT INTO styles (name, notes, analysis, source_text) VALUES (?,?,?,?)')
      .run(String(name).trim(), notes || '', JSON.stringify(analysis), sample.slice(0, 20000));
    end({ type: 'done', data: { style: normalizeStyle(getStyle(info.lastInsertRowid)) } });
  } catch (e) {
    if (e.name === 'AbortError') return end({ type: 'aborted', message: '已停止' });
    return end({ type: 'error', message: e.message });
  }
});

router.put('/styles/:id', (req, res) => {
  const s = getStyle(req.params.id);
  if (!s) return res.status(404).json({ error: '风格不存在' });
  const sets = [];
  const vals = [];
  for (const f of ['name', 'notes']) {
    if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (req.body.analysis !== undefined) {
    sets.push('analysis = ?');
    vals.push(typeof req.body.analysis === 'string' ? req.body.analysis : JSON.stringify(req.body.analysis || {}));
  }
  if (sets.length) {
    vals.push(s.id);
    db.prepare(`UPDATE styles SET ${sets.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`).run(...vals);
  }
  res.json(normalizeStyle(getStyle(s.id)));
});

router.delete('/styles/:id', (req, res) => {
  db.prepare('DELETE FROM styles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 设置 ----------
function getLLMPresets() {
  try { return JSON.parse(getSetting('llm_presets', '[]')) || []; } catch { return []; }
}
function setLLMPresets(arr) {
  setSetting('llm_presets', JSON.stringify(arr));
}

router.get('/settings', (req, res) => {
  res.json({
    llm_config: getLLMConfig(),
    llm_models: getModels(),
    llm_tasks: TASK_TYPES,
    llm_presets: getLLMPresets(),
    novels_root: getNovelsRoot(),
    strict_ai_mode: getSetting('strict_ai_mode', '1'),
    managerSendBy: getSetting('manager_send_by', 'enter')
  });
});

router.put('/settings', async (req, res) => {
  const { llm_config, novels_root, migrate_novels, strict_ai_mode, managerSendBy } = req.body || {};
  if (llm_config && typeof llm_config === 'object') {
    setSetting('llm_config', JSON.stringify(llm_config));
  }
  if (strict_ai_mode !== undefined) {
    setSetting('strict_ai_mode', strict_ai_mode ? '1' : '0');
  }
  if (managerSendBy !== undefined) {
    const mode = String(managerSendBy) === 'ctrlEnter' ? 'ctrlEnter' : 'enter';
    setSetting('manager_send_by', mode);
  }
  if (novels_root !== undefined && String(novels_root).trim()) {
    try {
      await setNovelsRoot(novels_root, { migrate: !!migrate_novels });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  res.json({ ok: true, novels_root: getNovelsRoot(), strict_ai_mode: getSetting('strict_ai_mode', '1'), managerSendBy: getSetting('manager_send_by', 'enter') });
});

// ---------- LLM 预设管理 ----------
router.get('/settings/llm-presets', (req, res) => {
  res.json({ presets: getLLMPresets() });
});

router.post('/settings/llm-presets', (req, res) => {
  const { name, llm_config } = req.body || {};
  if (!name || !llm_config) return res.status(400).json({ error: '缺少预设名称或配置' });
  const presets = getLLMPresets();
  const id = Date.now().toString();
  presets.push({ id, name: String(name), llm_config, created_at: new Date().toISOString() });
  setLLMPresets(presets);
  res.json({ ok: true, preset: { id, name: String(name), llm_config } });
});

router.put('/settings/llm-presets/:pid', (req, res) => {
  const { name, llm_config } = req.body || {};
  const presets = getLLMPresets();
  const idx = presets.findIndex((p) => p.id === req.params.pid);
  if (idx < 0) return res.status(404).json({ error: '预设不存在' });
  if (name) presets[idx].name = String(name);
  if (llm_config) presets[idx].llm_config = llm_config;
  setLLMPresets(presets);
  res.json({ ok: true, preset: presets[idx] });
});

router.delete('/settings/llm-presets/:pid', (req, res) => {
  const presets = getLLMPresets().filter((p) => p.id !== req.params.pid);
  setLLMPresets(presets);
  res.json({ ok: true });
});

router.post('/settings/llm-presets/:pid/apply', (req, res) => {
  const preset = getLLMPresets().find((p) => p.id === req.params.pid);
  if (!preset) return res.status(404).json({ error: '预设不存在' });
  setSetting('llm_config', JSON.stringify(preset.llm_config));
  res.json({ ok: true, llm_config: preset.llm_config });
});

// ---------- 多 AI 大模型管理（同时启用多个模型，按任务路由） ----------
router.get('/settings/llm-models', (req, res) => {
  res.json({ models: getModels(), tasks: TASK_TYPES, active: getActiveModels() });
});

router.post('/settings/llm-models', (req, res) => {
  const { name, tasks, config } = req.body || {};
  const model = {
    id: genModelId(),
    name: String(name || '新模型'),
    enabled: true,
    tasks: Array.isArray(tasks) ? tasks : [],
    config: config || {}
  };
  const models = saveModels([...getModels(), model]);
  res.json({ ok: true, model, models });
});

router.put('/settings/llm-models/:mid', (req, res) => {
  const { name, enabled, tasks, config } = req.body || {};
  let models = getModels();
  const idx = models.findIndex((m) => m.id === req.params.mid);
  if (idx < 0) return res.status(404).json({ error: '模型不存在' });
  if (name !== undefined) models[idx].name = String(name);
  if (enabled !== undefined) models[idx].enabled = !!enabled;
  if (tasks !== undefined) models[idx].tasks = Array.isArray(tasks) ? tasks : [];
  if (config !== undefined) models[idx].config = config;
  models = saveModels(models);
  res.json({ ok: true, model: models[idx], models });
});

router.delete('/settings/llm-models/:mid', (req, res) => {
  const models = saveModels(getModels().filter((m) => m.id !== req.params.mid));
  res.json({ ok: true, models });
});

// 多模型路由测试：给定任务类型，返回实际会被使用到的模型配置（不含 apiKey 明文回显）
router.post('/settings/llm-models/route-test', (req, res) => {
  const { task } = req.body || {};
  const cfg = getTaskConfig(task);
  if (!cfg) return res.json({ routed: false });
  res.json({ routed: true, provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, hasKey: !!cfg.apiKey });
});

// ---------- 获取可用模型列表（OpenAI 兼容 /v1/models） ----------
router.post('/settings/models', async (req, res) => {
  const { llm_config } = req.body || {};
  const baseUrl = String(llm_config?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    return res.status(400).json({ error: '请先填写 API Base URL' });
  }
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = String(llm_config?.apiKey || '').trim();
  // 有 key 用 Authorization Bearer；无 key（如 ollama 本地）则不发 Authorization
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // 兼容多种 baseUrl 写法：
  //   https://api.openai.com/v1            -> /v1/models
  //   https://api.deepseek.com             -> /v1/models
  //   https://host/v1/chat/completions     -> 去掉尾部接口路径后 /v1/models
  let root = baseUrl.replace(/\/chat\/completions$/i, '');
  const endpoints = [];
  if (/\/v\d+$/i.test(root)) {
    endpoints.push(`${root}/models`);
    endpoints.push(`${root.replace(/\/v\d+$/i, '')}/v1/models`);
  } else {
    endpoints.push(`${root}/v1/models`);
    endpoints.push(`${root}/models`);
  }

  const tryFetch = async (endpoint) => {
    const resp = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.json())?.error?.message || resp.statusText; } catch { /* ignore */ }
      return { error: `获取模型列表失败（HTTP ${resp.status}）：${detail || resp.statusText}`, endpoint };
    }
    const data = await resp.json();
    let models = [];
    if (Array.isArray(data?.data)) {
      models = data.data.map((m) => {
        if (typeof m === 'object' && m !== null) {
          const tag = (m.object === 'model' && (m.owned_by || '').toUpperCase()) ? ` (${m.owned_by.toUpperCase()})` : '';
          return { id: String(m.id || ''), name: String(m.id || '') + tag };
        }
        return { id: String(m), name: String(m) };
      });
    } else if (Array.isArray(data)) {
      models = data.map((m) => ({ id: String(m.id || m), name: String(m.name || m.id || m) }));
    } else if (Array.isArray(data?.models)) {
      models = data.models.map((m) => ({ id: String(m.id || m), name: String(m.name || m.id || m) }));
    }
    return { models };
  };

  try {
    for (const endpoint of endpoints) {
      const r = await tryFetch(endpoint);
      if (r.error) continue;
      res.json({ ok: true, models: r.models, raw: true });
      return;
    }
    // 全部端点都失败：给出最后一个失败的详细信息
    const last = await tryFetch(endpoints[0]).catch(() => ({ error: '网络请求失败' }));
    res.status(502).json({ error: last.error || '获取模型列表失败，请检查 Base URL 是否正确。' });
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: `请求模型列表超时，请检查 Base URL (${baseUrl}) 是否正确。` });
    }
    res.status(502).json({ error: `获取模型列表失败：${e.message}` });
  }
});

router.post('/settings/test', async (req, res) => {
  const { llm_config } = req.body || {};
  if (!llm_config || !llm_config.baseUrl || !llm_config.model) {
    return res.status(400).json({ error: '请填写 Base URL 与模型名称' });
  }
  if (!llm_config.apiKey && llm_config.provider !== 'ollama') {
    return res.status(400).json({ error: '请填写 API Key' });
  }
  try {
    const r = await chat({
      config: llm_config,
      messages: [{ role: 'user', content: '回复"连接成功"四个字即可，不要输出其他内容。' }],
      maxTokens: 50
    });
    res.json({ ok: true, reply: (r.content || '').trim() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 生成任务 Job（多本并行状态恢复） ----------
router.get('/novels/:id/job', (req, res) => {
  const job = getActiveJobByNovel(req.params.id);
  res.json({ job });
});

router.get('/jobs/active', (req, res) => {
  res.json({ jobs: listActiveJobs() });
});

// ---------- 方案版本化（REQ-01 / REQ-02 / 待采纳修订） ----------
router.get('/novels/:id/plan/versions', (req, res) => {
  res.json({ versions: listVersions(req.params.id), pending: getLatestPending(req.params.id) });
});

router.get('/novels/:id/plan/pending', (req, res) => {
  const v = getLatestPending(req.params.id);
  if (!v) return res.status(404).json({ error: '暂无待采纳方案' });
  res.json({ version: v });
});

router.post('/novels/:id/plan/versions/:vid/accept', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const v = getVersion(req.params.vid);
  if (!v || v.novel_id !== novel.id) return res.status(404).json({ error: '版本不存在' });
  try {
    const result = await applyPlan(novel, v.snapshot, {});
    acceptVersionRow(v.id);
    const prevAccepted = listVersions(novel.id).find((x) => x.id !== v.id && x.accepted === 1);
    appendChangeLog(novel.id, prevAccepted?.version_no || null, v.version_no, v.feedback, '采纳候选方案');
    res.json({ novel: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/novels/:id/plan/versions/:vid/rollback', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const v = getVersion(req.params.vid);
  if (!v || v.novel_id !== novel.id) return res.status(404).json({ error: '版本不存在' });
  if (!v.accepted) return res.status(400).json({ error: '只能回滚到已被采纳过的版本' });
  try {
    const result = await applyPlan(novel, v.snapshot, {});
    appendChangeLog(novel.id, null, v.version_no, '', '回滚至历史版本');
    res.json({ novel: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/novels/:id/plan/draft', (req, res) => {
  res.json({ draft: getDraft(req.params.id) });
});

router.put('/novels/:id/plan/draft', (req, res) => {
  try {
    saveDraft(req.params.id, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// SSE 通道：Job 状态变化推给前端（多本并行时单连接接收全部 Job 事件）
router.get('/jobs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  write({ kind: 'snapshot', jobs: listActiveJobs() });
  const unsub = subscribeJobEvents((ev) => write(ev));
   req.on('close', () => unsub());
});

// ---------- Manager 总管 AI（tool-use，REQ-04 / REQ-05） ----------
// Phase 增强 2：manager_messages 阈值摘要压缩，避免长对话无限膨胀 token 预算
const MANAGER_MEMORY_THRESHOLD = 80;
async function compressManagerMemoryIfNeeded(novelId, config) {
  const win = novelId != null ? 'novel_id = ?' : 'novel_id IS NULL';
  const params = novelId != null ? [novelId] : [];
  const total = db.prepare(`SELECT COUNT(*) c FROM manager_messages WHERE ${win}`).get(...params).c;
  if (total < MANAGER_MEMORY_THRESHOLD) return;
  // 取前 N-40 行作为待压缩范围，保留最后 40 行原状
  const keep = 40;
  const take = total - keep;
  if (take < 10) return;
  const oldRows = db.prepare(`SELECT id, role, content, tool_name FROM manager_messages WHERE ${win} ORDER BY id ASC LIMIT ?`).all(...params, take);
  if (!oldRows.length) return;
  const transcript = oldRows.map((m) => `[${m.role}${m.tool_name ? `:${m.tool_name}` : ''}] ${String(m.content).slice(0, 200)}`).join('\n');
  let summary = '';
  try {
    const r = await chat({
      config,
      messages: [
        { role: 'system', content: '你是 AI 小说工坊总管 AI 的记忆压缩器。把长对话压缩成 4-8 条简洁要点，保留：用户关心的事实、已采纳决策、未完成事项。直接输出要点，不解释。' },
        { role: 'user', content: `把以下长对话压缩为长期记忆要点：\n\n${transcript}` }
      ],
      maxTokens: 800
    }).catch(() => null);
    summary = String(r?.content || '').trim();
  } catch { summary = ''; }
  if (summary) {
    try {
      db.prepare('INSERT INTO manager_memory (novel_id, kind, content) VALUES (?,?,?)')
        .run(novelId, 'summary', summary);
    } catch { /* ignore insert failure */ }
  }
  // 删除已压缩的旧消息（按 id 范围）
  const ids = oldRows.map((r) => r.id).filter(Boolean);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM manager_messages WHERE id IN (${placeholders})`).run(...ids);
  }
}

function managerSystemContext(novelId = null) {
  const active = listActiveJobs();
  const activeText = active.length
    ? '当前所有小说的后台生成任务：\n' + active.map((j) => `- novel ${j.novel_id} 阶段 ${j.stage} 状态 ${j.status} 进度 ${j.progress}`).join('\n')
    : '当前没有正在进行的生成任务。';
  const mem = novelId != null
    ? db.prepare('SELECT content FROM manager_memory WHERE (novel_id = ? OR novel_id IS NULL) ORDER BY id DESC LIMIT 12').all(novelId)
    : db.prepare('SELECT content FROM manager_memory WHERE novel_id IS NULL ORDER BY id DESC LIMIT 12').all();
  const memText = mem.length
    ? '\n\n【长期记忆（跨对话保留）】\n' + mem.map((m) => '- ' + String(m.content).replace(/\s+/g, ' ')).join('\n')
    : '';
  return `你是 AI 小说工坊的"总管 AI"，对所有小说创作有最高权限。

你可调用工具查看任意小说进度、修改大纲/角色、引入共享角色、触发修订或章节生成、联网搜索资料。你的记忆持久在后端，与所用大模型解耦——换模型不丢。

${SEARCH_SYSTEM_PROMPT}

${activeText}${memText}

行为准则：
1. 读类工具（含联网搜索）可直接用；写类工具必须由前端弹出授权条由作者确认后才会真正执行——你执行被拒绝时，体面地告知作者"未被授权"。
2. 沟通风格如真人作家总管，简洁自然，不堆术语。
3. 当作者询问另一本书进度时优先调 get_novel_progress。
4. 当作者说"查一下""搜一下"或涉及你不确定的事实/资料时，优先调 web_search 联网搜索。
5. 当你说要修改方案/章节时优先调 request_revise / request_generate_chapter 触发对应 worker；前端会显示候选方案供作者采纳。
6. 参考长期记忆条目，但若记忆与新事实冲突，以新事实为准。`;
}

router.post('/manager/chat', async (req, res) => {
  const novelId = req.body?.novel_id || null;
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  const { config, error } = requireLLM();

  // 无云端 LLM 时，降级到本地模式对话
  if (error && shouldUseLocal()) {
    db.prepare('INSERT INTO manager_messages (novel_id, role, content) VALUES (?, ?, ?)').run(novelId, 'user', content);
    const novel = novelId ? getNovel(novelId) : null;
    const characters = novelId ? getCharacters(novelId) : [];
    const foreshadowings = novelId ? getForeshadowings(novelId) : [];
    const ctx = { novel: novel ? {
      title: novel.title, genre: novel.genre, status: novel.status,
      chapter_count: novel.chapter_count, target_chapters: novel.target_chapters,
      character_count: characters.length
    } : null, characters, foreshadowings };
    const { send, end } = startSSE(req, res);
    try {
      const history = db.prepare('SELECT role, content FROM manager_messages WHERE (novel_id = ? OR novel_id IS NULL) ORDER BY id DESC LIMIT 10').all(novelId);
      const messages = [
        ...history.reverse().map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content }
      ];
      send({ type: 'status', message: '离线模式：正在用本地引擎回复…' });
      const result = await localChat({ messages, context: ctx, onDelta: (d) => send({ type: 'delta', content: d }) });
      db.prepare('INSERT INTO manager_messages (novel_id, role, content) VALUES (?, ?, ?)').run(novelId, 'assistant', result.content);
      return end({ type: 'done', data: { reply: result.content, offline: true, layer: result.layer || 'rules' } });
    } catch (e) {
      if (e.name === 'AbortError') return end({ type: 'aborted', message: '已停止' });
      return end({ type: 'error', message: e.message });
    }
  }

  if (error) return res.status(400).json({ error: error.message });

  db.prepare('INSERT INTO manager_messages (novel_id, role, content) VALUES (?, ?, ?)').run(novelId, 'user', content);

  // Phase 增强 2：若该 novel 消息>80 行，触发一次自动摘要：旧消息调 chat → 摘要写入 manager_memory → 删除覆盖范围内的 旧消息
  await compressManagerMemoryIfNeeded(novelId, config);

  const history = db.prepare('SELECT role, content, tool_name, tool_args, tool_call_id FROM manager_messages WHERE (novel_id = ? OR novel_id IS NULL) ORDER BY id DESC LIMIT 16').all(novelId);
  // 重放历史时跳过 role='tool' 及其配套的空 assistant 消息（tool_request），
  // 因为 DB 中未保存完整的 tool_calls 结构，直接重放会导致 API 400（tool 消息必须紧跟带 tool_calls 的 assistant）
  const cleanHistory = history.reverse().filter((m) => {
    if (m.role === 'tool') return false;
    if (m.role === 'assistant' && m.tool_name === 'tool_request' && !String(m.content || '').trim()) return false;
    return true;
  });
  const messages = [
    { role: 'system', content: managerSystemContext(novelId) },
    ...cleanHistory.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      return { role: m.role, content: m.content };
    })
  ];

  try {
    const tools = getToolSchemas();
    const r1 = await chat({
      config, task: 'chat', messages, tools, toolChoice: 'auto', maxTokens: Math.max(2048, Number(config.maxTokens) || 4096)
    }).catch((e) => ({ content: '', finishReason: 'error', error: e.message }));

    if (r1.error) {
      db.prepare('INSERT INTO manager_messages (novel_id, role, content) VALUES (?, ?, ?)').run(novelId, 'assistant', `出错：${r1.error}`);
      return res.json({ reply: `出错：${r1.error}`, toolCalls: [] });
    }

    let pending = [];
    if (Array.isArray(r1.toolCalls) && r1.toolCalls.length) {
      db.prepare('INSERT INTO manager_messages (novel_id, role, content, tool_name, tool_args, tool_call_id) VALUES (?,?,?,?,?,?)')
        .run(novelId, 'assistant', '', 'tool_request', JSON.stringify(r1.toolCalls.map((c) => c.name)), r1.toolCalls[0].id);

      for (const tc of r1.toolCalls) {
        const reg = toolRegistry[tc.name];
        if (!reg) { pending.push({ tool_call_id: tc.id, name: tc.name, args: tc.args, error: '未知工具' }); continue; }
        let parsed = {};
        try { parsed = JSON.parse(tc.args || '{}'); } catch { /* ignore */ }
        if (!reg.needsAuth) {
          const out = await reg.executor(parsed).catch((e) => ({ error: e.message }));
          db.prepare('INSERT INTO manager_messages (novel_id, role, content, tool_name, tool_call_id) VALUES (?,?,?,?,?)')
            .run(parsed.novel_id || novelId, 'tool', JSON.stringify(out), tc.name, tc.id);
        } else {
          const callId = randomUUID();
          try {
            db.prepare('INSERT INTO pending_tool_calls (id, novel_id, message_id, tool_name, args) VALUES (?,?,?,?,?)')
              .run(callId, parsed.novel_id || novelId, null, tc.name, JSON.stringify(parsed));
          } catch (e) {
            // 偶发 ID 冲突，再生成一次
            db.prepare('INSERT INTO pending_tool_calls (id, novel_id, message_id, tool_name, args) VALUES (?,?,?,?,?)')
              .run(randomUUID(), parsed.novel_id || novelId, null, tc.name, JSON.stringify(parsed));
          }
          pending.push({ id: callId, name: tc.name, args: parsed });
        }
      }

      if (pending.length) {
        return res.json({ reply: r1.content || '需要你授权以下操作后我才能继续：', pendingToolCalls: pending });
      }
      const history2 = db.prepare('SELECT role, content, tool_name, tool_call_id FROM manager_messages WHERE (novel_id = ? OR novel_id IS NULL) ORDER BY id DESC LIMIT 24').all(novelId);
      const cleanHistory2 = history2.reverse().filter((m) => {
        if (m.role === 'tool') return false;
        if (m.role === 'assistant' && m.tool_name === 'tool_request' && !String(m.content || '').trim()) return false;
        return true;
      });
      const msgs2 = [
        { role: 'system', content: managerSystemContext(novelId) },
        ...cleanHistory2.map((m) => ({ role: m.role, content: m.content }))
      ];
      const r2 = await chat({ config, task: 'chat', messages: msgs2, maxTokens: Math.max(1024, Number(config.maxTokens) || 2048) }).catch((e) => ({ content: '', error: e.message }));
      const reply = String(r2.content || '').trim() || '操作已执行';
      db.prepare('INSERT INTO manager_messages (novel_id, role, content) VALUES (?, ?, ?)').run(novelId, 'assistant', reply);
      return res.json({ reply, toolCalls: r1.toolCalls });
    }

    const reply = String(r1.content || '').trim() || '(总管未响应)';
    db.prepare('INSERT INTO manager_messages (novel_id, role, content) VALUES (?, ?, ?)').run(novelId, 'assistant', reply);
    res.json({ reply, toolCalls: [] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/manager/tool/:callId/authorize', async (req, res) => {
  const row = db.prepare('SELECT * FROM pending_tool_calls WHERE id = ?').get(req.params.callId);
  if (!row) return res.status(404).json({ error: '待授权工具调用不存在' });
  if (row.status !== 'pending') return res.status(400).json({ error: '该调用已处理：' + row.status });
  const reg = toolRegistry[row.tool_name];
  if (!reg) {
    db.prepare('UPDATE pending_tool_calls SET status = ? WHERE id = ?').run('failed', row.id);
    return res.status(400).json({ error: '未知工具：' + row.tool_name });
  }
  try {
    const args = JSON.parse(row.args || '{}');
    const out = await reg.executor(args).catch((e) => ({ error: e.message }));
    db.prepare('UPDATE pending_tool_calls SET status = ?, result = ? WHERE id = ?').run('done', JSON.stringify(out), row.id);
    db.prepare('INSERT INTO manager_messages (novel_id, role, content, tool_name, tool_call_id) VALUES (?,?,?,?,?)')
      .run(row.novel_id, 'tool', JSON.stringify(out), row.tool_name, row.id);
    res.json({ ok: true, result: out });
  } catch (e) {
    db.prepare('UPDATE pending_tool_calls SET status = ?, result = ? WHERE id = ?').run('failed', JSON.stringify({ error: e.message }), row.id);
    res.status(400).json({ error: e.message });
  }
});

router.post('/manager/tool/:callId/reject', (req, res) => {
  const row = db.prepare('SELECT * FROM pending_tool_calls WHERE id = ?').get(req.params.callId);
  if (!row) return res.status(404).json({ error: '不存在' });
  db.prepare('UPDATE pending_tool_calls SET status = ? WHERE id = ?').run('rejected', row.id);
  db.prepare('INSERT INTO manager_messages (novel_id, role, content, tool_name, tool_call_id) VALUES (?,?,?,?,?)')
    .run(row.novel_id, 'tool', JSON.stringify({ rejected: true }), row.tool_name, row.id);
  res.json({ ok: true });
});

router.get('/manager/messages', (req, res) => {
  const nid = req.query.novel_id ? Number(req.query.novel_id) : null;
  const rows = db.prepare('SELECT role, content, tool_name, tool_call_id, created_at FROM manager_messages WHERE (novel_id = ? OR novel_id IS NULL) ORDER BY id').all(nid);
  res.json({ messages: rows });
});

router.delete('/manager/messages', (req, res) => {
  const nid = req.query.novel_id ? Number(req.query.novel_id) : null;
  if (nid) db.prepare('DELETE FROM manager_messages WHERE novel_id = ?').run(nid);
  else db.prepare("DELETE FROM manager_messages WHERE novel_id IS NULL").run();
  res.json({ ok: true });
});

// ---------- manager memory 长期记忆（Phase 增强 2，路由已抽到 routes/managerMemory.js） ----------

// ---------- 共享角色池（Phase 增强 1，路由已抽到 routes/relationshipAndShared.js） ----------

// ---------- 知识学习库 ----------

// 导入小说 txt 学习
router.post('/knowledge/import', async (req, res) => {
  const { config, error } = requireLLM();
  const useOffline = error && shouldUseLocal();

  const { title, genre, author, content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: '小说内容不能为空' });
  if (!genre) return res.status(400).json({ error: '请选择小说题材' });

  const corpusId = createCorpus({ title: title || '未命名作品', genre, author });
  const { ctrl, send, end } = startSSE(req, res);
  send({ type: 'status', message: '正在解析文本并分块…' });

  try {
    const text = String(content);
    const chunkSize = 4000;
    const maxChunks = 30;
    const chunks = [];
    for (let i = 0; i < text.length && chunks.length < maxChunks; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    saveSamples(corpusId, chunks);
    updateCorpusStatus(corpusId, 'learning', { totalWords: text.length });
    send({ type: 'status', message: `已分块 ${chunks.length} 段，共 ${text.length} 字。` });

    // 无云端 LLM 时用离线统计分析
    if (useOffline) {
      send({ type: 'status', message: '离线模式：正在用统计分析引擎学习文笔特征…' });
      const report = offlineAnalyzeStyle(text.slice(0, 100000));
      const analysisText = JSON.stringify(report, null, 2);
      updateCorpusStatus(corpusId, 'learned', { analysis: analysisText, learnedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') });
      send({ type: 'status', message: '离线学习完成（统计分析模式）。连接大模型后可重新深入学习获得更精细的分析。' });
      const corpus = getCorpus(corpusId);
      return end({ type: 'done', data: { corpus, analysis: report, offline: true } });
    }

    send({ type: 'status', message: '正在用 AI 深度学习分析…' });

    const sample1 = chunks[0] || '';
    const midIdx = Math.floor(chunks.length / 2);
    const sample2 = chunks[midIdx] || '';
    const sample3 = chunks[chunks.length - 1] || '';
    const sampleText = `【开头片段】\n${sample1.slice(0, 3000)}\n\n【中段片段】\n${sample2.slice(0, 3000)}\n\n【结尾片段】\n${sample3.slice(0, 3000)}`;

    const r = await runLLMStream(config, [
      { role: 'system', content: KNOWLEDGE_LEARN_SYSTEM },
      { role: 'user', content: `这是一部${genre}题材的小说《${title || '未命名'}》。请分析其写作经验：\n\n${sampleText}` }
    ], {
      ctrl,
      task: 'research',
      maxTokens: 4000,
      onDelta: (d) => send({ type: 'delta', content: d })
    });

    const analysis = r?.content || '';
    const parsed = extractJson(analysis);
    const analysisText = parsed ? JSON.stringify(parsed, null, 2) : analysis;

    updateCorpusStatus(corpusId, 'learned', { analysis: analysisText, learnedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    send({ type: 'status', message: '学习完成！该知识库已可在新建小说时勾选使用。' });

    const corpus = getCorpus(corpusId);
    return end({ type: 'done', data: { corpus, analysis: parsed || analysis } });
  } catch (e) {
    const userAborted = e.name === 'AbortError' && ctrl.signal.aborted;
    if (userAborted) {
      updateCorpusStatus(corpusId, 'failed');
      return end({ type: 'aborted', message: '已停止' });
    }
    updateCorpusStatus(corpusId, 'failed');
    return end({ type: 'error', message: e.message });
  }
});

// 知识库列表
router.get('/knowledge/corpora', (req, res) => {
  const genre = req.query.genre;
  const rows = listCorpora(genre);
  res.json(rows);
});

// 知识库详情（含分析结果）
router.get('/knowledge/corpora/:id', (req, res) => {
  const corpus = getCorpus(Number(req.params.id));
  if (!corpus) return res.status(404).json({ error: '知识库不存在' });
  res.json(corpus);
});

// 知识库样本片段
router.get('/knowledge/corpora/:id/samples', (req, res) => {
  const rows = getSamples(Number(req.params.id));
  res.json({ samples: rows });
});

// 删除知识库
router.delete('/knowledge/corpora/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getCorpus(id)) return res.status(404).json({ error: '知识库不存在' });
  deleteCorpus(id);
  res.json({ ok: true });
});

// 按题材检索知识库（供前端新建小说时展示可选项）
router.get('/knowledge/by-genres', (req, res) => {
  const genres = String(req.query.genres || '').split(',').filter(Boolean);
  const rows = getKnowledgeByGenres(genres, 20);
  res.json(rows);
});

// ---------- 本地大模型 ----------

// 获取本地模型状态（三层降级）
router.get('/local-model/status', async (req, res) => {
  try {
    const status = await getLocalModelStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 探测 Ollama（手动触发）
router.post('/local-model/detect-ollama', async (req, res) => {
  try {
    const result = await detectOllama();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 设置 Ollama 模型
router.post('/local-model/ollama/select', (req, res) => {
  const { model, url } = req.body || {};
  if (model) setSetting('ollama_model', String(model));
  if (url) setSetting('ollama_url', String(url));
  res.json({ ok: true, model, url });
});

// 设置本地模式：auto / always / never
router.post('/local-model/mode', (req, res) => {
  const { mode } = req.body || {};
  const allowed = ['auto', 'always', 'never'];
  const m = allowed.includes(String(mode)) ? String(mode) : 'auto';
  setSetting('local_mode', m);
  res.json({ ok: true, mode: m });
});

// 设置 HuggingFace 镜像源（内置推理引擎模型下载用，国内网络常需 hf-mirror.com）
router.post('/local-model/hf-endpoint', (req, res) => {
  const { endpoint } = req.body || {};
  const e = String(endpoint || '').trim().replace(/\/+$/, '');
  if (e && !/^https?:\/\//i.test(e)) {
    return res.status(400).json({ error: '镜像地址需以 http:// 或 https:// 开头' });
  }
  setSetting('hf_endpoint', e);
  res.json({ ok: true, hfEndpoint: e });
});

// 离线学习（规则引擎+统计分析，不依赖 LLM）
router.post('/knowledge/corpora/:id/offline-learn', (req, res) => {
  try {
    const corpus = db.prepare('SELECT * FROM knowledge_corpora WHERE id = ?').get(Number(req.params.id));
    if (!corpus) return res.status(404).json({ error: '知识库不存在' });
    const samples = db.prepare('SELECT text FROM knowledge_samples WHERE corpus_id = ? ORDER BY chunk_index').all(Number(req.params.id));
    if (!samples.length) return res.status(400).json({ error: '该知识库没有文本样本' });
    const fullText = samples.map((s) => s.text).join('\n').slice(0, 100000);
    const report = offlineAnalyzeStyle(fullText);
    if (!report) return res.status(400).json({ error: '文本内容为空，无法分析' });
    const analysisText = JSON.stringify(report, null, 2);
    db.prepare("UPDATE knowledge_corpora SET status = 'learned', analysis = ?, learned_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?")
      .run(analysisText, Number(req.params.id));
    res.json({ ok: true, analysis: report });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 本地对话（管家离线模式）
router.post('/local-model/chat', async (req, res) => {
  const { messages, context } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages 不能为空' });
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  const { send, end } = startSSE(req, res);
  try {
    send({ type: 'status', message: '正在用本地模型生成回复…' });
    const result = await localChat({
      messages,
      onDelta: (d) => send({ type: 'delta', content: d }),
      signal: ctrl.signal,
      context
    });
    return end({ type: 'done', data: { content: result.content, layer: result.layer || 'rules' } });
  } catch (e) {
    if (e.name === 'AbortError') return end({ type: 'aborted', message: '已停止' });
    return end({ type: 'error', message: e.message });
  }
});

// 本地对话测试（非流式，简化版）
router.post('/local-model/chat-test', async (req, res) => {
  const { messages, sessionKey } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages 不能为空' });
  try {
    const result = await localChat({
      messages,
      context: { sessionKey }
    });
    res.json({ content: result.content, layer: result.layer || 'rules' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 自主学习触发（后台用本地模型跑分析）
router.post('/local-model/auto-learn', async (req, res) => {
  const novelId = Number(req.body?.novelId);
  try {
    const result = await autoLearnInBackground(novelId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 自主学习系统 — 启动/停止/状态
router.post('/local-model/auto-learn/start', async (req, res) => {
  try {
    const result = startAutoLearn();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/local-model/auto-learn/stop', async (req, res) => {
  try {
    const result = stopAutoLearn();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/local-model/auto-learn/status', async (req, res) => {
  try {
    const status = getAutoLearnStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/local-model/auto-learn/trigger', async (req, res) => {
  try {
    const status = triggerPendingTasks();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 手动入队任务
router.post('/local-model/auto-learn/enqueue', async (req, res) => {
  try {
    const { type, novelId, chapterId, corpusId } = req.body || {};
    const taskId = enqueueAutoLearnTask({ type, novelId: novelId ? Number(novelId) : undefined, chapterId: chapterId ? Number(chapterId) : undefined, corpusId: corpusId ? Number(corpusId) : undefined });
    res.json({ taskId, queued: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 本地知识图谱
router.get('/knowledge-graph/:novelId', async (req, res) => {
  try {
    const novelId = Number(req.params.novelId);
    const graph = buildNovelKnowledgeGraph(novelId);
    res.json(graph);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/knowledge-graph/analyze', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: '缺少 text 参数' });
    const graph = buildKnowledgeGraph(text);
    res.json(graph);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// RAG 缓存状态
router.get('/rag-cache/:novelId', async (req, res) => {
  try {
    const novelId = Number(req.params.novelId);
    const status = getRagCacheStatus(novelId);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// RAG 缓存清空
router.post('/rag-cache/clear', async (req, res) => {
  try {
    clearAllRagCache();
    res.json({ cleared: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// RAG 检索测试
router.post('/rag-cache/search', async (req, res) => {
  try {
    const { novelId, query, topK } = req.body || {};
    if (!novelId || !query) return res.status(400).json({ error: '缺少 novelId 或 query' });
    const results = retrieveRelevantCached(Number(novelId), query, topK || 5);
    res.json({ results, count: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Ollama 内置安装器 =====

// 检查安装状态
router.get('/ollama-installer/status', async (req, res) => {
  try {
    const installed = isOllamaInstalled();
    const progress = getInstallStatus();
    res.json({ installed, progress });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取推荐模型
router.get('/ollama-installer/models', async (req, res) => {
  try {
    const models = getRecommendedModels();
    res.json({ models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 一键安装 Ollama（SSE 流式进度）
router.post('/ollama-installer/install', async (req, res) => {
  const { send, end, ctrl } = startSSE(req, res);
  try {
    send({ type: 'status', message: '开始下载 Ollama 安装包…' });
    const result = await installOllama((progress) => {
      if (ctrl.signal.aborted) return;
      send({ type: 'progress', data: progress });
    });
    if (ctrl.signal.aborted) return;
    send({ type: 'status', message: `Ollama 安装成功！版本：${result.version}` });
    return end({ type: 'done', data: result });
  } catch (e) {
    return end({ type: 'error', message: e.message });
  }
});

// 拉取模型（SSE 流式进度）
router.post('/ollama-installer/pull', async (req, res) => {
  const { model } = req.body || {};
  if (!model) return res.status(400).json({ error: '缺少 model 参数' });
  const { send, end } = startSSE(req, res);
  try {
    send({ type: 'status', message: `开始拉取模型 ${model}…` });
    const result = await pullModel(model, (progress) => {
      send({ type: 'progress', data: progress });
    });
    send({ type: 'status', message: `模型 ${model} 拉取完成` });
    return end({ type: 'done', data: result });
  } catch (e) {
    return end({ type: 'error', message: e.message });
  }
});

// 本地章节生成（离线模式）
router.post('/local-model/generate-chapter', async (req, res) => {
  const { novelId, chapterNumber, targetWords } = req.body || {};
  const novel = getNovel(String(novelId));
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const characters = getCharacters(novel.id);
  const chapters = getChapters(novel.id);
  const chapterPlan = chapters.find((c) => c.chapter_index === Number(chapterNumber));
  if (!chapterPlan) return res.status(404).json({ error: '章节规划不存在' });

  const prevSummary = '';
  const { send, end } = startSSE(req, res);
  try {
    send({ type: 'status', message: '正在用本地模型生成章节内容…' });
    send({ type: 'progress', progress: 5, message: '正在用本地模型生成章节内容…' });
    const result = await localGenerateChapterSmart({
      novel,
      chapterPlan,
      characters,
      previousSummary: prevSummary,
      chapterNumber: Number(chapterNumber),
      targetWords: targetWords || novel.chapter_word_count || 2000,
      onDelta: (d) => send({ type: 'delta', content: d })
    });
    send({ type: 'progress', progress: 100, message: `生成完成（${result.wordCount}字，使用 ${result.layer}）` });
    send({ type: 'status', message: `生成完成（${result.wordCount}字，使用 ${result.layer}）` });
    return end({ type: 'done', data: result });
  } catch (e) {
    if (e.name === 'AbortError') return end({ type: 'aborted', message: '已停止' });
    return end({ type: 'error', message: e.message });
  }
});

// ===== 内置推理引擎（transformers.js）=====
router.get('/transformers/status', async (req, res) => {
  try {
    const status = await getTransformersStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/transformers/models', (req, res) => {
  res.json({ models: getBuiltinModels() });
});

router.post('/transformers/install', async (req, res) => {
  const { model } = req.body || {};
  const modelId = model || 'Xenova/Qwen2.5-0.5B-Instruct';
  const { send, end } = startSSE(req, res);
  try {
    send({ type: 'status', message: `正在下载内置模型 ${modelId}…` });
    const result = await installTransformersModel(modelId, (progress) => {
      send({ type: 'progress', data: progress });
    });
    send({ type: 'status', message: '模型安装完成，内置推理引擎已就绪' });
    return end({ type: 'done', data: result });
  } catch (e) {
    return end({ type: 'error', message: e.message });
  }
});

// ===== 取名系统 =====
router.get('/namegen', (req, res) => {
  const { genre, type = 'character', count = 5 } = req.query;
  const g = String(genre || '通用');
  const n = Math.min(20, Math.max(1, Number(count) || 5));
  try {
    let names;
    if (type === 'place') {
      names = Array.from({ length: n }, () => generatePlaceName(g));
    } else if (type === 'technique') {
      names = Array.from({ length: n }, () => generateTechniqueName());
    } else if (type === 'force') {
      names = Array.from({ length: n }, () => generateForceName(g));
    } else {
      names = generateNames(g, n);
    }
    // 去重
    names = [...new Set(names)];
    return res.json({ names, genre: normalizeGenre(g), type });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// AI 辅助取名（需要 LLM）
router.post('/namegen/ai', async (req, res) => {
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });
  const { genre, type = 'character', count = 5, context = '' } = req.body || {};
  try {
    const r = await chat({
      config,
      messages: [
        { role: 'system', content: NAMEGEN_SYSTEM },
        { role: 'user', content: `题材：${genre || '通用'}\n类型：${type}\n数量：${count}\n${context ? '背景信息：' + context : ''}\n\n请生成 ${count} 个${type === 'place' ? '地名' : type === 'technique' ? '功法名' : type === 'force' ? '势力名' : '角色名'}。` }
      ],
      maxTokens: 500
    });
    const arr = extractJson(r.content);
    if (Array.isArray(arr)) return res.json({ names: arr.map(String) });
    // fallback: 按行或顿号分割
    const names = (r.content || '').split(/[、\n，,]/).map((s) => s.trim()).filter(Boolean);
    return res.json({ names });
  } catch (e) {
    // 降级到规则引擎
    const names = type === 'place' ? Array.from({ length: count }, () => generatePlaceName(genre))
      : type === 'technique' ? Array.from({ length: count }, () => generateTechniqueName())
      : type === 'force' ? Array.from({ length: count }, () => generateForceName(genre))
      : generateNames(genre, count);
    return res.json({ names, fallback: true });
  }
});

// ===== 章节大纲细化（场景级 beat）=====
router.post('/novels/:id/chapters/:idx/beats', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });
  const idx = Number(req.params.idx);
  const chapter = getChapter(novel.id, idx);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  const characters = getCharacters(novel.id);
  try {
    const r = await chat({
      config,
      messages: [
        { role: 'system', content: CHAPTER_BEAT_SYSTEM },
        { role: 'user', content: `小说：《${novel.title}》题材：${novel.genre}\n第${idx}章 ${chapter.title}\n章节概要：${chapter.summary || '（无概要）'}\n角色：${characters.map((c) => c.name + '（' + c.role_type + '）').join('、')}\n\n请拆解为场景级 beat。` }
      ],
      maxTokens: 2000
    });
    const beats = extractJson(r.content);
    return res.json({ beats: Array.isArray(beats) ? beats : [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ===== 章节摘要自动生成（离线可用）=====
router.post('/novels/:id/chapters/:idx/auto-summary', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const idx = Number(req.params.idx);
  const chapter = getChapter(novel.id, idx);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  const content = chapter.content || '';
  if (!content || content.length < 10) return res.json({ summary: '', note: '章节内容过短，无法生成摘要' });

  // 有 LLM 时用 AI 生成
  const llmConfig = getLLMConfig();
  if (llmConfig.baseUrl) {
    try {
      const r = await chat({
        config: llmConfig,
        task: 'summary',
        messages: [
          { role: 'system', content: AUTO_SUMMARY_SYSTEM },
          { role: 'user', content: `第${idx}章 ${chapter.title}\n\n${content.slice(0, 4000)}` }
        ],
        maxTokens: 500
      });
      const summary = (r.content || '').trim();
      if (summary) {
        db.prepare('UPDATE chapters SET summary = ? WHERE id = ?').run(summary, chapter.id);
      }
      return res.json({ summary, source: 'ai' });
    } catch { /* 降级到离线 */ }
  }

  // 离线模式：用统计方式提取摘要
  const sentences = content.split(/[。！？\n]/).filter((s) => s.trim().length > 10);
  // 取前中后各几句作为摘要
  const picks = [];
  if (sentences.length > 0) picks.push(sentences[0].trim());
  if (sentences.length > 4) picks.push(sentences[Math.floor(sentences.length * 0.3)].trim());
  if (sentences.length > 8) picks.push(sentences[Math.floor(sentences.length * 0.6)].trim());
  if (sentences.length > 2) picks.push(sentences[sentences.length - 1].trim());
  const summary = picks.join('。') + '。';
  if (summary) {
    db.prepare('UPDATE chapters SET summary = ? WHERE id = ?').run(summary, chapter.id);
  }
  return res.json({ summary, source: 'offline' });
});

// ===== 情节连贯性检查 =====
router.post('/novels/:id/consistency-check', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });
  const { chapterIndex } = req.body || {};
  const chapters = getChapters(novel.id);
  const characters = getCharacters(novel.id);

  // 如果指定了章节，检查该章；否则检查最近 3 章
  let toCheck = [];
  if (chapterIndex) {
    const ch = getChapter(novel.id, Number(chapterIndex));
    if (ch) toCheck.push(ch);
  } else {
    toCheck = chapters.filter((c) => c.content).slice(-3);
  }
  if (!toCheck.length) return res.json({ issues: [], overall: 'consistent', note: '无可检查的章节' });

  try {
    const chapterText = toCheck.map((c) => `第${c.chapter_index}章 ${c.title}\n${c.content.slice(0, 3000)}`).join('\n\n');
    const kmText = formatKeyMoments(getKeyMoments(novel.id, 50));
    const charProfiles = formatCharacterProfiles(getCharacterProfiles(novel.id));
    const constitution = getConstitution(novel.id);
    const voices = formatCharacterVoices(novel.id);

    const r = await chat({
      config,
      messages: [
        { role: 'system', content: PLOT_CONSISTENCY_CHECK_SYSTEM },
        { role: 'user', content: `小说：《${novel.title}》题材：${novel.genre}\n\n角色档案：\n${charProfiles || '（无）'}\n\n角色语音：\n${voices || '（无）'}\n\n小说宪法：\n${constitution || '（无）'}\n\n关键事实：\n${kmText || '（无）'}\n\n待检查章节：\n${chapterText}` }
      ],
      maxTokens: 2000
    });
    const result = extractJson(r.content);
    return res.json(result || { issues: [], overall_consistency: 'consistent' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ===== 文笔风格学习+应用 =====
router.post('/novels/:id/style-learn', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });
  const { sampleText } = req.body || {};
  if (!sampleText || sampleText.length < 50) return res.status(400).json({ error: '样本文本过短，至少 50 字' });

  try {
    const r = await chat({
      config,
      messages: [
        { role: 'system', content: STYLE_LEARN_APPLY_SYSTEM },
        { role: 'user', content: `请分析以下文本的写作风格：\n\n${sampleText.slice(0, 4000)}` }
      ],
      maxTokens: 2000
    });
    const analysis = extractJson(r.content);
    // 将分析结果保存为小说的 style_baseline
    if (analysis) {
      const baseline = JSON.stringify(analysis, null, 2);
      db.prepare("UPDATE novels SET style_baseline = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(baseline, novel.id);
    }
    return res.json({ analysis, saved: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// 从已有章节学习文笔风格
router.post('/novels/:id/style-learn-from-chapters', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });
  const { chapterCount = 3 } = req.body || {};
  const chapters = getChapters(novel.id).filter((c) => c.content);
  if (!chapters.length) return res.status(400).json({ error: '还没有已写章节可学习' });

  // 取最近 N 章的前 1500 字作为样本
  const samples = chapters.slice(-chapterCount).map((c) => c.content.slice(0, 1500)).join('\n\n');
  try {
    const r = await chat({
      config,
      messages: [
        { role: 'system', content: STYLE_LEARN_APPLY_SYSTEM },
        { role: 'user', content: `请分析以下来自《${novel.title}》的已有章节文本，提炼出本书的写作风格指南：\n\n${samples}` }
      ],
      maxTokens: 2000
    });
    const analysis = extractJson(r.content);
    if (analysis) {
      const baseline = JSON.stringify(analysis, null, 2);
      db.prepare("UPDATE novels SET style_baseline = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(baseline, novel.id);
    }
    return res.json({ analysis, saved: true, chaptersUsed: Math.min(chapterCount, chapters.length) });
  } catch (e) {
    // LLM 失败时降级到离线统计
    try {
      const offlineAnalysis = offlineLearnNovelStyle(novel.id);
      if (offlineAnalysis) {
        const baseline = JSON.stringify(offlineAnalysis, null, 2);
        db.prepare("UPDATE novels SET style_baseline = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(baseline, novel.id);
        return res.json({ analysis: offlineAnalysis, saved: true, source: 'offline' });
      }
    } catch { /* 离线也失败 */ }
    return res.status(500).json({ error: e.message });
  }
});

// 离线风格学习（不需要 LLM）
router.post('/novels/:id/style-learn-offline', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  try {
    const analysis = offlineLearnNovelStyle(novel.id);
    if (!analysis) return res.status(400).json({ error: '还没有已写章节可学习' });
    const baseline = JSON.stringify(analysis, null, 2);
    db.prepare("UPDATE novels SET style_baseline = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(baseline, novel.id);
    return res.json({ analysis, saved: true, source: 'offline' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ===== 题材模板查询 =====
router.get('/genre-templates/:genre', (req, res) => {
  const genre = req.params.genre;
  try {
    const tpl = getGenreTemplates(genre);
    return res.json({
      genre: tpl.genre,
      sampleDialogs: tpl.dialogs.slice(0, 3),
      sampleNarration: tpl.narration.slice(0, 3),
      sampleActions: tpl.actions.slice(0, 3),
      samplePlaces: tpl.places.slice(0, 3),
      sampleEmotions: tpl.emotions.slice(0, 3),
      sampleTwists: tpl.twists.slice(0, 3),
      sampleFutures: tpl.futures.slice(0, 3),
      dialogCount: tpl.dialogs.length,
      narrationCount: tpl.narration.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ===== 角色性格感知台词生成 =====
router.post('/novels/:id/character-dialog', (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { characterName } = req.body || {};
  if (!characterName) return res.status(400).json({ error: '缺少角色名' });
  const characters = getCharacters(novel.id);
  const char = characters.find((c) => c.name === characterName);
  if (!char) return res.status(404).json({ error: '角色不存在' });
  const dialog = generatePersonalityDialog(char.personality || '', novel.genre);
  return res.json({ character: char.name, personality: char.personality, dialog });
});

// ===== 剧情弧线规划 =====
router.post('/novels/:id/arc-plan', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const characters = getCharacters(novel.id);
  const factions = getFactions(novel.id);
  const chapters = getChapters(novel.id);
  const writtenChapters = chapters.filter((c) => c.word_count > 0);
  const plannedChapters = chapters.filter((c) => !c.word_count);

  const context = `作品信息：
标题：${novel.title}
类型：${novel.genre}
世界观：
${novel.world_view || '（未设定）'}
剧情大纲：
${novel.outline || '（未设定）'}

已写章节概要（${writtenChapters.length} 章）：
${writtenChapters.slice(-20).map((c) => `第${c.chapter_index}章 ${c.title}：${c.summary || '（无概要）'}`).join('\n') || '（尚无已写章节）'}

待写章节规划（${plannedChapters.length} 章）：
${plannedChapters.slice(0, 30).map((c) => `第${c.chapter_index}章 ${c.title}：${c.summary || ''}`).join('\n') || '（尚无规划）'}

主要角色：
${characters.map((c) => `- ${c.name}（${c.role_type}）：${c.personality || ''}${c.goal ? ' 目标：' + c.goal : ''}`).join('\n')}

势力：
${factions.map((f) => `- ${f.name}（${f.type}）：${f.description || ''}`).join('\n')}`;

  try {
    const r = await chat({ config, messages: [
      { role: 'system', content: ARC_PLAN_SYSTEM },
      { role: 'user', content: context + '\n\n请规划全书（或后续）的剧情弧线。' }
    ], maxTokens: 8192 });
    const plan = extractJson(r.content);
    if (!plan) return res.status(502).json({ error: 'AI 返回内容无法解析', raw: r.content });
    if (plan.arcs) {
      db.prepare('UPDATE novels SET story_arcs = ? WHERE id = ?').run(JSON.stringify(plan.arcs), novel.id);
      touchNovel(novel.id);
    }
    res.json(plan);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 世界设定细化 =====
router.post('/novels/:id/world-expand', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const characters = getCharacters(novel.id);
  const factions = getFactions(novel.id);
  const worldSettings = getWorldSettings(novel.id);

  const context = `作品信息：
标题：${novel.title}
类型：${novel.genre}
现有世界观概述：
${novel.world_view || '（未设定）'}

现有世界设定条目：
${worldSettings.map((w) => `- ${w.category || '通用'}：${w.content}`).join('\n') || '（无）'}

主要角色：
${characters.map((c) => `- ${c.name}（${c.role_type}）：${c.personality || ''}${c.ability ? ' 能力：' + c.ability : ''}`).join('\n')}

势力：
${factions.map((f) => `- ${f.name}（${f.type}）：${f.description || ''}`).join('\n')}`;

  try {
    const r = await chat({ config, messages: [
      { role: 'system', content: WORLD_EXPAND_SYSTEM },
      { role: 'user', content: context + '\n\n请将世界观细化为可操作的设定文档。' }
    ], maxTokens: 8192 });
    const expanded = extractJson(r.content);
    if (!expanded) return res.status(502).json({ error: 'AI 返回内容无法解析', raw: r.content });
    db.prepare('UPDATE novels SET expanded_world = ? WHERE id = ?').run(JSON.stringify(expanded), novel.id);
    touchNovel(novel.id);
    res.json(expanded);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 章节情绪曲线分析 =====
router.post('/novels/:id/emotion-curve', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const { start, end } = req.body || {};
  const chapters = getChapters(novel.id);
  let range = chapters;
  if (start && end) {
    range = chapters.filter((c) => c.chapter_index >= start && c.chapter_index <= end);
  } else {
    range = chapters.slice(0, 50);
  }

  if (!range.length) return res.status(400).json({ error: '没有可分析的章节' });

  const chapterList = range.map((c) => `第${c.chapter_index}章 ${c.title}：${c.summary || '（无概要）'}`).join('\n');

  try {
    const r = await chat({ config, messages: [
      { role: 'system', content: EMOTION_CURVE_SYSTEM },
      { role: 'user', content: `以下是小说《${novel.title}》的章节序列：\n${chapterList}\n\n请分析情绪曲线和节奏配比。` }
    ], maxTokens: 4096 });
    const result = extractJson(r.content);
    if (!result) return res.status(502).json({ error: 'AI 返回内容无法解析', raw: r.content });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 联网搜索 =====
router.post('/search', async (req, res) => {
  const { query, engine, fetchContent } = req.body || {};
  if (!query || !String(query).trim()) return res.status(400).json({ error: '请输入搜索关键词' });
  const searchEngine = engine || getSetting('search_engine', 'duckduckgo');
  try {
    const data = await webSearch(query, {
      engine: searchEngine,
      searxUrl: getSetting('searx_url', ''),
      bingApiKey: getSetting('bing_api_key', ''),
      bingEndpoint: getSetting('bing_endpoint', ''),
      count: 10,
      fetchContent: fetchContent !== false
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取/保存搜索引擎设置
router.get('/search/settings', (req, res) => {
  res.json({
    search_engine: getSetting('search_engine', 'duckduckgo'),
    searx_url: getSetting('searx_url', ''),
    bing_api_key: getSetting('bing_api_key', ''),
    bing_endpoint: getSetting('bing_endpoint', '')
  });
});

router.put('/search/settings', (req, res) => {
  const { search_engine, searx_url, bing_api_key, bing_endpoint } = req.body || {};
  if (search_engine !== undefined) setSetting('search_engine', search_engine);
  if (searx_url !== undefined) setSetting('searx_url', searx_url);
  if (bing_api_key !== undefined) setSetting('bing_api_key', bing_api_key);
  if (bing_endpoint !== undefined) setSetting('bing_endpoint', bing_endpoint);
  res.json({ ok: true });
});

export default router;
