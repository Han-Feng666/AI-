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
  scanAiPatterns, blacklistPenalty, blacklistFlagWords, cleanAiText, scanTopicDrift,
  scanStructureBalance, scanCrossChapterRepeats, longestDuplicateLength,
  scanTimelineContradiction, scanKinshipTitleConflict, scanSceneElementMismatch,
  normalizeLLMConfig, estimateTokens,
  parseTxtChapters
} from './lib.js';
import {
  getNovelsRoot, ensureRoot, setNovelsRoot, ensureNovelFolder, novelFolderPath,
  writeChapterTxt, deleteChapterTxt, renameNovelFolder, deleteNovelFolder,
  readMemoryFile, writeMemoryFile
} from './storage.js';
import { chat, contextBudget } from './llm.js';
import { acquire as rateLimitAcquire, onRateLimited, getLimiterState, resetLimiter } from './rate_limit.js';
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
  CHAPTER_BEAT_SYSTEM, PLAN_BEATS_SYSTEM, WRITING_QUALITY_SYSTEM, AUTO_SUMMARY_SYSTEM, STORY_READABILITY_SYSTEM, STYLE_LEARN_APPLY_SYSTEM, NAMEGEN_SYSTEM,
  ARC_PLAN_SYSTEM, WORLD_EXPAND_SYSTEM, EMOTION_CURVE_SYSTEM,
  ADAPTATION_PLAN_SYSTEM, ADAPTATION_CHAPTER_SYSTEM, LYRICS_TO_NOVEL_SYSTEM,
  IDEAS_SYSTEM,
  buildNovelContext, buildChapterSystem, buildPolishSystem,
  buildPolishWithIssues, buildPlotFixSystem, extractJson, buildReviseSystem,
getGenreGuide, getGenreGuides
} from './prompts.js';
import {
  createJob, updateJob, getJob, listJobsByNovel, getActiveJobByNovel,
  listActiveJobs, tryCreateJob, subscribeJobEvents, abortJob
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
import { getNovelSkillIds, getSkills, formatSkillsBlock, parseSkillFile, recommendSkillsForGenre } from './skill_store.js';
import { KNOWLEDGE_LEARN_SYSTEM, KNOWLEDGE_SAMPLE_INTRO, PER_CHUNK_ANALYSIS_SYSTEM, FINAL_SYNTHESIS_SYSTEM } from './prompts.js';
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
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const end = (obj) => {
    finished = true;
    stopKeepalive();
    if (obj) send(obj);
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  // keepalive：每 15 秒发心跳注释，防止前端 idle 超时误杀长耗时任务
  keepaliveTimer = setInterval(() => {
    if (!finished && !res.writableEnded && !res.destroyed) {
      try { res.write(`:keepalive\n\n`); } catch { ctrl.abort(); }
    }
  }, 15000);
  return { ctrl, send, end };
}

// ---------- AI 味检测与质量门（铁律模式） ----------
const AI_SCORE_PASS_DEFAULT = 15; // 达标阈值（原 20，进一步调严）：该分以下视为合格的人类文风
const AI_MAX_ROUNDS = 3;  // 质量门最多迭代轮数
const MAX_AUTO_REGENERATE = 2; // 整章重生成最多额外重试次数（共生成 1+2=3 版）

// 质量门评分阈值（可配置，设置页 ai_score_pass 覆盖默认值）
function aiScorePass() {
  const v = Number(getSetting('ai_score_pass', String(AI_SCORE_PASS_DEFAULT)));
  return Number.isFinite(v) && v > 0 ? v : AI_SCORE_PASS_DEFAULT;
}

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

// 故事可读性检测：文笔干净不等于看得下去。评分 6 个维度，平均≤5 或任一维度≤4 判为 rewrite，
// 其 issues 小句进入整章重生成反馈，让模型知道自己差在哪、往哪引爆
async function runReadability(config, text) {
  const r = await chat({
    config,
    task: 'analysis',
    messages: [
      { role: 'system', content: STORY_READABILITY_SYSTEM },
      { role: 'user', content: `请评估以下章节的故事可读性。\n\n${sampleText(String(text), 6000)}` }
    ],
    maxTokens: 2200
  });
  const rv = extractJson(r.content) || {};
  const pd = rv.per_dimension && typeof rv.per_dimension === 'object' ? rv.per_dimension : {};
  const dims = ['curiosity', 'desire', 'tension', 'emotion', 'hook', 'momentum'];
  const scores = dims.map((k) => {
    const v = Number(pd[k]);
    return Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : null;
  });
  // 解析失败（各维度都取不到有效分数）时不误判为 rewrite，视为 pass（宁放行不误伤）
  const hasValidScore = scores.some((v) => v !== null);
  const validScores = scores.filter((v) => v !== null);
  const average = validScores.length ? validScores.reduce((a, b) => a + b, 0) / validScores.length : 0;
  const anyLow = dims.some((k, i) => scores[i] !== null && scores[i] <= 4);
  const verdict = !hasValidScore
    ? 'pass'
    : (rv.verdict === 'rewrite' || rv.verdict === 'fail' || average <= 5 || anyLow ? 'rewrite' : 'pass');
  return {
    average: Math.round(average * 10) / 10,
    verdict,
    issues: Array.isArray(rv.issues)
      ? rv.issues.filter((i) => i && i.quote)
      : []
  };
}

// 质量门核心：润色 → 检测 → 未达标再润色（带上轮 issues + 黑名单），直到达标或达轮次上限
async function iteratePolish(config, novel, text, { onStatus, maxRounds = AI_MAX_ROUNDS, opts = {} } = {}) {
  let current = String(text || '').trim();
  let lastDetect = { score: 0, issues: [] };
  let blacklist = [];
  const rounds = [];

  for (let round = 0; round < maxRounds; round++) {
    const hitsBefore = scanAiPatterns(current);
    const flagWords = blacklistFlagWords(hitsBefore, current.length);

    if (onStatus) {
      onStatus(round === 0 ? '正在去除 AI 味…' : `检测到 AI 味，正在再润色（第 ${round + 1} 轮）…`);
      if (flagWords.length) onStatus(`高频复用 AI 腔词：${flagWords.join('、')}，将改写冗余复用处…`);
    }

    const pRes = await chat({
      config,
      task: 'writing',
      messages: [
        { role: 'system', content: buildPolishWithIssues(
          getStyles(parseStyleIds(novel)),
          novel.style_baseline,
          novel.style_samples,
          round === 0 ? (opts.extraIssues || []) : lastDetect.issues,
          flagWords,
          parseStylePresets(novel),
          opts
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
    blacklist = blacklistFlagWords(hitsAfter, current.length);
    const total = Math.min(100, det.score + blacklistPenalty(hitsAfter, current.length));
    rounds.push({ round: round + 1, detectScore: det.score, blacklistPenalty: blacklistPenalty(hitsAfter, current.length), score: total, blacklist });
    if (onStatus && blacklist.length) onStatus(`仍高频复用 AI 腔词：${blacklist.join('、')}…`);

    if (total <= aiScorePass() && blacklist.length === 0) break;
  }
  return { text: current, lastDetect, blacklist, rounds };
}

// 剧情逻辑修复循环：根据 checkPlotConsistency 检测出的问题逐条修复，保持文风/人设不变
async function iteratePlotFix(config, novel, text, issues, { onStatus } = {}) {
  if (!issues || !issues.length) return { text: String(text || '').trim(), fixed: false };
  const highIssues = issues.filter((i) => i.severity === 'high' || i.severity === 'medium');
  if (!highIssues.length) return { text: String(text || '').trim(), fixed: false };
  if (onStatus) onStatus(`检测到 ${highIssues.length} 处剧情逻辑问题，正在修复…`);

  let current = String(text || '').trim();
  for (let round = 0; round < 2; round++) {
    const issueList = highIssues
      .slice(0, 6)
      .map((it, i) => `${i + 1}. 【${it.type}】${it.description}${it.quote ? `（原文："${it.quote}"）` : ''}`)
      .join('\n');

    const r = await chat({
      config,
      task: 'writing',
      messages: [
        { role: 'system', content: buildPlotFixSystem(
          getStyles(parseStyleIds(novel)),
          novel.style_baseline,
          novel.style_samples,
          parseStylePresets(novel)
        ) },
        { role: 'user', content: `以下是一章小说正文，存在剧情逻辑问题。请按上面列出的问题逐条修复，保持文风与人设不变。

【需要修复的逻辑问题】
${issueList}

【原文】
${current}` }
      ],
      maxTokens: Math.max(4000, Math.min(32000, (current.length + 2000) * 2))
    });

    const fixed = (r.content || '').trim();
    if (!fixed || fixed.length < current.length * 0.3) break;
    current = fixed;

    // 复检：如果修复后问题消失就不再迭代
    if (round === 0) {
      const recheck = await checkPlotConsistency(novel.id, -1, current, config).catch(() => null);
      if (recheck && recheck.overall_consistency === 'consistent') {
        if (onStatus) onStatus('逻辑问题已全部修复');
        break;
      }
      if (recheck && recheck.overall_consistency === 'minor_issues') {
        if (onStatus) onStatus('主要逻辑问题已修复，剩余轻微问题不影响阅读');
        break;
      }
    }

    if (onStatus) onStatus(`正在做第 ${round + 2} 轮逻辑修复…`);
  }
  return { text: current, fixed: true };
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

// 多模型交叉评审：从已启用的多模型配置里挑一个与当前写作模型不同的可用模型，
// 作为"第二读者"做终审。单模型环境返回 null（调用方跳过，不增加成本）。
function pickReviewerConfig(currentConfig) {
  try {
    const cur = normalizeLLMConfig(currentConfig || {});
    for (const m of getModels()) {
      if (!m || !m.enabled) continue;
      const raw = m.config || {};
      if (!raw.model) continue;
      const usable = raw.provider === 'ollama' || raw.provider === 'transformers' ? true : !!raw.apiKey;
      if (!usable) continue;
      if ((raw.baseUrl || '') === (cur.baseUrl || '') && raw.model === cur.model) continue;
      return normalizeLLMConfig(raw);
    }
  } catch { /* 交叉评审选择失败则跳过 */ }
  return null;
}

function runLLMStream(config, messages, { onDelta, ctrl, maxTokens, task, timeout, streamIdleTimeout } = {}) {
  // 流式调用默认给更长空闲阈值（10 分钟）：思考型模型开头可能长时间无流式输出，300s 会被误杀
  const idleTimeout = Number(streamIdleTimeout) > 0 ? streamIdleTimeout : 600000;
  if (config?.forceNonStreaming) {
    return chat({
      config,
      task,
      messages,
      maxTokens,
      signal: ctrl?.signal,
      timeout: timeout || 600000
    }).then((r) => {
      if (r?.content && onDelta) onDelta(r.content);
      return r;
    });
  }
  return chat({
    config,
    task,
    messages,
    maxTokens,
    signal: ctrl?.signal,
    onDelta,
    streamIdleTimeout: idleTimeout
  });
}

// 429（限流/配额）识别：兼容 "HTTP 429"、"rpm exhausted"、"rate limit"、"too many requests"、"quota"
function isRateLimitError(e) {
  return /429|quota|too many|rate limit|rpm/i.test(e?.message || '');
}

function isTimeoutError(e) {
  return /超时|timeout|请求超时|网络请求失败|连接中断/i.test(e?.message || '');
}

/**
 * 批量分块分析（风格库 / 学习知识库共用）。
 * 通过全局限速器控制请求速率，避免打满模型服务商 RPM 触发 429 后整体失败：
 * - 每个 LLM 请求前 await rateLimit.acquire()
 * - 429 时进入冷却并降低速率，最多重试 4 次（含退避），仍失败才放弃该块
 * - 超时按指数退避重试 3 次
 * @param {object} opts
 * @param {object} opts.config LLM 配置
 * @param {object} opts.ctrl SSE AbortController
 * @param {string[]} opts.chunks 分块文本数组
 * @param {(chunk:string, chunkIndex:number) => string} opts.buildUserMessage 构造第 chunkIndex 块的 user prompt
 * @param {object} opts.sse { send }
 * @returns {Promise<Array>} 各块成功解析的分析结果
 */
async function analyzeChunksRateLimited({ config, ctrl, chunks, buildUserMessage, sse }) {
  const signal = ctrl?.signal;
  const sleepWithSignal = (ms) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  const partialResults = [];
  const concurrency = 5;
  let totalDone = 0;
  const report = () => sse.send({
    type: 'progress',
    progress: 5 + Math.round((totalDone / chunks.length) * 70),
    message: `正在分析（${totalDone}/${chunks.length} 块）…`
  });

  for (let batchStart = 0; batchStart < chunks.length; batchStart += concurrency) {
    const batch = chunks.slice(batchStart, Math.min(batchStart + concurrency, chunks.length));
    const tasks = batch.map((chunk, idx) =>
      (async () => {
        const chunkIndex = batchStart + idx;
        for (let attempt = 1; attempt <= 4; attempt++) {
          try {
            await rateLimitAcquire(signal);
            const r = await runLLMStream(config, [
              { role: 'system', content: PER_CHUNK_ANALYSIS_SYSTEM },
              { role: 'user', content: buildUserMessage(chunk, chunkIndex) }
            ], {
              ctrl,
              maxTokens: 1500,
              streamIdleTimeout: 600000
            });
            totalDone++;
            report();
            return r ? extractJson(r.content) : null;
          } catch (e) {
            if (ctrl?.signal?.aborted) throw new Error('AbortError');
            if (isRateLimitError(e) && attempt < 4) {
              onRateLimited(e.retryAfter);
              sse.send({ type: 'status', message: `分析请求触发限流，已降低速率并在冷却后自动重试（第 ${attempt} 次）…` });
              continue;
            }
            if (isTimeoutError(e) && attempt < 3) {
              await sleepWithSignal(Math.pow(2, attempt) * 3000);
              continue;
            }
            // 非可重试错误：该块跳过，不计入 totalDone
            return null;
          }
        }
        // 4 次重试用尽仍失败：该块跳过，不计入 totalDone
        return null;
      })()
    );

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'rejected') {
        if (result.reason?.message === 'AbortError') throw result.reason;
        continue;
      }
      if (result.value) partialResults.push(result.value);
    }
  }
  return partialResults;
}

/**
 * 综合合成请求（风格库 / 知识库共用的最后一步），带限速与 429 自适应重试。
 * @param {object} opts
 * @param {object} opts.config LLM 配置
 * @param {object} opts.ctrl SSE AbortController
 * @param {string} opts.system 综合阶段的 system prompt
 * @param {string} opts.user 综合阶段的 user prompt
 * @param {object} opts.sse { send }
 * @returns {Promise<{content:string}>} 综合请求结果
 */
async function synthesizeWithRateLimit({ config, ctrl, system, user, sse }) {
  const signal = ctrl?.signal;
  const sleepWithSignal = (ms) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await rateLimitAcquire(signal);
      return await runLLMStream(config, [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ], {
        ctrl,
        task: 'research',
        maxTokens: 4000,
        streamIdleTimeout: 600000,
        onDelta: (d) => sse.send({ type: 'delta', content: d })
      });
    } catch (e) {
      if (ctrl?.signal?.aborted) throw new Error('AbortError');
      if (isRateLimitError(e) && attempt < 4) {
        onRateLimited(e.retryAfter);
        const waitSec = Math.max(5, Math.round(getLimiterState().cooldownSeconds));
        sse.send({ type: 'status', message: `综合合成请求限流，已降低速率并在 ${waitSec} 秒冷却后重试（第 ${attempt} 次）…` });
        continue;
      }
      if (isTimeoutError(e) && attempt < 3) {
        await sleepWithSignal(Math.pow(2, attempt) * 3000);
        continue;
      }
      throw e;
    }
  }
  throw new Error('综合合成请求多次失败，请稍后重试或检查模型状态。');
}

// 续写提示：截取已写末尾，要求紧接续写至自然收尾，不重复内容
// 注入本书角色身份锚点，防止续写时张冠李戴（谁死谁活、谁受伤、谁在场必须与已写正文严格一致）
function buildCharacterAnchor(chars) {
  const list = (chars || []).filter((c) => c && c.name).slice(0, 12);
  if (!list.length) return '';
  const lines = list.map((c) => `- ${c.name}（${c.role_type || '角色'}）${c.personality ? '：' + c.personality : ''}`);
  const protagonists = list.filter((c) => String(c.role_type || '').includes('主角')).map((c) => c.name);
  return `【本书关键角色（续写时严格保持身份，不得张冠李戴）】
${lines.join('\n')}
${
  protagonists.length
    ? `\n本书主角：${protagonists.join('、')}。正文中角色的生死、伤势、在场状态一律以已写正文为准——谁死谁活、谁受伤、谁做了什么，必须严格对应该角色，严禁把 A 的遭遇写到 B 头上，尤其不得把 NPC 的死亡错写成主角死亡。`
    : '\n正文中角色的生死、伤势、在场状态一律以已写正文为准，严禁张冠李戴。'
}`;
}

function buildContinuePrompt(full, targetWordsN, characters) {
  const tail = String(full).slice(-1200);
  const anchor = buildCharacterAnchor(characters);
  return `你是本章小说的作者。下面是本章已经写好的正文末尾，你正在一贯地继续往下写，绝无其他人会插入或提供内容——请直接从最后一句话的最后一个字往后接，用同样的人称、视角和文风继续铺陈剧情。

要求：
- 只写正文，不要写"请提供""【末尾节选】""已写部分未完"之类的说明、不要输出标题、不要总结、不要空行占位、不要回复用户。
- 承接上一句的语感和情境，自然往下推进，不要重复已经写过的句子。
- 严格保持角色身份与生死一致性：谁死谁活、谁受伤、谁在场，一律沿用已写正文，不得张冠李戴、不得让已死角色复活、不得把死亡安错到角色头上。
- 禁止编造不存在的对话回忆：角色"回想起""想起""记得"的对话或事件，必须是本章前面已经明确写过的内容，不得编造本章未出现的对话或事件。如果记不清前面写了什么，就不要写回忆。
- 角色之间的基本关系（师徒、住所、相识与否等）必须以角色设定为准，不要自行猜测或编造。角色不知道的信息，不要写"他不知道"——而是直接避免涉及该信息。
- 写到接近目标字数（本章目标约 ${targetWordsN} 字，目前正文已有 ${countWords(full)} 字）后，给本章一个自然的收尾。

${anchor}
本章当前正文末尾：
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
function trimMemoryToBudget(text, budgetTokens) {  if (!text || estimateTokens(text) <= budgetTokens) return text;
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

// 过滤记忆文本中的【章节记忆】块：仅保留 chapter_index < beforeIndex 的章节行。
// 重新生成某章时，其后的章节摘要尚未发生，不得作为前情注入，否则后续剧情会提前泄漏进本章。
function trimMemoryToIndex(text, beforeIndex) {
  if (!text || !beforeIndex || beforeIndex <= 1) {
    // beforeIndex<=1 时无任何前情章节，直接去掉章节记忆块
    const m1 = text.indexOf('【章节记忆】');
    if (m1 !== -1) return text.slice(0, m1).replace(/\n*$/, '');
    return text;
  }
  const marker = '【章节记忆】';
  const idx = text.indexOf(marker);
  if (idx === -1) return text;
  const head = text.slice(0, idx + marker.length);
  const kept = [];
  for (const line of text.slice(idx + marker.length).split('\n')) {
    const m = line.match(/第(\d+)章/);
    if (m && Number(m[1]) >= beforeIndex) continue;
    kept.push(line);
  }
  return head + '\n' + kept.filter(Boolean).join('\n');
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

function longestCommonSubstring(a, b) {
  const aa = String(a || '');
  const bb = String(b || '');
  const n = aa.length, m = bb.length;
  let best = '', dp = new Array(n + 1).fill(0).map(() => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (aa[i - 1] === bb[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > best.length) {
          best = aa.slice(i - dp[i][j], i);
        }
      }
    }
  }
  return best;
}

// 标题是否为"第一章/第2章"式占位（未真正生成标题）
function isPlaceholderTitle(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  if (/^第[一二三四五六七八九十百千\d零]+章$/.test(s)) return true;
  if (/^第[一二三四五六七八九十百千\d零]+回$/.test(s)) return true;
  if (/^(prologue|chapter)\s*\d+$/i.test(s)) return true;
  return false;
}

// 正文与知识库/风格库样本原文的重复检测：防止模型把参考作品原文照抄进本书正文
// 返回：抽样 5 段样本，统计与正文的公共子串长度，任一 ≥ copyThreshold 判定照抄
function detectSampleCopy(full, samplesText, copyThreshold = 25) {
  const text = String(full || '');
  const samples = String(samplesText || '');
  if (!text || !samples || text.length < 40) return { copied: false, quote: '' };
  const cleanText = (t) => t.replace(/\s+/g, '');
  const ct = cleanText(text);
  const cs = cleanText(samples);
  // 分块取样，避免整段比对超时
  const chunks = [];
  const step = Math.max(200, Math.floor(cs.length / 5));
  for (let i = 0; i < cs.length; i += step) {
    chunks.push(cs.slice(i, i + step));
    if (chunks.length >= 5) break;
  }
  let bestLen = 0;
  let bestQuote = '';
  for (const chunk of chunks) {
    if (chunk.length < copyThreshold) continue;
    const common = longestCommonSubstring(ct, chunk);
    if (common.length > bestLen) {
      bestLen = common.length;
      bestQuote = common;
    }
  }
  if (bestLen >= copyThreshold) return { copied: true, quote: bestQuote.slice(0, 60), len: bestLen };
  return { copied: false, quote: '' };
}

// 英文指令/系统提示泄漏检测：模型把"内部话术"当成正文输出
const LEAK_PATTERNS = [
  /\bThe user wants me to[\s\S]{0,24}/i,
  /\bAs an AI[\s\S]{0,40}/i,
  /\bI (?:am|will|should|need to|cannot|can't|must|am going to|would like to)[\u4e00-\u9fff\s]{0,24}/i,
  /\b(?:system|user|assistant)\s*[:：]/i,
  /(?:以下是|以下为|下面是|下面为)[\s\S]{0,10}(?:正文|内容|本章|章节|小说|故事|片段)/,
  /(?:让我来|我来为你|我为您|为您|为你)[\s\S]{0,10}(?:生成|创作|写一|写作|完成|输出|提供|展开|续写)/,
  /(?:好的|没问题)[，,：:\s]{0,5}(?:下面|接下来|现在|那么|我|让)[\s\S]{0,24}(?:生成|创作|写|完成|输出|提供|正文)/,
  /^(?:我将|我要|我来)(?:继续|开始|接着)(?:为你|为您)?(?:生成|创作|写|完成)/,
  /(?:本章|本段|以下|上面|上述)(?:正文|内容|文字)(?:如下|为：|为:|如下所示)/
];
function detectEnglishLeak(full) {
  const text = String(full || '').trim();
  if (!text) return { leaked: false, quote: '' };
  for (const re of LEAK_PATTERNS) {
    const m = text.match(re);
    if (m) return { leaked: true, quote: m[0].slice(0, 60) };
  }
  return { leaked: false, quote: '' };
}

// 思考残留/任务复述检测：推理型模型（deepseek-v4-flash 等）会把内部"规划/复述任务要求"
// 当成正文开头输出（如"我们需要回答用户：重写《X》第一章正文，约2000字，直接正文…"），
// 这是上一版"重新生成输出思考过程"问题的根因。逐句识别开头是否在复述任务而非写故事。
const THINK_RESIDUE_SENTENCE = [
  /(?:我们|我|本模型|AI)(?:需要|要|必须|将|会|正在)?(?:回答|服务|满足|为)?用户[：:]?/,
  /(?:我们需要回答|我要回答|请回答)/,
  /重写《[^》]{1,20}》第[一二三四五六七八九十百千\d零]+章正文/,
  /(?:本章|本段)?(?:正文)?约\s*\d{2,6}\s*字[，,]?(?:中文|左右|的正文)?/,
  /不输出(?:标题|markdown|标题\/markdown)[，,]?直接(?:正文|输出正文)/,
  /需要修正(?:上一版|上版|前版)(?:问题|反馈|内容)/,
  /请(?:直接)?(?:开始)?创作本章正文/,
  /(?:以下|上面|上文)(?:为|是)?(?:本章|重新|修改后|生成)?(?:正文|内容)[：:]/,
  /(?:好的|好|收到|明白|没问题|了解)[，,。\s]{0,4}(?:我|我们)?(?:来|会|将)?(?:重新)?(?:生成|重写|创作|继续|修改)/,
  /^(?:根据|按照|遵循)(?:以上|上述|你的)?(?:要求|指示|指令|反馈)[，,]?(?:我)?(?:来|将|会)?(?:重新|整体)?(?:生成|重写|创作|修改)/
];
function isThinkingResidueSentence(sent) {
  const s = String(sent || '').trim();
  if (!s) return false;
  if (s.length < 4 || s.length > 80) return false;
  return THINK_RESIDUE_SENTENCE.some((re) => re.test(s));
}
// 检测正文开头是否混入思考/任务复述残留（只看开头 600 字，避免误伤正文中段）
function detectThinkingResidue(full) {
  const text = String(full || '').trim();
  if (!text) return { leaked: false, quote: '' };
  const head = text.slice(0, 600);
  const parts = head.split(/(?<=[。！？!?；\n])/).filter((p) => p.trim());
  let leaked = false;
  let quote = '';
  let metaRun = 0;
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (isThinkingResidueSentence(t)) {
      metaRun++;
      if (!leaked) { leaked = true; quote = t.slice(0, 80); }
      if (metaRun >= 2) break;
    } else {
      break;
    }
  }
  return { leaked, quote };
}
// 剥离正文开头的思考/任务复述残留：从开头逐句删除"复述任务"的句子，直到碰到正常叙事句。
// 兜底：剥离后剩余过短（整段都是思考）则原样返回，交由质检判重生成。
function stripThinkingResidue(text) {
  const s = String(text || '').trim();
  if (!s) return s;
  const head = s.slice(0, 600);
  const parts = head.split(/(?<=[。！？!?；\n])/).filter((p) => p.trim());
  let metaCount = 0;
  for (const p of parts) {
    if (isThinkingResidueSentence(p.trim())) metaCount++;
    else break;
  }
  if (metaCount === 0) return s;
  // 重建：保留 head 中被剥离的句段之后的内容
  let cutLen = 0;
  let count = 0;
  for (const p of parts) {
    if (count >= metaCount) break;
    cutLen += p.length;
    count++;
  }
  const rest = (s.slice(cutLen) || '').trim();
  if (!rest) return s; // 剥离后什么都没有 → 整段都是思考，交给质检判重生成
  return rest;
}

// ===== 剧情衔接硬校验（模型无关）=====
// 目标：无论用哪个模型，都能在落库前识别"本章与上一章结尾脱节"的形态。
// 现有 0a 检测只抓"时间过了很久/另一边"等表面话术；这里补两类正则硬检测：
//  A) 时空跳转：本章开头出现的时间/地点与上一章结尾明显冲突
//  B) 角色状态断裂：上一章结尾主角处于某激烈状态（重伤/昏迷/对峙/逃亡），本章开头若无其事
// 返回 problems 描述数组（每项含可读反馈），质检循环据此判整章重生成。

// 上一章结尾通常以"结束状态"收束：离开某地/受伤/昏迷/对峙/发现某物等。若本章开头直接
// 跳到"第二天/几天后/另一个地方/完全平静的日常"，而上一章结尾是悬念/冲突/重伤，则为脱节。
const SEAM_JUMP_OPENERS = [
  /^(?:时间(?:过了|过去|流逝|一晃|来到)|过了(?:很久|许久|几天|数年|一段|些日子)|(?:第二天|次日|翌日|隔天|几天后|数日后|第二天早晨|第二天一早|第二天早上)(?:，|,|\s)?(?:清晨|早晨|早上)?)/,
  /^(?:另一边|与此同时|与此同时\s*[，,]\s*(?:镜头|画面)|镜头一转|画面一转|镜头切到|画面切到|让我们把视线|视角转到|另一方面|而与此同时|再看)/,
  /^(?:多年后|数年后|一年后|几月后|很久以后|多年以后|不久之后|良久|许久)/,
  /^(?:他|她|我|他们|她们)(?:在)?(?:一个新的|陌生的|别的|另一处)(?:地方|地点|房间|屋子)/
];

// 场景/地点断裂：上一章结尾明确在 A 地，本章开头直接无交代地出现在 B 地（且 A、B 差异明显）
function seamLocationGap(prevTail, head) {
  // 提取上一章结尾出现的地点名词（常见地点）
  const locRe = /(?:在|来到|走进|回到|赶到|离开|走出|冲进|躲进|进了|到了|就在)([一-龥]{2,4}(?:店|院|楼|房|屋|室|厅|场|站|街|巷|口|边|里|外|上|下|旁|角|门|窗|车|山|林|河|桥|路|库|馆|厅|室|房))(?![一-龥])/g;
  const prevLocs = new Set();
  let m;
  while ((m = locRe.exec(prevTail))) prevLocs.add(m[1]);
  if (prevLocs.size === 0) return null;
  // 本章开头 300 字内出现的地点
  const headLocs = new Set();
  let m2;
  const headRe = /(?:在|来到|走进|回到|赶到|离开|走出|冲进|躲进|进了|到了|就在)([一-龥]{2,4}(?:店|院|楼|房|屋|室|厅|场|站|街|巷|口|边|里|外|上|下|旁|角|门|窗|车|山|林|河|桥|路|库|馆|厅|室|房))(?![一-龥])/g;
  while ((m2 = headRe.exec(head))) headLocs.add(m2[1]);
  if (headLocs.size === 0) return null;
  // 若本章开头出现的地点，与上一章结尾的地点完全无交集，且上一章是明确的单一封闭场景 → 判脱节
  let overlap = false;
  for (const l of headLocs) {
    if ([...prevLocs].some((p) => p === l || p.includes(l) || l.includes(p))) { overlap = true; break; }
  }
  if (!overlap && prevLocs.size >= 1) {
    return `地点跳变：上一章结尾角色在「${[...prevLocs].join('/')}」，本章开头却无交代地出现在「${[...headLocs].join('/')}」，时间地点断裂，须从上一章结尾所在场景直接续写`;
  }
  return null;
}

// 状态断裂：上一章结尾主角处于激烈/特殊状态，本章开头却若无其事地平静开始
const SEAM_STATE_TAIL = [
  { re: /(?:昏迷|昏了过去|失去意识|倒在地上|晕了过去|重伤|奄奄一息|血流如注|命悬一线|气若游丝|昏死过去|人事不省)/, label: '上一章结尾主角重伤/昏迷' },
  { re: /(?:对峙|剑拔弩张|针锋相对|怒目而视|剑指|枪口|掐住|扼住|压在地上|扭打|搏斗|殊死)/, label: '上一章结尾正处激烈对峙' },
  { re: /(?:逃|跑|狂奔|疾驰|夺路|冲出|窜出|没命|踉跄|跌跌撞撞|慌不择路)/, label: '上一章结尾正在逃亡' },
  { re: /(?:哭|啜泣|抽泣|嚎啕|崩溃|失魂落魄|呆立|愣在原地|失神)/, label: '上一章结尾情绪崩溃' }
];
const SEAM_STATE_HEAD_CALM = /^(?:他|她|我|他们|她们)?(?:醒(?:了|来)?后?|一觉醒来|第二天(?:早晨|一早|早上|清晨)?|起床|起?床|睁开眼|睁开双眼|梳洗|洗漱|换好衣服|穿好衣服|坐在|端起|吃着|喝着|悠闲|若无其事|气定神闲|平静地|慢条斯理)/;

function checkSeamlessConnection(prevTail, head) {
  const problems = [];
  if (!prevTail || !head) return problems;
  const prev = String(prevTail).slice(-800); // 上一章结尾末尾 800 字
  const h = String(head).slice(0, 400);      // 本章开头 400 字
  if (!prev || !h) return problems;

  // A) 跳转话术开头
  for (const re of SEAM_JUMP_OPENERS) {
    if (re.test(h)) {
      problems.push({ desc: `本章开头以跳转话术「${h.slice(0, 16)}…」开启，未紧接上一章结尾的场面续写。须从上一章结尾的最后一个动作/对话/悬念直接往下写` });
      break;
    }
  }
  // B) 地点跳变
  const loc = seamLocationGap(prev, h);
  if (loc) problems.push({ desc: loc });
  // C) 状态断裂
  for (const st of SEAM_STATE_TAIL) {
    if (st.re.test(prev)) {
      // 上一章结尾是激烈状态，本章开头若无其事 → 断裂
      if (SEAM_STATE_HEAD_CALM.test(h)) {
        problems.push({ desc: `${st.label}，本章开头却平静无事地开始（「${h.slice(0, 16)}…」），情绪/状态断裂。须从上一章结尾的状态直接延续，先写角色如何处理该状态` });
      }
      break;
    }
  }
  // 去重
  const seen = new Set();
  return problems.filter((p) => { if (seen.has(p.desc)) return false; seen.add(p.desc); return true; });
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
    try { r.skill_ids = JSON.parse(r.skill_ids || '[]'); } catch { r.skill_ids = []; }
  }
  res.json(rows);
});

router.post('/novels', async (req, res) => {
  const { title = '', genre = '', concept = '', chapterWordCount = 2000, targetChapters = 20, stylePresets = [], styleIds = [], knowledgeCorpusIds = [], skillIds = [] } = req.body || {};
  const stylePresetsStr = Array.isArray(stylePresets)
    ? stylePresets.map((s) => String(s).trim()).filter(Boolean).join(',')
    : '';
  const styleIdsStr = Array.isArray(styleIds)
    ? JSON.stringify(styleIds.map(Number).filter(Boolean))
    : '[]';
  const knowledgeIdsStr = Array.isArray(knowledgeCorpusIds)
    ? knowledgeCorpusIds.map((id) => Number(id)).filter(Boolean).join(',')
    : '';
  const skillIdsStr = Array.isArray(skillIds)
    ? JSON.stringify(skillIds.map(Number).filter(Boolean))
    : '[]';
  const info = db.prepare(
    'INSERT INTO novels (title, genre, concept, chapter_word_count, target_chapters, style_presets, style_ids, knowledge_corpus_ids, skill_ids) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(title, genre, concept, chapterWordCount, targetChapters, stylePresetsStr, styleIdsStr, knowledgeIdsStr, skillIdsStr);
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

// TXT 解析预览：仅解析不落库，返回章节清单（供前端拆分预览/校对）
router.post('/novels/import-txt/preview', (req, res) => {
  const rawContent = String((req.body || {}).content || '');
  if (!rawContent.trim()) return res.status(400).json({ error: '导入内容为空' });
  const { chapters, splitted } = parseTxtChapters(rawContent);
  if (!chapters.length) return res.status(400).json({ error: '未能从 TXT 中解析出任何章节内容' });
  const preview = chapters.map((c, i) => ({
    index: i + 1,
    title: c.title,
    word_count: countWords(c.content),
    content_head: String(c.content).slice(0, 60)
  }));
  return res.json({ total: preview.length, splitted, chapters: preview, total_words: countWords(rawContent) });
});

// 灵感生成器：无灵感时按「题材 + 风格」批量产出多个小说创意大纲供浏览挑选
router.post('/ideas', async (req, res) => {
  const { genres = [], stylePresets = [], styleIds = [], count = 3 } = req.body || {};
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const genreList = (Array.isArray(genres) ? genres : []).map((g) => String(g).trim()).filter(Boolean);
  if (!genreList.length) return res.status(400).json({ error: '请至少选择一个小说题材' });
  const ideaCount = Math.min(3, Math.max(2, Number(count) || 3));

  const { ctrl, send, end } = startSSE(req, res);
  send({ type: 'status', message: `正在根据题材与风格构思 ${ideaCount} 个创意…` });

  const styles = getStyles(styleIds);
  let styleBlock = '';
  if (styles.length) {
    const parts = styles.map((s, i) => `风格${i + 1}《${s.name}》：\n${s.analysis || ''}`);
    styleBlock = `\n\n【写作风格参考】
已选 ${styles.length} 位作者的写作风格：
${parts.join('\n\n')}

要求：构思的故事方向、主角气质与叙述基调向这些风格靠拢。`;
  }

  const presets = (Array.isArray(stylePresets) ? stylePresets : [])
    .map((s) => String(s).trim()).filter(Boolean);
  const presetBlock = presets.length
    ? `\n\n【创作风格基调】${presets.join('、')}\n\n构思的创意应贴合这些风格基调（例如悬念、燃向、轻松日常等）。`
    : '';

  const userPrompt = `用户选择的题材：${genreList.join('、')}${styleBlock}${presetBlock}\n\n请一次构思 ${ideaCount} 个不同方向的小说创意，输出 JSON 数组。`;

  try {
    const maxOut = Math.max(8192, Number(config.maxTokens) || 8192);
    let full = '';
    if (config?.forceNonStreaming) {
      const r = await chat({ config, messages: [
        { role: 'system', content: IDEAS_SYSTEM },
        { role: 'user', content: userPrompt }
      ], maxTokens: maxOut, timeout: 300000 });
      full = r?.content || '';
    } else {
      await runLLMStream(config, [
        { role: 'system', content: IDEAS_SYSTEM },
        { role: 'user', content: userPrompt }
      ], {
        ctrl,
        task: 'planning',
        maxTokens: maxOut,
        onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
      });
    }
    send({ type: 'status', message: '创意构思完成，正在解析…' });

    let ideas = extractJson(full);
    if (Array.isArray(ideas)) {
      ideas = ideas.map((it, i) => ({
        id: `idea-${Date.now()}-${i}`,
        title: String(it.title || `创意${i + 1}`),
        genre: String(it.genre || ''),
        hook: String(it.hook || ''),
        logline: String(it.logline || ''),
        protagonist: it.protagonist || {},
        selling_point: Array.isArray(it.selling_point) ? it.selling_point : [String(it.selling_point || '')],
        outline_H5: Array.isArray(it.outline_H5) ? it.outline_H5 : [String(it.outline_H5 || '')],
        potential_risk: String(it.potential_risk || '')
      }));
      if (ideas.length) return end({ type: 'done', data: { ideas } });
    }
    send({ type: 'status', message: '创意解析失败，将重试一次…' });

    // 容错：重试一次解析（模型返回了文本但没有规整 JSON 时补个兜底）
    const retry = extractJson(full.replace(/[\n\r]+/g, '\n'));
    if (Array.isArray(retry) && retry.length && Array.isArray(retry[0]) && retry[0].length > 0 && retry[0][0] && typeof retry[0][0] === 'object' && retry[0][0].title) {
      const arr = retry[0];
      const ideas2 = arr.map((it, i) => ({
        id: `idea-${Date.now()}-${i}`,
        title: String(it.title || `创意${i + 1}`),
        genre: String(it.genre || ''),
        hook: String(it.hook || ''),
        logline: String(it.logline || ''),
        protagonist: it.protagonist || {},
        selling_point: Array.isArray(it.selling_point) ? it.selling_point : [String(it.selling_point || '')],
        outline_H5: Array.isArray(it.outline_H5) ? it.outline_H5 : [String(it.outline_H5 || '')],
        potential_risk: String(it.potential_risk || '')
      }));
      return end({ type: 'done', data: { ideas: ideas2 } });
    }

    return end({ type: 'error', message: '创意生成失败：模型返回内容无法解析，请重试。' });
  } catch (e) {
    if (e.name === 'AbortError' && ctrl.signal.aborted) {
      return end({ type: 'aborted', message: '已取消' });
    }
    console.error('ideas generate error:', e);
    return end({ type: 'error', message: e.message || '创意生成失败' });
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
  if (req.body.skill_ids !== undefined) {
    sets.push('skill_ids = ?');
    vals.push(JSON.stringify(Array.isArray(req.body.skill_ids) ? req.body.skill_ids : []));
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

  db.prepare('UPDATE novels SET title = ?, genre = ?, world_view = ?, outline = ?, concept = ?, chapter_word_count = ?, target_chapters = ?, status = ?, story_arcs = ?, protagonist_name = ?, heroine_name = ? WHERE id = ?')
    .run(title, genreV, worldView, outline, concept, words, target, 'planned', storyArcs, String(plan.protagonist_name || novel.protagonist_name || ''), String(plan.heroine_name || novel.heroine_name || ''), novel.id);

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
    const beatsJson = ch?.beats ? (Array.isArray(ch.beats) ? JSON.stringify(ch.beats) : String(ch.beats)) : '';
    db.prepare('INSERT INTO chapters (novel_id, chapter_index, title, summary, emotion, arc_hint, hook, beats, content, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(novel.id, i + 1, String(ch?.title || `第${i + 1}章`), String(ch?.summary || ''), String(ch?.emotion || ''), String(ch?.arc_hint || ''), String(ch?.hook || ''), beatsJson, '', 'planned');
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

// 根据章节序号与全书目标章节数计算章节阶段，指导节奏
function chapterStageLabel(idx, total) {
  const t = Number(total);
  if (!t || t <= 0) return '一段完整剧情中';
  const ratio = idx / t;
  if (ratio <= 0.08) return '开篇引入阶段（建立世界观、抛出核心矛盾与主角处境，节奏应直接、抛出钩子）';
  if (ratio <= 0.35) return '铺展上升阶段（推进主线、铺垫冲突、塑造角色关系，节奏应稳步推进）';
  if (ratio <= 0.55) return '中期发酵阶段（冲突加剧、伏笔陆续浮出、暗线交汇，节奏应渐紧）';
  if (ratio <= 0.75) return '高潮前积累阶段（矛盾全面升级、大转折将至，节奏应逐步收紧）';
  if (ratio <= 0.92) return '高潮收束阶段（核心冲突正面爆发并解决，节奏应高密度、有力度）';
  return '终局收尾阶段（解决遗留、情绪落地、结局气势，节奏应完整收束）';
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
  for (const c of chapters) {
    const extra = [c.emotion && `情绪：${c.emotion}`, c.arc_hint && `推进：${c.arc_hint}`, c.hook && `钩子：${c.hook}`].filter(Boolean).join('｜');
    lines.push(`- 第${c.chapter_index}章 ${c.title}：${c.summary || ''}${extra ? `（${extra}）` : ''}`);
  }
  return lines.join('\n');
}

// 生成创作方案（初稿）
router.post('/novels/:id/plan', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { concept, genre, chapterWordCount, targetChapters, stylePresets, lengthClass, protagonistName, heroineName, referenceNotes } = req.body || {};
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
 ${protagonistName || novel.protagonist_name ? `\n男主角名字：${protagonistName || novel.protagonist_name}（方案中男主必须用这个名字）` : ''}
 ${heroineName || novel.heroine_name ? `\n女主角名字：${heroineName || novel.heroine_name}（方案中女主必须用这个名字）` : ''}
 ${referenceNotes ? `\n同类小说参考（借鉴其题材套路与节奏，但不要抄袭情节）：\n${referenceNotes}` : ''}
  
【题材边界强调】所选类型为：${genre || novel.genre || '未指定'}。若其中不含玄幻/仙侠/修真/修仙/灵异/异能/科幻/西幻等超凡标签，则本书为现实向，力量体系只能是武功谋略，严禁把"学习/修炼"写成玄幻修仙境界（灵气、金丹、元婴、御剑等等一概禁止）；意外死亡穿越也不是获得超凡能力的理由。
 
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
  // 骨架输出含角色/势力/关系列表，输出规模大：下限提到 12288，防止截断导致反复重试后降级（书名/大纲雷同的根因之一）
  const skeletonMaxOut = Math.min(Math.max(maxOut, 12288), 16384);
  const chapterMaxOut = Math.min(maxOut, 4096);

  // 流式生成并把内容透传给前端（进度可见），返回完整文本
  // 单批次 idle 超时：3 分钟无数据则判定超时
  const streamCollect = async (messages, label, mt = maxOut) => {
    let full = '';
    send({ type: 'status', message: label });
    if (config?.forceNonStreaming) {
      const r = await chat({ config, messages, maxTokens: mt, timeout: 300000 });
      full = r?.content || '';
    } else {
      await runLLMStream(config, messages, {
        ctrl,
        task: 'planning',
        maxTokens: mt,
        onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
      });
    }
    return full;
  };

  // 指数退避
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 流式生成 + 解析 JSON，最多重试 maxAttempts 次（流式 + 非流式交替 + 指数退避）
  // 重试时追加格式强化提示，降低格式出错率。重试时递增 max_tokens 防止截断（上限 cap）
  const FORMAT_REMINDER = '\n\n【重要提醒】你之前的输出无法被解析为 JSON。请严格只输出一个 JSON 对象或数组，不要输出任何说明文字、markdown 代码块标记（```）、注释或多余字符。确保所有字符串值中的双引号用 \\" 转义，换行用 \\n 转义。不要输出 think/thinking 内容。';
const jsonFrom = async (messages, label, mt = maxOut, opts = {}) => {
    const maxAttempts = Number(opts.maxAttempts) > 0 ? opts.maxAttempts : 5;
    const cap = Number(opts.cap) > 0 ? opts.cap : maxOut;
    let lastText = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const waitSec = Math.pow(2, attempt - 1);
        send({ type: 'status', message: `AI 返回格式异常，第 ${attempt} 次重试（等待 ${waitSec}s 后重试）…` });
        await sleep(waitSec * 1000);
        // 递增 max_tokens 防止截断
        mt = Math.min(cap, Math.round(mt * 1.5));
      }
      // 重试时追加格式强化提示
      const useMessages = attempt > 1
        ? messages.map((m) => m.role === 'user' ? { ...m, content: m.content + FORMAT_REMINDER } : m)
        : messages;
      try {
        lastText = await streamCollect(useMessages, attempt === 1 ? label : `${label}（重试 ${attempt}，已强化格式要求）`, mt);
      } catch (e) {
        if (e.name === 'AbortError') {
          // 超时 AbortError 可能来自流式空闲超时（非用户主动中止），尝试非流式降级
          if (!ctrl.signal.aborted) {
            send({ type: 'status', message: `流式响应超时，正在用非流式重试（第 ${attempt} 次）…` });
            try {
              const retry = await chat({ config, messages: useMessages, maxTokens: mt, timeout: 300000 });
              lastText = retry?.content || '';
            } catch (e2) {
              if (e2.name === 'AbortError' && !ctrl.signal.aborted) {
                send({ type: 'status', message: `第 ${attempt} 次重试也超时，继续重试…` });
                lastText = '';
              } else {
                throw e2;
              }
            }
          } else {
            throw e; // 用户主动中止，直接终止
          }
        } else if (/HTTP\s+4\d\d/.test(e.message) && !/429/.test(e.message)) {
          // 4xx 确定性错误（余额不足/Key 无效/接口不存在等），重试不会成功，立即终止
          // 429 除外（限流/配额超限），应继续重试
          throw e;
        } else {
          send({ type: 'status', message: `流式请求失败，正在用非流式重试（第 ${attempt} 次）…` });
          try {
            const retry = await chat({ config, messages: useMessages, maxTokens: mt, timeout: 300000 });
            lastText = retry?.content || '';
          } catch (e2) {
            if (e2.name === 'AbortError' && !ctrl.signal.aborted) {
              send({ type: 'status', message: `第 ${attempt} 次重试也超时，继续重试…` });
              lastText = '';
            } else {
              throw e2;
            }
          }
        }
      }
      const obj = extractJson(lastText);
      if (obj) return obj;
      if (attempt < maxAttempts) {
        const preview = lastText.slice(0, 120).replace(/\n/g, ' ');
        send({ type: 'status', message: `解析失败（返回内容开头：${preview}…），将重试…` });
      }
    }
    if (lastText.trim()) {
      // 重试用尽仍失败但至少返回了文本，尝试解析最后一段
      const obj = extractJson(lastText.slice(-2000));
      if (obj) return obj;
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
    // 整体超时保护：防止极端情况下（慢模型/反复重试）无限拉长。到点后章节用占位补齐、细纲跳过剩余，保证方案完整收尾
    const PLAN_DEADLINE_MS = 120 * 60 * 1000; // 120 分钟
    const planDeadline = Date.now() + PLAN_DEADLINE_MS;
    const isPlanOverdue = () => Date.now() > planDeadline;
    const estimatedBatches = Math.ceil(target / 30);
    send({ type: 'status', message: `开始生成方案（目标 ${target} 章，预计 ${estimatedBatches} 批，逐批完成）…` });
    send({ type: 'progress', progress: 8, message: '正在构思世界观、角色与剧情大纲…' });

    // 注入知识学习库分析（手动关联 + 按题材自动匹配）
    const manualIds = getNovelKnowledgeIds(novel);
    const autoIds = getKnowledgeByGenres([novel.genre || ''], 2)
      .map((k) => k.id)
      .filter((id) => !manualIds.includes(id));
    const knowledgeIds = [...manualIds, ...autoIds];
    const knowledgeBlock = formatKnowledgeBlock(knowledgeIds);
    let planSamples = '';
    if (knowledgeIds.length) {
      planSamples = knowledgeIds.map((id) => {
        const s = getSampleSnippets(id, 2000);
        return s ? `【片段】${s.slice(0, 500)}` : null;
      }).filter(Boolean).join('\n');
    }
    const planKnowledgeBlock = knowledgeBlock + (planSamples ? `\n\n【已导入小说剧情参考（仅借鉴其节奏与冲突设置，禁止照抄剧情、禁止使用其中任何人物名/地名/情节）】\n${planSamples}` : '');
    if (planKnowledgeBlock) {
      send({ type: 'status', message: '已加载知识学习库参考，正在生成方案…' });
    }

    // 注入技能库（题材联动：tags 匹配题材的技能自动带入选）
    const planSkillIds = [...getNovelSkillIds(novel), ...recommendSkillsForGenre(novel.genre)];
    const planSkillsBlock = formatSkillsBlock(planSkillIds);

    // 注入风格库分析：方案骨架里的角色设定、情节节奏、叙述基调应贴合所选文风
    const planStyles = getStyles(parseStyleIds(novel));
    let planStyleBlock = '';
    if (planStyles.length) {
      const parts = planStyles.map((s, i) => `风格${i + 1}《${s.name}》：\n${s.analysis || ''}`);
      planStyleBlock = `\n\n【写作风格参考】
本作启用了以下 ${planStyles.length} 位作者的写作风格：
${parts.join('\n\n')}

要求：世界观设定、角色气质、情节推进节奏与叙述基调整体向这些风格靠拢，把这些风格自然融合成统一、不生硬的方案风格。`;
      send({ type: 'status', message: `已加载 ${planStyles.length} 项写作风格参考，正在生成方案…` });
    }

    // 注入题材指南（合并注入全部匹配的相关指南，如历史+武侠+重生各自的精神都要保留）
    const planGenreBlock = novel.genre ? (() => {
      const guides = getGenreGuides(novel.genre);
      return guides.length ? `\n\n${guides.join('\n\n')}` : '';
    })() : '';

    // 阶段 1：作品骨架
    // 预算裁剪：防止系统提示词超限导致模型输出乱码/垃圾
    const sysContent = PLAN_SKELETON_SYSTEM + planKnowledgeBlock + planSkillsBlock + planGenreBlock + planStyleBlock;
    const sysTokens = estimateTokens(sysContent);
    const budget = contextBudget(config);
    const trimmedSys = sysTokens > budget - estimateTokens(userPrompt) - 1024
      ? sysContent.slice(0, Math.max(2000, Math.floor((budget - estimateTokens(userPrompt) - 1024) * 1.5)))
      : sysContent;
    let skeleton = await jsonFrom(
      [
        { role: 'system', content: trimmedSys },
        { role: 'user', content: userPrompt }
      ],
      '正在构思世界观、角色与剧情大纲…',
      skeletonMaxOut,
      { cap: skeletonMaxOut }
    );
    if (!skeleton) {
      // 骨架降级：基于用户输入生成基础骨架（临时书名，供占位，后续可用「修改方案」完善）
      send({ type: 'status', message: '骨架多次解析失败，已生成基础骨架（临时书名）…' });
      const fallbackTitle = (concept || '').trim().slice(0, 12) || '未命名小说';
      skeleton = {
        title: fallbackTitle,
        genre: genre || novel.genre || '通用',
        world_view: '（待补充）',
        outline: concept || '（待补充）',
        characters: [],
        relationships: [],
        chapters: []
      };
      send({ type: 'status', message: '已生成基础骨架，继续规划章节…（提示：当前书名为临时占位，可生成后用「修改方案」让 AI 重拟书名与设定）' });
    }
    send({ type: 'progress', progress: 30, message: '骨架已生成，正在规划章节…' });
    updateJob(job.id, { progress: 30, stream_cursor: '骨架已生成，正在规划章节…' });

    // 阶段 2：章节规划（分批，超长篇 200+ 章用 30 章/批，其余用 20 章/批）
    const BATCH_SIZE = target >= 200 ? 30 : 20;
    const skeletonChapters = Array.isArray(skeleton.chapters)
      ? skeleton.chapters.filter((c) => c && c.title).map((c) => ({ title: String(c.title), summary: String(c.summary || ''), emotion: String(c.emotion || ''), arc_hint: String(c.arc_hint || ''), hook: String(c.hook || '') }))
      : [];
    const allChapters = skeletonChapters.slice(0, target);
    const brief = buildSkeletonBrief(skeleton);

    if (allChapters.length < target) {
      let start = allChapters.length + 1;
      let consecutiveFallbacks = 0;
      const MAX_CONSECUTIVE_FALLBACKS = 3;

      while (start <= target) {
        if (isPlanOverdue()) {
          const remaining = generateFallbackChapters(start, target, brief);
          allChapters.push(...remaining);
          send({ type: 'status', message: `方案生成已到整体时限，剩余章节（第 ${start}-${target} 章）已用占位补齐，生成完成后可手动完善。` });
          break;
        }
        const batchEnd = Math.min(target, start + BATCH_SIZE - 1);
        const batchSize = batchEnd - start + 1;

        // 批次连续性：把已规划的最近章节概要作为前情传给本批，防止批次间剧情脱节/重复
        const prevTail = allChapters.slice(-6);
        const prevBlock = prevTail.length
          ? prevTail.map((c, i) => `第${allChapters.length - prevTail.length + i + 1}章「${c.title}」：${c.summary}`).join('\n')
          : '';

        const batch = await jsonFrom(
          [
            { role: 'system', content: PLAN_CHAPTERS_SYSTEM },
            { role: 'user', content: `作品骨架：\n${brief}\n\n计划章节数：${target} 章。\n请规划第 ${start} 至第 ${batchEnd} 章的标题与剧情概要（共 ${batchSize} 章），必须完整覆盖此编号范围。\n\n【当前规划所处全书阶段】\n本批覆盖第 ${start}-${batchEnd} 章，全书 ${target} 章，对应阶段：${chapterStageLabel(start, target)}。规划时应让剧情节奏符合该阶段（开篇直接抛出钩子、中期渐紧、高潮高密度、终局收束）。\n\n【前情（此前已规划的章节，剧情必须自然承接，不得与之重复或冲突）】\n${prevBlock || '（无，这是开头章节）'}\n\n第 ${start} 章紧接前情结尾继续推进。` }
          ],
          `正在规划章节 ${start}-${batchEnd}（已完成 ${allChapters.length}/${target}）…`,
          chapterMaxOut
        );

        const list = Array.isArray(batch) ? batch : (Array.isArray(batch?.chapters) ? batch.chapters : []);
        const clean = list
          .filter((c) => c && (c.title || c.summary))
          .map((c) => ({
            title: String(c.title || `第${start}章`),
            summary: String(c.summary || ''),
            emotion: String(c.emotion || ''),
            arc_hint: String(c.arc_hint || ''),
            hook: String(c.hook || '')
          }));

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

    // 生成细纲（场景级 beat）：批量生成，每批 5 章。批与批之间无依赖，改为并发执行大幅提速
    send({ type: 'progress', progress: 93, message: '正在生成细纲…' });
    updateJob(job.id, { progress: 93, word_count: plan.chapters.length, stream_cursor: '正在生成细纲…' });
    try {
      const BEATS_BATCH = 5;
      const BEATS_CONCURRENCY = 5; // 并发批数（= 同时进行的 LLM 请求数）
      const batches = [];
      for (let batchStart = 0; batchStart < plan.chapters.length; batchStart += BEATS_BATCH) {
        const batchEnd = Math.min(batchStart + BEATS_BATCH, plan.chapters.length);
        const batch = plan.chapters.slice(batchStart, batchEnd);
        const beatsReq = {};
        batch.forEach((ch, i) => {
          const idx = batchStart + i + 1;
          beatsReq[idx] = { title: ch.title, summary: ch.summary, emotion: ch.emotion, arc_hint: ch.arc_hint, hook: ch.hook };
        });
        batches.push({ batchStart, batchEnd, userContent: `作品骨架：\n${brief}\n\n请为第 ${batchStart + 1} 至第 ${batchEnd} 章生成细纲（场景级 beat），每章 3-6 个场景。\n\n各章信息：\n${JSON.stringify(beatsReq, null, 2)}` });
      }
      const runBatch = async (b) => {
        // 每批最多重试 2 次，失败不阻塞，正文创作时按大纲兜底
        const beatsRes = await jsonFrom(
          [
            { role: 'system', content: PLAN_BEATS_SYSTEM },
            { role: 'user', content: b.userContent }
          ],
          `正在生成细纲（第 ${b.batchStart + 1}-${b.batchEnd} 章）…`,
          skeletonMaxOut,
          { maxAttempts: 2, cap: skeletonMaxOut }
        );
        if (beatsRes && typeof beatsRes === 'object') {
          for (let i = b.batchStart; i < b.batchEnd; i++) {
            const idx = i + 1;
            const chBeats = beatsRes[String(idx)];
            if (Array.isArray(chBeats) && chBeats.length) {
              plan.chapters[i].beats = chBeats;
            }
          }
        }
      };
      for (let i = 0; i < batches.length; i += BEATS_CONCURRENCY) {
        if (isPlanOverdue()) {
          send({ type: 'status', message: '方案生成已到整体时限，剩余细纲已跳过（正文创作时会按大纲现场生成场景）。' });
          break;
        }
        const slice = batches.slice(i, i + BEATS_CONCURRENCY);
        const settled = await Promise.allSettled(slice.map(runBatch));
        // 用户主动中止：立即终止
        const aborted = settled.find((r) => r.status === 'rejected' && r.reason?.name === 'AbortError' && ctrl.signal.aborted);
        if (aborted) throw aborted.reason;
        const doneChapters = Math.min((i + slice.length) * BEATS_BATCH, plan.chapters.length);
        const pct = 93 + Math.round((doneChapters / plan.chapters.length) * 3);
        send({ type: 'progress', progress: pct, message: `细纲进度：${doneChapters}/${plan.chapters.length} 章` });
      }
    } catch (e) {
      // 用户中止向上抛，其余细纲生成失败不阻塞，后续章节生成时运行时生成
      if (e?.name === 'AbortError' && ctrl.signal.aborted) throw e;
    }

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

【题材边界提醒】本书类型为「${novel.genre || '未注明'}」。若其中不含玄幻/仙侠/修真/修仙/灵异/异能/科幻/西幻等标签，则本书为现实向：世界观与角色的"修炼/能力"只能是武术、谋略、医术等现实可及的能力，严禁引入修炼境界、灵气、金丹、御剑、系统面板等玄幻修行元素。请仅依据用户意见修订，不要顺手把现实向设定改成玄幻修行。

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
  send({ type: 'progress', progress: 1, message: '正在根据你的改编意图生成改编方案(1%)…' });
  send({ type: 'status', message: '正在根据你的改编意图生成改编方案…' });
  db.prepare('UPDATE adaptation_jobs SET updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(jobId);

  const chs = db.prepare("SELECT chapter_index, title FROM chapters WHERE novel_id = ? AND content != '' ORDER BY chapter_index").all(novel.id);
  const chapterList = chs.map((c) => `第${c.chapter_index}章 ${c.title}`).join('\n');

  const userPrompt = `以下是待改编的小说章节清单：\n\n${chapterList || '（无章节）'}\n\n用户的改编意图：\n${intent}\n\n请输出完整的改编方案 JSON。`;

  try {
    let full = '';
    send({ type: 'progress', progress: 1, message: '正在生成改编方案(1%)…' });
    send({ type: 'status', message: '正在分析原著章节并构思改编方案，请稍候…' });
    let deltaCount = 0;
    await runLLMStream(config, [
      { role: 'system', content: ADAPTATION_PLAN_SYSTEM },
      { role: 'user', content: userPrompt }
    ], {
      ctrl,
      task: 'planning',
      maxTokens: Math.max(4096, Number(config.maxTokens) || 8192),
      onDelta: (d) => {
        full += d;
        deltaCount++;
        send({ type: 'delta', content: d });
        if (deltaCount % 2 === 0) {
          const pct = Math.min(89, 1 + Math.floor(deltaCount / 2));
          send({ type: 'progress', progress: pct, message: `正在生成改编方案(${pct}%)…` });
        }
      }
    });

    send({ type: 'progress', progress: 92, message: '正在解析AI返回的改编方案…' });
    send({ type: 'status', message: '正在解析AI返回的改编方案…' });
    const plan = extractJson(full);
    if (!plan) {
      db.prepare("UPDATE adaptation_jobs SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?").run('AI 返回内容无法解析为改编方案', jobId);
      return end({ type: 'error', message: 'AI 返回的内容无法解析为改编方案，请重试。原始输出已附在 raw 字段。', raw: full });
    }
    // 多方案兼容：新版输出 {plans:[...]}，旧版输出单个方案对象
    let plans = Array.isArray(plan.plans) && plan.plans.length ? plan.plans : [];
    if (!plans.length && (plan.chapters || plan.global_notes || plan.intent_summary)) {
      // 旧版单方案 → 包装成单元素数组
      plans = [{ plan_id: 'default', plan_name: '改编方案', intent_summary: plan.intent_summary || '', approach: '', global_notes: plan.global_notes || '', chapters: plan.chapters || [] }];
    }
const planPayload = { original_info: plan.original_info || { title: novel.title, total_chapters: getChapters(novel.id).length }, plans };
    send({ type: 'progress', progress: 95, message: '正在保存改编方案(95%)…' });
    send({ type: 'status', message: '正在保存改编方案…' });
    db.prepare("UPDATE adaptation_jobs SET plan = ?, plans = ?, status = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(JSON.stringify(planPayload), JSON.stringify(plans || []), plans.length ? 'plan_ready' : 'failed', jobId);
    if (!plans.length) {
      return end({ type: 'error', message: '改编方案解析后为空，请重试。', raw: full });
    }
    send({ type: 'progress', progress: 100, message: `已生成 ${plans.length} 个改编方案` });
    return end({ type: 'done', data: { jobId, plan: planPayload, plans } });
  } catch (e) {
    if (e.name === 'AbortError') {
      db.prepare("UPDATE adaptation_jobs SET status = 'aborted', error = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(e.message.slice(0, 500), jobId);
      return end({ type: 'aborted', message: '已停止生成' });
    }
    const curJob = db.prepare("SELECT status FROM adaptation_jobs WHERE id = ?").get(jobId);
    if (curJob && curJob.status === 'done') {
      return;
    }
    db.prepare("UPDATE adaptation_jobs SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(e.message.slice(0, 500), jobId);
    return end({ type: 'error', message: e.message });
  }
});

// 歌词改编：基于歌词/歌曲信息生成小说改编方案
router.post('/novels/:id/adaptation/from-song', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { songTitle, artist, lyrics, style } = (req.body || {});
  if (!lyrics) return res.status(400).json({ error: '请提供歌词内容' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const activeJob = db.prepare(
    "SELECT id FROM adaptation_jobs WHERE novel_id = ? AND status IN ('drafting_plan','adapting') ORDER BY id DESC LIMIT 1"
  ).get(novel.id);
  if (activeJob) {
    return res.status(409).json({ error: '该小说已有进行中的改编任务', jobId: activeJob.id });
  }

  const info = db.prepare(
    "INSERT INTO adaptation_jobs (novel_id, intent, status, total_chapters) VALUES (?,?,?,?)"
  ).run(novel.id, `歌词改编：${songTitle || '未知歌曲'} - ${artist || '未知歌手'}`, 'drafting_plan', 0);
  const jobId = Number(info.lastInsertRowid);

  const { ctrl, send, end } = startSSE(req, res);
  send({ type: 'job', jobId, stage: 'adaptation_plan' });
  send({ type: 'progress', progress: 1, message: '正在分析歌词(1%)…' });
  send({ type: 'status', message: '正在分析歌词内容与情感…' });

  const userPrompt = `【歌曲信息】
歌名：${songTitle || '（未知）'}
歌手：${artist || '（未知）'}
风格偏好：${style || '（无，由 AI 自行决定）'}

【歌词全文】
${lyrics}

请根据以上歌词，输出一份完整的小说改编方案 JSON。`;

  try {
    let full = '';
    send({ type: 'progress', progress: 1, message: '正在生成改编方案(1%)…' });
    send({ type: 'status', message: '正在根据歌词构思小说改编方案，请稍候…' });
    let deltaCount = 0;
    await runLLMStream(config, [
      { role: 'system', content: LYRICS_TO_NOVEL_SYSTEM },
      { role: 'user', content: userPrompt }
    ], {
      ctrl,
      task: 'planning',
      maxTokens: Math.max(4096, Number(config.maxTokens) || 8192),
      onDelta: (d) => {
        full += d;
        deltaCount++;
        send({ type: 'delta', content: d });
        if (deltaCount % 2 === 0) {
          const pct = Math.min(89, 1 + Math.floor(deltaCount / 2));
          send({ type: 'progress', progress: pct, message: `正在生成改编方案(${pct}%)…` });
        }
      }
    });

    send({ type: 'progress', progress: 92, message: '正在解析AI返回的改编方案…' });
    send({ type: 'status', message: '正在解析AI返回的改编方案…' });
    const plan = extractJson(full);
    if (!plan) {
      db.prepare("UPDATE adaptation_jobs SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?").run('AI 返回内容无法解析为改编方案', jobId);
      return end({ type: 'error', message: 'AI 返回的内容无法解析为改编方案，请重试。', raw: full });
    }
    let plans = Array.isArray(plan.plans) && plan.plans.length ? plan.plans : [];
    if (!plans.length && (plan.chapters || plan.global_notes || plan.intent_summary)) {
      plans = [{ plan_id: 'default', plan_name: '改编方案', intent_summary: plan.intent_summary || '', approach: '', global_notes: plan.global_notes || '', chapters: plan.chapters || [] }];
    }
    const planPayload = { original_info: plan.original_info || { title: songTitle || '歌词改编', artist: artist || '', total_chapters: 0 }, plans };
    send({ type: 'progress', progress: 95, message: '正在保存改编方案(95%)…' });
    send({ type: 'status', message: '正在保存改编方案…' });
    db.prepare("UPDATE adaptation_jobs SET plan = ?, plans = ?, status = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(JSON.stringify(planPayload), JSON.stringify(plans || []), plans.length ? 'plan_ready' : 'failed', jobId);
    if (!plans.length) {
      return end({ type: 'error', message: '改编方案解析后为空，请重试。', raw: full });
    }
    send({ type: 'progress', progress: 100, message: `已生成 ${plans.length} 个改编方案` });
    return end({ type: 'done', data: { jobId, plan: planPayload, plans } });
  } catch (e) {
    if (e.name === 'AbortError') {
      db.prepare("UPDATE adaptation_jobs SET status = 'aborted', error = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(e.message, jobId);
      return end({ type: 'aborted', message: '已停止生成' });
    }
    const curJob = db.prepare("SELECT * FROM adaptation_jobs WHERE id = ?").get(jobId);
    if (curJob && curJob.status === 'done') return;
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

// 选择改编方案：在多方案中选择其一，写入 job.plan 供逐章改编使用
router.post('/novels/:id/adaptation/select-plan', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { planId } = req.body || {};
  const job = db.prepare(
    "SELECT * FROM adaptation_jobs WHERE novel_id = ? AND status = 'plan_ready' ORDER BY id DESC LIMIT 1"
  ).get(novel.id);
  if (!job) return res.status(409).json({ error: '没有待选择的改编方案' });
  let plans = [];
  try { plans = job.plans ? JSON.parse(job.plans) : []; } catch { plans = []; }
  if (!plans.length) {
    // 没有多方案（旧任务），直接放行
    return res.json({ ok: true, jobId: job.id, plan: (() => { try { return JSON.parse(job.plan || '{}'); } catch { return {}; } })() });
  }
  const picked = plans.find((p) => p.plan_id === planId) || plans[0];
  const planPayload = {
    original_info: { title: novel.title, total_chapters: getChapters(novel.id).length },
    plan_id: picked.plan_id,
    plan_name: picked.plan_name,
    intent_summary: picked.intent_summary || '',
    approach: picked.approach || '',
    global_notes: picked.global_notes || '',
    chapters: picked.chapters || []
  };
  db.prepare("UPDATE adaptation_jobs SET plan = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(JSON.stringify(planPayload), job.id);
  res.json({ ok: true, jobId: job.id, plan: planPayload });
});

// 多本融合分析：导入多本小说，AI 分析各本特点并给出融合建议
router.post('/novels/:id/adaptation/analyze-merge', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { novels: inputNovels } = req.body || {};
  if (!Array.isArray(inputNovels) || inputNovels.length < 2) {
    return res.status(400).json({ error: '请至少导入 2 本小说' });
  }
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  try {
    const novelList = inputNovels.slice(0, 5).map((n) => {
      const text = String(n.content || '').slice(0, 3000);
      return `【${n.title || '未命名'}】\n${text}`;
    }).join('\n\n---\n\n');

    const r = await chat({
      config,
      messages: [
        { role: 'system', content: '你是小说分析专家。以下是用户导入的多本小说开头片段。请分析每本小说的核心特点（世界观、文风、角色、剧情结构），然后给出融合改编的建议方向。输出 JSON：{"books":[{"title":"书名","features":"核心特点"}],"merge_suggestions":["融合方向1","融合方向2","融合方向3"]}' },
        { role: 'user', content: `以下是我导入的 ${inputNovels.length} 本小说，请分析并给出融合建议：\n\n${novelList}` }
      ],
      maxTokens: 4096,
      timeout: 120000
    });
    const analysis = extractJson(r.content);
    res.json({ ok: true, analysis: analysis || { books: [], merge_suggestions: ['分析失败，请手动描述改编意图'] } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const rangeStart = Math.round((currentIndex / total) * 100);
  const rangeEnd = Math.round((target.chapter_index / total) * 100);
  send({ type: 'progress', progress: rangeStart, message: `正在改编第 ${target.chapter_index}/${total} 章…` });
  send({ type: 'status', message: `正在分析第 ${target.chapter_index} 章原文…` });

  const userPrompt = `【本章原文】\n第${target.chapter_index}章 ${target.title}\n\n${target.content}

【改编意图】${job.intent}

【全局改编说明】${globalNotes || '（无）'}

【本章改造要点】${chapterAction ? chapterAction.actions.map((a) => `- ${a}`).join('\n') : '（无，按意图自然改编）'}

【已采纳前情摘要】${adoptedSummaries || '（无）'}

请按改编方案改写本章。`;

  const subProgress = (pct) => Math.round(rangeStart + (rangeEnd - rangeStart) * pct / 100);

  try {
    let full = '';
    send({ type: 'progress', progress: subProgress(1), message: `正在生成第 ${target.chapter_index} 章改编内容(1%)…` });
    send({ type: 'status', message: `正在生成第 ${target.chapter_index} 章改编内容，请稍候…` });
    let deltaCount = 0;
    await runLLMStream(config, [
      { role: 'system', content: ADAPTATION_CHAPTER_SYSTEM },
      { role: 'user', content: userPrompt }
    ], {
      ctrl,
      task: 'writing',
      maxTokens: Math.max(6000, Math.min(32000, (target.content.length + 4000) * 2)),
      onDelta: (d) => {
        full += d;
        deltaCount++;
        send({ type: 'delta', content: d });
        if (deltaCount % 2 === 0) {
          const chapterPct = 1 + Math.floor(deltaCount / 2);
          const pct = Math.min(subProgress(89), subProgress(1) + Math.round((subProgress(89) - subProgress(1)) * chapterPct / 89));
          send({ type: 'progress', progress: pct, message: `正在生成第 ${target.chapter_index} 章改编内容(${pct}%)…` });
        }
      }
    });

    send({ type: 'progress', progress: subProgress(92), message: '正在AI味检测…' });
    send({ type: 'status', message: '正在AI味检测…' });
    const candidateContent = full.trim();
    if (!candidateContent) {
      db.prepare("UPDATE adaptation_jobs SET failed_count = failed_count + 1, updated_at = datetime('now','localtime') WHERE id = ?").run(job.id);
      return end({ type: 'error', message: 'AI 未返回内容，请重试该章。' });
    }

    send({ type: 'progress', progress: subProgress(95), message: '正在保存候选章节(95%)…' });
    send({ type: 'status', message: '正在保存候选章节…' });
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
    send({ type: 'progress', progress: subProgress(100), message: `第 ${target.chapter_index} 章候选已生成` });

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
  const cleanContent = cleanAiText(cand.candidate_content);
  db.prepare('UPDATE chapters SET title = ?, content = ?, word_count = ?, updated_at = datetime(\'now\',\'localtime\') WHERE novel_id = ? AND chapter_index = ?')
    .run(cand.candidate_title || cand.original_title, cleanContent, countWords(cleanContent), novel.id, cand.chapter_index);
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

// 候选：批量处理（accepted|skipped）。body: { status, ids? | novelId? } 
// ids 缺省时对该小说当前 job 的全部 pending 候选生效
router.post('/adaptation-candidates/batch', async (req, res) => {
  const { status, ids, jobId } = req.body || {};
  const target = String(status) === 'accepted' ? 'accepted' : 'skipped';
  let rows;
  if (Array.isArray(ids) && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT * FROM adaptation_candidates WHERE id IN (${placeholders})`).all(...ids);
  } else if (jobId != null) {
    rows = db.prepare("SELECT * FROM adaptation_candidates WHERE job_id = ? AND status = 'pending'").all(Number(jobId));
  } else {
    return res.status(400).json({ error: '缺少 ids 或 jobId' });
  }
  let accepted = 0;
  let done = 0;
  for (const cand of rows) {
    if (target === 'accepted') {
      const novel = getNovel(cand.novel_id);
      if (!novel) continue;
      backupChapter(novel.id, cand.chapter_index, '整本改编');
      const cleanContent = cleanAiText(cand.candidate_content);
      db.prepare('UPDATE chapters SET title = ?, content = ?, word_count = ?, updated_at = datetime(\'now\',\'localtime\') WHERE novel_id = ? AND chapter_index = ?')
        .run(cand.candidate_title || cand.original_title, cleanContent, countWords(cleanContent), novel.id, cand.chapter_index);
      touchNovel(novel.id);
      db.prepare("UPDATE adaptation_candidates SET status = 'accepted' WHERE id = ?").run(cand.id);
      db.prepare("UPDATE adaptation_jobs SET accepted_count = accepted_count + 1, current_index = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(cand.chapter_index, cand.job_id);
      try {
        const full = getChapter(novel.id, cand.chapter_index);
        if (full) await writeChapterTxt(novel, full);
      } catch { /* 不阻塞 */ }
      accepted++;
      done++;
    } else {
      db.prepare("UPDATE adaptation_candidates SET status = 'skipped' WHERE id = ?").run(cand.id);
      db.prepare("UPDATE adaptation_jobs SET skipped_count = skipped_count + 1, updated_at = datetime('now','localtime') WHERE id = ?").run(cand.job_id);
      done++;
    }
  }
  // 全部处理完则任务收尾
  if (jobId != null) {
    const remain = db.prepare("SELECT COUNT(*) c FROM adaptation_candidates WHERE job_id = ? AND status = 'pending'").get(Number(jobId)).c;
    if (remain === 0) {
      db.prepare("UPDATE adaptation_jobs SET status = 'done', updated_at = datetime('now','localtime') WHERE id = ?").run(Number(jobId));
    }
  }
  return res.json({ ok: true, accepted, done });
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

  const { mode = 'next', chapterIndex, targetWords, overrideTitle, useReference } = req.body || {};
  const { ctrl, send, end } = startSSE(req, res);

  let idx;
  if (mode === 'regenerate') {
    idx = Number(chapterIndex);
  } else {
    // "下一章"逻辑：优先补第一个空内容章节，其次在已有内容的最后一章之后新建
    const firstEmpty = db.prepare("SELECT chapter_index FROM chapters WHERE novel_id = ? AND content = '' ORDER BY chapter_index LIMIT 1").get(novel.id);
    const lastDone = db.prepare("SELECT MAX(chapter_index) m FROM chapters WHERE novel_id = ? AND content != ''").get(novel.id);
    if (firstEmpty && lastDone && firstEmpty.chapter_index <= Number(lastDone.m || 0)) {
      // 空章节排在已写章节之前：说明它是"未写成功"的旧占位，用已写章节的下一章，避免重复生成已写章节
      idx = Number(lastDone.m) + 1;
      // 但若计划里该序号的占位不存在（全新扩展），使用 max+1
    } else {
      idx = firstEmpty ? firstEmpty.chapter_index : getMaxChapterIndex(novel.id) + 1;
    }
  }
  if (mode === 'regenerate' && (!idx || idx < 1)) {
    return end({ type: 'error', message: '缺少章节号' });
  }

  // Job 化
  let jobTry = tryCreateJob(novel.id, 'generate_chapter', { mode, chapterIndex: idx, targetWords });
  if (jobTry.conflict) {
    // 存在残留 running 的 generate_chapter 任务：abort 旧任务再新建（用户点生成/重新生成，意图明确）
    // 覆盖场景：上次生成中断后 job 残留 running，导致"已有进行中的章节生成任务"永远无法重试
    const staleId = jobTry.jobId;
    if (staleId) abortJob(staleId);
    jobTry = tryCreateJob(novel.id, 'generate_chapter', { mode, chapterIndex: idx, targetWords });
  }
  if (jobTry.conflict) {
    return end({ type: 'error', message: '该小说已有进行中的章节生成任务', jobId: jobTry.jobId });
  }
  const job = jobTry.job;
  send({ type: 'job', jobId: job.id, stage: 'generate_chapter', chapterIndex: idx });
  send({ type: 'progress', progress: 5, message: `正在准备第 ${idx} 章…` });
  updateJob(job.id, { progress: 5, stream_cursor: `正在准备第 ${idx} 章…` });

  const targetWordsN = Number(targetWords) || novel.chapter_word_count || 2000;

  // 已有章节（用于记忆），过滤掉正在生成的章及其之后的章节（重新生成某章时，
  // 其后的章节尚未发生，不得作为前情注入，否则会把后面的剧情提前写进本章）
  const existing = getChapter(novel.id, idx);
  const recentChapters = getRecentChapters(novel.id, 3, idx);
  const historySummaries = buildHistorySummaries(novel.id, Math.floor(contextBudget(config) * 0.6), idx);
  const characters = getCharacters(novel.id);
  const novelFactions = getFactions(novel.id);

  // 章节标题：优先级 覆盖标题 > 已有标题 > 大纲占位 > AI 生成
  let title = overrideTitle && String(overrideTitle).trim() ? String(overrideTitle).trim()
    : (existing && existing.title && !existing.content && !isPlaceholderTitle(existing.title) ? existing.title : null);

  try {
    if (!title) {
      send({ type: 'status', message: `正在构思第 ${idx} 章标题…` });
      send({ type: 'progress', progress: 10, message: `正在构思第 ${idx} 章标题…` });
      const planned = novel.outline && Array.isArray(novel.outline) ? null : null;
      const planChapter = db.prepare('SELECT title, summary FROM chapters WHERE novel_id = ? AND chapter_index = ?').get(novel.id, idx);
      if (planChapter?.title && !isPlaceholderTitle(planChapter.title)) {
        title = planChapter.title;
      } else {
        const prevChapterTitle = db.prepare("SELECT title FROM chapters WHERE novel_id = ? AND chapter_index = ? AND content != ''").get(novel.id, idx - 1);
        const titleContext = buildNovelContext(novel, characters, [], [], 0, '', novelFactions)
          + (prevChapterTitle ? `\n\n上一章标题：${prevChapterTitle.title}` : '')
          + `\n\n即将创作第 ${idx} 章的剧情概要：${planChapter?.summary || '承接前文继续推进'}\n\n请为这一章拟一个贴合内容的标题。`;
        const tRes = await chat({
          config,
          messages: [
            { role: 'system', content: CHAPTER_TITLE_SYSTEM },
            { role: 'user', content: titleContext }
          ],
          maxTokens: 200
        });
        let rawTitle = (tRes.content || '').trim();
        // 清理标题：去掉引号、书名号、章节前缀（中文数字和阿拉伯数字）
        rawTitle = rawTitle.replace(/["'《》「」『』]/g, '').replace(/^第[一二三四五六七八九十百千\d]+章\s*/g, '').replace(/\n+/g, ' ').trim();
        title = rawTitle.slice(0, 15);
        if (!title || isPlaceholderTitle(title)) {
          // 第一次标题生成失败或仍为占位（模型偷懒只输出"第N章"），带剧情概要重试一次
          try {
            const retryCtx = `小说：《${novel.title}》（${novel.genre}）\n\n第 ${idx} 章剧情概要：${planChapter?.summary || existing?.summary || '承接前文继续推进'}\n\n请为这一章拟一个 4-15 字的自然标题，像真人作者随手起的，只输出标题本身。`;
            const tRes2 = await chat({
              config,
              messages: [
                { role: 'system', content: CHAPTER_TITLE_SYSTEM },
                { role: 'user', content: retryCtx }
              ],
              maxTokens: 100
            });
            let raw2 = (tRes2.content || '').trim();
            raw2 = raw2.replace(/["'《》「」『』]/g, '').replace(/^第[一二三四五六七八九十百千\d]+章\s*/g, '').replace(/\n+/g, ' ').trim();
            title = raw2.slice(0, 15);
          } catch { title = ''; }
        }
        if (!title || isPlaceholderTitle(title)) title = ''; // 留空，正文生成后按内容补拟
      }
    }

    send({ type: 'status', message: `正在创作「${title}」（目标 ${targetWordsN} 字）…` });
    send({ type: 'progress', progress: 15, message: `正在创作「${title}」…` });

    send({ type: 'status', message: '正在读取前文记忆与设定…' });

    // 上下文记忆：压缩模式下用故事状态简报替代前情摘要 + 最近章节全文
    const useCompressed = novel.context_compressed == 1 && novel.compressed_context;
    let memoryBlock = '';
    if (!useCompressed) {
      try {
        const memText = await readMemoryFile(novel);
        if (memText) {
          const memFiltered = trimMemoryToIndex(memText, idx);
          memoryBlock = trimMemoryToBudget(memFiltered, Math.floor(contextBudget(config) * 0.55));
        }
      } catch { memoryBlock = ''; }
    }
    const context = useCompressed
      ? buildNovelContext(novel, characters, [], [], 0, '', novelFactions) + `\n\n【故事状态简报（已压缩，替代前情摘要与最近章节全文）】\n${novel.compressed_context}`
      : memoryBlock
        ? buildNovelContext(novel, characters, recentChapters, [], contextBudget(config), memoryBlock, novelFactions)
        : buildNovelContext(novel, characters, recentChapters, historySummaries, contextBudget(config), 0, novelFactions);

    // 待回收伏笔注入：防止前期埋下的坑被遗忘（仅取本章之前埋下的）
    const openFores = getOpenForeshadowings(novel.id, 60, idx);
    const foresBlock = formatForeshadowList(openFores)
      ? `【待回收伏笔（前面埋下的线索，本章如未回收也须自然呼应或保持存在感，不可遗忘）】\n${formatForeshadowList(openFores)}`
      : '';

    // 世界观设定注入：保证长篇写作的世界观一致性
    const worldBlock = formatWorldSettings(getWorldSettings(novel.id))
      ? `【世界观设定（创作时须严格遵守，不得与既定设定冲突）】\n${formatWorldSettings(getWorldSettings(novel.id))}`
      : '';

    // 关键剧情事实锚点：长期连载中防设定冲突与关键信息遗忘（仅取本章之前确立的）
    const kmItems = getKeyMoments(novel.id, 80, idx);
    const kmBlock = formatKeyMoments(kmItems)
      ? `【本书已确立的关键剧情事实（长期记忆锚点，创作时必须遵循，不得与已发生事实矛盾，也不要重复叙述已明确交代过的事）】\n${formatKeyMoments(kmItems)}`
      : '';

    // 阶段记忆（卷快照）：超长连载中早期剧情不丢，注入最近阶段快照（仅取本章之前封存的阶段）
    const stageMemoriesBefore = getStageMemories(novel.id, idx);
    const stageBlock = formatStageMemories(stageMemoriesBefore, 3)
      ? `【前情阶段摘要（更早章节的长效记忆浓缩，供把握历史走向；创作时须与之一致，可自然延续其局势）】\n${formatStageMemories(stageMemoriesBefore, 3)}`
      : '';

    // 角色档案：性格核心与言行习惯，创作时必须保持，防角色性格突变
    const profileBlock = formatCharacterProfiles(getCharacterProfiles(novel.id))
      ? `【角色档案（性格核心与说话风格，创作时必须保持，不得让角色性格突变、言行前后矛盾）】\n${formatCharacterProfiles(getCharacterProfiles(novel.id))}`
      : '';

    // P0-P3 增强记忆块：分层摘要树 + 结构化事实 + 角色时间线 + 故事时间线 + 逾期伏笔 + 文笔漂移
    const enhancedMemBlock = buildEnhancedMemoryBlock(novel.id, idx);

    // P0-2: RAG 检索 — 检索与"上一章结尾 + 本章概要"最相关的历史片段，作为设定背景参考
    // 注意：query 若用占位符概要（自动生成占位）会导致检索结果随机、污染正文，须优先用上一章结尾兜底
    let ragBlock = '';
    try {
      const ragQueryParts = [];
      const prevTailForRag = db.prepare("SELECT content FROM chapters WHERE novel_id = ? AND chapter_index = ? AND content != ''").get(novel.id, idx - 1)?.content || '';
      if (prevTailForRag) ragQueryParts.push(String(prevTailForRag).slice(-200));
      if (existing?.summary && !String(existing.summary).includes('自动生成占位') && !String(existing.summary).includes('根据大纲推进剧情')) {
        ragQueryParts.push(existing.summary);
      }
      if (!ragQueryParts.length) ragQueryParts.push(title);
      const ragChunks = retrieveRelevant(novel.id, ragQueryParts.join(' '), 4, idx);
      ragBlock = formatRagBlock(ragChunks);
    } catch { /* RAG 检索失败不阻塞 */ }

    // 小说宪法 + 角色语音档案（跨模型一致性锚点）
    const constitution = getConstitution(novel.id);
    const charVoices = formatCharacterVoices(novel.id);
    // 知识学习库注入：用户手动关联 + 按题材自动匹配
    const manualIds = getNovelKnowledgeIds(novel);
    const autoIds = getKnowledgeByGenres([novel.genre || ''], 2)
      .map((k) => k.id)
      .filter((id) => !manualIds.includes(id));
    const knowledgeIds = [...manualIds, ...autoIds];
    const knowledgeBlock = formatKnowledgeBlock(knowledgeIds);
    let knowledgeSamples = '';
    let plotReferenceBlock = '';
    if (knowledgeIds.length) {
      knowledgeSamples = knowledgeIds.map((id) => getSampleSnippets(id, 1800)).filter(Boolean).join('\n\n---\n\n').slice(0, 5000);
      // 汇总剧情参考：从各知识库提取可借鉴的剧情结构信息（只取结构描述，不注入含角色的原文片段）
      const plotRefs = knowledgeIds.map((id) => {
        const snippets = getSampleSnippets(id, 2000);
        if (!snippets) return null;
        const firstScene = snippets.split('\n\n')[0] || '';
        // 仅保留不含中文人名迹象的纯叙述句段，避免把其他作品角色名带进本书
        const lines = firstScene.split('\n').filter((l) => {
          const s = l.trim();
          if (!s || s.length < 8) return false;
          // 含典型对话引导词或常见人名用字比例高的行跳过
          if (/[:：]"/.test(s) || /"[:：]/.test(s)) return false;
          return true;
        });
        const brief = lines.slice(0, 3).join(' ').slice(0, 200);
        return brief || null;
      }).filter(Boolean);
      if (plotRefs.length) {
        plotReferenceBlock = `\n\n【已导入同类小说的剧情结构参考（仅概括其节奏特点，属其他作品——其中出现的人物/地名/情节一律不得用于本书正文）】\n${plotRefs.join('\n')}`;
      }
    }
    const skillIds = getNovelSkillIds(novel);
    // 题材联动：技能 tags 含小说题材关键词的自动带入选，降低手动配置成本
    const autoSkillIds = recommendSkillsForGenre(novel.genre).filter((id) => !skillIds.includes(id));
    const skillsBlock = formatSkillsBlock([...skillIds, ...autoSkillIds]);
    const chapterSysOpts = {
      constitution: constitution || '',
      characterVoices: charVoices || '',
      knowledgeBlock: (knowledgeBlock + (knowledgeSamples ? KNOWLEDGE_SAMPLE_INTRO + knowledgeSamples : '') + plotReferenceBlock).trim(),
      skillsBlock,
      genre: novel.genre
    };

    // 场景节拍（beats）：优先使用方案阶段生成的细纲，否则运行时生成
    let beatsBlock = '';
    try {
      const storedBeats = existing?.beats ? (() => { try { return JSON.parse(existing.beats); } catch { return null; } })() : null;
      if (Array.isArray(storedBeats) && storedBeats.length) {
        const lines = storedBeats.map((b, i) => {
          return `场景${i + 1}「${b.scene || ''}」（${b.location || ''}）
- 出场：${b.characters || ''}
- 发生：${b.action || ''}
- 细节：${b.sensory_detail || ''}
- 作用：${b.purpose || ''}${b.tone ? `｜情绪：${b.tone}` : ''}`;
        }).filter(Boolean).join('\n\n');
        beatsBlock = lines ? `【本章场景规划（细纲，每个 beat 的关键画面、转折与信息必须真实落实到正文，不得漏拍、不得合并关键转折，先后顺序不打乱；场景之间自然过渡，最后落实钩子）】\n${lines}` : '';
      } else {
        send({ type: 'status', message: '正在规划本章场景…' });
        const btRes = await chat({
          config,
          task: 'writing',
          messages: [
            { role: 'system', content: CHAPTER_BEAT_SYSTEM },
            { role: 'user', content: `小说：《${novel.title}》题材：${novel.genre}\n第${idx}章 ${title}\n本章剧情概要：${existing?.summary || '承接前文继续推进'}\n本章情绪基调：${existing?.emotion || '（由你判断）'}\n本章推进：${existing?.arc_hint || '推进主线'}\n\n出场角色参考：${characters.map((c) => c.name + '（' + (c.role_type || '配角') + '）').join('、') || '（由你判断）'}\n\n请将本章拆解为场景级 beat。` }
          ],
          maxTokens: 2000
        });
        const beats = extractJson(btRes.content);
        if (Array.isArray(beats) && beats.length) {
          // 保存到数据库以供后续章节引用
          try {
            db.prepare('UPDATE chapters SET beats = ? WHERE id = ?').run(JSON.stringify(beats), existing?.id || 0);
          } catch { /* 保存失败不阻塞 */ }
          const lines = beats.map((b, i) => {
            return `场景${i + 1}「${b.scene || ''}」（${b.location || ''}）
- 出场：${b.characters || ''}
- 发生：${b.action || ''}
- 细节：${b.sensory_detail || ''}
- 作用：${b.purpose || ''}${b.tone ? `｜情绪：${b.tone}` : ''}`;
          }).filter(Boolean).join('\n\n');
          beatsBlock = lines ? `【本章场景规划（每个 beat 的关键画面、转折与信息必须真实落实到正文，不得漏拍、不得合并关键转折，先后顺序不打乱；场景之间自然过渡，最后落实钩子）】\n${lines}` : '';
        }
      }
    } catch { /* beats 失败不阻塞，直接进入正文创作 */ }

    // 联网参考同类小说
    let referenceBlock = '';
    if (useReference) {
      try {
        send({ type: 'status', message: '正在搜索同类热门小说参考…' });
        const refResp = await fetch(`http://localhost:${req.socket.localPort}/api/novels/${novel.id}/reference-search`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }
        }).catch(() => null);
        if (refResp && refResp.ok) {
          const refData = await refResp.json();
          if (refData.formatted) {
            referenceBlock = '\n\n' + refData.formatted;
            send({ type: 'status', message: '已加载同类小说参考，将在创作中借鉴其节奏与手法' });
          }
        }
      } catch { /* 参考搜索失败不阻塞 */ }
    }

    // 上一章结尾片段：强制本章从它续写，防止跑题（模型易忽略模糊的前情）
    const prevChapter = db.prepare("SELECT title, content, summary, beats FROM chapters WHERE novel_id = ? AND chapter_index = ? AND content != ''").get(novel.id, idx - 1);
    const prevChapterSummary = prevChapter?.summary ? `\n上一章概要：${prevChapter.summary}` : '';
    let prevBeatsBlock = '';
    if (prevChapter?.beats) {
      try {
        const prevBeats = JSON.parse(prevChapter.beats);
        if (Array.isArray(prevBeats) && prevBeats.length) {
          const lines = prevBeats.map((b, i) => `场景${i + 1}「${b.scene || ''}」：${b.action || ''}`).join('\n');
          prevBeatsBlock = `\n上一章细纲：\n${lines}`;
        }
      } catch { /* 解析失败不阻塞 */ }
    }
    const prevTailLen = mode === 'regenerate' ? 2000 : 1200;
    const prevTailBlock = prevChapter
      ? `【上一章结尾（本章必须从上一章结尾的场面直接续写，严格延续时间/地点/人物/悬念，不得倒回上一章开头重新描写同一场景，不得重复已经发生过的事件）】
上一章《${prevChapter.title}》${prevChapterSummary}${prevBeatsBlock}
上一章结尾：
…${String(prevChapter.content).slice(-prevTailLen)}
【衔接要求】
- 本章第一句必须紧接上述"上一章结尾"的最后一个人物动作、一句对话或一个悬念往下写，让读者感到前后两章是连续的。
- 开头不得另起炉灶介绍新场景/新人物/新设定，不得从"时间过去了很久""另一边""与此同时"等跳转话术另开一线。
- 若上一章结尾主角正处在某个地点/某个动作中，本章开头就从这个地点/动作继续。`
      : '';

const regenNote = mode === 'regenerate'
      ? '\n【本章为重新生成——请基于剧情大纲和上一章结尾重新创作本章，严格遵循本章的剧情概要/场景规划/情绪基调/剧情线，确保与前文剧情一致，不得偏离既定故事走向】'
      : '';
    const ch1Note = idx === 1 && mode === 'regenerate'
      ? '\n【重要：本章是全书第一章，必须从故事开头写起，只写开篇引子/初始场景/主角登场，禁止提前引入中后期剧情、势力、角色或冲突。大纲中的中后期内容全部跳过，不要提前使用】'
      : '';

    const userPrompt = `${context}
${prevTailBlock}
【角色隔离铁律（必须严格遵守）】
- 本书能出现的角色，只限上方【主要角色】【角色档案】中列出的本书角色。
- 任何参考作品/样本/搜索结果中出现的人物名、地名、组织名、势力名、物品名（即使眼熟），一律禁止写进本书正文。
- 若记不清某角色是否属于本书，宁可不用，也不要冒用参考作品中的名字。
【角色记忆铁律】
- 禁止编造不存在的对话回忆：角色"回想起""想起""记得"的对话或事件，必须是本章前面已经明确写过的内容，不得编造本章未出现的对话或事件。
- 角色之间的基本关系（师徒、住所、相识与否）必须以【角色档案】中的设定为准，角色不知道的信息不要写"他不知道"——直接避免涉及该信息。
- 角色说过的每一句话必须在本章正文中有明确出处，不得让角色"想起"本章未发生过的对话。
 ${foresBlock}
 ${worldBlock}
 ${kmBlock}
 ${stageBlock}
 ${profileBlock}
 ${enhancedMemBlock}
 ${ragBlock}
 ${beatsBlock}
 ${referenceBlock}
 
 本章信息：
${regenNote}
${ch1Note}
- 章节序号：第 ${idx} 章
- 全书共 ${novel.target_chapters || '?'} 章，当前处于 ${chapterStageLabel(idx, novel.target_chapters)}
- 章节标题：${title}
- 本书主角：${characters.filter((c) => String(c.role_type || '').includes('主角')).map((c) => c.name).join('、') || '（见【主要角色】中 role_type 为"主角"的角色）'}
- 本章剧情概要：${existing?.summary && !String(existing.summary).includes('自动生成占位') && !String(existing.summary).includes('根据大纲推进剧情') ? existing.summary : '（未提供）——一切情节以衔接上方【上一章结尾】的场面为准'}
${existing?.emotion ? `- 本章情绪基调：${existing.emotion}（全章要有意识地营造该情绪氛围，但不能全程紧绷——情绪要有起伏，以该基调为底色）` : ''}
${existing?.arc_hint ? `- 本章推进的剧情线：${existing.arc_hint}（本章的戏份应优先围绕这条线展开，其余线索以呼应/推进伏笔为主）` : ''}
${existing?.hook ? `- 本章结尾钩子：${existing.hook}（全章情节要水到渠成地导向这个结尾，收尾时落实到具体场景/物件/对话，让读者想翻下一章）` : ''}
- 小说类型：${novel.genre || '未设定'}，本章的题材基调必须严格符合该类型（恐怖小说要有恐怖氛围与惊悚逻辑，玄幻要有修炼体系，都市要有现实感，不得脱离类型写走样）
- 目标字数：约 ${targetWordsN} 字

请开始创作本章正文。`;

    send({ type: 'status', message: '上下文准备完成，正在生成正文…' });
    send({ type: 'progress', progress: 20, message: `正在生成第 ${idx} 章正文…` });

    // 整章生成 + 自动质检循环：每版生成后自动检查（跑题/AI 味/剧情一致性），凡检出问题一律整章重新生成，最多重试 MAX_AUTO_REGENERATE 次
    let full = '';
    let finishReason = 'stop';
    let finalDetect = { score: 0, issues: [] };
    let finalBlacklist = [];
    let finalRounds = [];
    let lastProblems = [];
    let structureFixes = []; // 表达层结构问题（失衡/口癖/复述），注入润色定向修复，不触发整章重生成
    const perMax = Math.max(2000, Math.min(16000, Math.round(targetWordsN * 1.8)));

    const buildRegenFeedback = (problems) => `【上一版未通过自动检查，本次整章重新生成必须修正的问题】
${problems.map((p, i) => `${i + 1}. ${p.desc}`).join('\n')}

请按上述问题整体重写本章：修正这些错误，其余内容保持人类写作风格，剧情与人设不变。`;

    for (let attempt = 0; attempt <= MAX_AUTO_REGENERATE; attempt++) {
      const isRegen = attempt > 0;
      if (isRegen) {
        send({ type: 'reset' });
        send({ type: 'status', message: `第 ${idx} 章检出 ${lastProblems.length} 处问题，正在整章重新生成（第 ${attempt + 1} 版）…` });
        send({ type: 'progress', progress: 60, message: `整章重新生成（第 ${attempt + 1} 版）…` });
      }

      full = '';
      finishReason = 'stop';
      // 生成资源观测：本轮生成累积了多少轮、触发原因分布
      const genTrack = { rounds: 0, reasons: { length: 0, early_stop: 0, done: 0 } };
      const genStartAt = Date.now();
      const attemptPrompt = isRegen ? userPrompt + '\n\n' + buildRegenFeedback(lastProblems) : userPrompt;
      // 若上一版因"照抄参考作品/英文泄漏"被拒，重生成时剔除知识库样本原文（只保留分析），避免模型再次照抄
      let regenSysOpts = chapterSysOpts;
      if (isRegen && lastProblems.some((p) => /照抄|参考作品|英文话术|内部指令|跑飞/.test(String(p.desc)))) {
        try {
          regenSysOpts = { ...chapterSysOpts, knowledgeBlock: formatKnowledgeBlock(knowledgeIds) };
        } catch { /* 保持原样 */ }
      }
      // 自动续写：单次输出被 max_tokens 截断（finish_reason=length）或模型提前停止时继续往下写，直到达到目标字数
      for (let round = 0; round < 12; round++) {
        const msgs = round === 0
          ? [
              { role: 'system', content: buildChapterSystem(getStyles(parseStyleIds(novel)), novel.style_baseline, novel.style_samples, parseStylePresets(novel), regenSysOpts) },
              { role: 'user', content: attemptPrompt }
            ]
          : [
              { role: 'system', content: buildChapterSystem(getStyles(parseStyleIds(novel)), novel.style_baseline, novel.style_samples, parseStylePresets(novel), regenSysOpts) },
              { role: 'user', content: buildContinuePrompt(full, targetWordsN, characters) }
            ];
        if (round > 0) {
          send({ type: 'status', message: `正在续写第 ${idx} 章剩余部分…` });
          const contPct = Math.min(70, 15 + round * 6);
          send({ type: 'progress', progress: contPct, message: `正在续写第 ${idx} 章（第 ${round + 1} 轮）…` });
        }
        let deltaCount = 0;
        const r = await runLLMStream(config, msgs, {
          ctrl,
          task: 'writing',
          maxTokens: perMax,
          onDelta: (d) => {
            full += d;
            send({ type: 'delta', content: d });
            deltaCount += d.length;
            if (deltaCount >= 500) {
              deltaCount = 0;
              const wc = countWords(full);
              const pct = Math.min(55, 25 + Math.round((wc / targetWordsN) * 30));
              send({ type: 'progress', progress: pct, message: `正在生成第 ${idx} 章（${wc}/${targetWordsN} 字）…` });
            }
          }
        });
        // finishReason 为空/undefined/null 时视为 length（继续续写），不默认回退到 'stop'
        const rawFinish = r?.finishReason;
        finishReason = (rawFinish && (rawFinish === 'stop' || rawFinish === 'length')) ? rawFinish : 'length';
        genTrack.rounds = round + 1;
        genTrack.reasons[finishReason === 'length' ? 'length' : 'early_stop'] += 1;
        const wordsSoFar = countWords(full);
        const needsMore = wordsSoFar < Math.min(targetWordsN * 0.95, targetWordsN - 100);
        if (finishReason === 'length') {
          // 正常截断或未知原因中断，继续续写
        } else if (finishReason === 'stop' && needsMore && round < 11) {
          send({ type: 'status', message: `检测到输出提前结束（${wordsSoFar} 字），正在继续补写…` });
        } else {
          genTrack.reasons.done += 1;
          break;
        }
        if (wordsSoFar >= targetWordsN) {
          genTrack.reasons.done += 1;
          break;
        }
        if (wordsSoFar > targetWordsN * 1.3) {
          genTrack.reasons.done += 1;
          send({ type: 'status', message: `字数已超过目标 ${targetWordsN} 字（当前 ${wordsSoFar} 字），结束续写` });
          break;
        }
      }

      // 落一条生成统计：观察续写轮数与触发分布，为调阈值提供数据
      try {
        db.prepare(`INSERT INTO generation_stats
          (novel_id, chapter_index, stage, rounds, state, pipe_reason, rs_model, start_words, target_words, seamless_words, ms_connecting, duration_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            novel.id, idx, 'chapter', genTrack.rounds,
            finishReason, genTrack.reasons.length ? 'length' : 'stop',
            String(config?.model || ''), countWords(full), targetWordsN,
            countWords(full), 0, Date.now() - genStartAt
          );
      } catch { /* 统计写入失败不阻塞生成 */ }

      if (!full.trim()) {
        updateJob(job.id, { status: 'failed', error: 'AI 未返回内容' });
        return end({ type: 'error', message: 'AI 未返回内容，请重试。' });
      }

      // 续写指令残留检测：若模型把"续写占位符话术"当成正文输出（如"请把【末尾节选】的实际文字发给我"），判定为生成失败，不落库
      const resumeResidue = String(full).match(/(请|需要|把|提供).{0,12}(末尾节选|已写部分|实际文字|正文内容|粘贴|发给我).{0,20}/);
      const pureResume = /^(请|麻烦)(把|将|提供|粘贴)/.test(String(full).trim()) || /^您把写作要求/.test(String(full).trim());
      if ((resumeResidue && String(full).length < 300) || pureResume) {
        updateJob(job.id, { status: 'failed', error: 'AI 输出续写占位话术' });
        return end({ type: 'error', message: 'AI 输出了续写占位话术而非正文，请重试。' });
      }

      // 规则化清污（标点全角化、省略号归一、叹号压缩、空行折叠）。幂等，润色后也安全。
      full = cleanAiText(full);
      // 剥离正文开头的思考/任务复述残留（推理型模型把"复述任务"当正文输出）
      full = stripThinkingResidue(full);
      // 移除 AI 可能在正文开头输出的"第N章"标记（标题由系统独立管理）
      full = full.replace(/^第[一二三四五六七八九十百千\d]+章\s*\n*/g, '').trim();

      send({ type: 'progress', progress: 60, message: `正在检查第 ${idx} 章质量…` });

      // ---- 自动质检：跑题 + AI 味 + 剧情一致性 ----
      const problems = [];

      // 重复内容检测：本章开头与上一章开头高度相似则判定为重复
      if (prevChapter && String(prevChapter.content).length > 200) {
        const prevStart = String(prevChapter.content).slice(0, 200).replace(/\s+/g, '');
        const currStart = full.slice(0, 200).replace(/\s+/g, '');
        const overlap = longestCommonSubstring(prevStart, currStart);
        if (overlap.length > 60) {
          problems.push({ desc: `本章开头与上一章开头高度相似（重复${overlap.length}字），疑似重复上一章内容，须从上一章结尾之后的时间点续写，不得倒退重写` });
        }
      }

      // 0a) 开头跳转/脱节检测：本章第一句若以"时间流逝/另起一线"等跳转话术开头，说明没有紧接上一章结尾续写
      if (prevChapter) {
        const firstLine = full.split(/\n/)[0].trim().replace(/^第[一二三四五六七八九十百千\d]+章\s*/, '');
        if (/^(?:时间(?:过了|过去|流逝|一晃)|过了(?:很久|许久|几天|几年|一段|些日子)|(?:另一边|与此同时|镜头一转|画面一转|另一方面|然而此时)|(?:良久|许久)之后|与此同时)/.test(firstLine)) {
          problems.push({ desc: `本章开头以"${firstLine.slice(0, 20)}…"跳转话术开头，未紧接上一章结尾续写（上一章结尾：${String(prevChapter.content).slice(-60)}…）。须从上一章结尾的场面/动作/对话直接继续` });
        }
      }

      // 0a2) 剧情衔接硬校验（模型无关）：除开头话术外，进一步核对地点跳变/角色状态断裂等
      //      更隐蔽的脱节形态（上一章结尾重伤/昏迷/对峙，本章开头却平静无事；或地点无交代跳变）
      try {
        if (prevChapter && String(prevChapter.content).length > 100) {
          const prevContent = String(prevChapter.content);
          const seamHead = full.slice(0, 400);
          const seam = checkSeamlessConnection(prevContent, seamHead);
          for (const p of seam) {
            if (!problems.some((q) => q.desc.includes(p.desc.slice(0, 12)))) {
              problems.push({ desc: `${p.desc}（上一章结尾：${prevContent.slice(-50)}…）` });
            }
          }
        }
      } catch { /* 衔接硬校验失败不阻塞 */ }

      // 0) 参考作品照抄检测：正文与知识库/风格库样本原文大量重复，说明模型把参考作品当正文写了
      try {
        const copySources = [knowledgeSamples, plotReferenceBlock, referenceBlock, String(novel.style_samples || '')].filter((x) => x && String(x).trim().length > 30);
        if (copySources.length) {
          for (const src of copySources) {
            const cp = detectSampleCopy(full, src, 30);
            if (cp.copied) {
              problems.push({ desc: `正文与已导入的参考作品/知识库原文重复 ${cp.len} 字（"${cp.quote}…"），疑似把参考样本当成本章正文照抄，须完全用自己的话重写，严禁沿用参考作品中的人物、场景与设定` });
              break;
            }
          }
        }
      } catch { /* 照抄检测失败不阻塞 */ }

      // 0b) 英文指令/系统话术泄漏检测：模型把内部指令当正文输出
      try {
        const leak = detectEnglishLeak(full);
        if (leak.leaked) {
          problems.push({ desc: `正文混入模型内部指令/英文话术（"${leak.quote}"），属生成跑飞，须整章重写，只保留纯小说正文` });
        }
      } catch { /* 泄漏检测失败不阻塞 */ }

      // 0c) 思考/任务复述残留检测：推理型模型把"复述任务要求"当正文开头输出（"我们需要回答用户：重写《X》第一章正文…"）
      try {
        const think = detectThinkingResidue(full);
        if (think.leaked) {
          problems.push({ desc: `正文开头混入思考/任务复述残留（"${think.quote}"），属模型把内部规划当正文，须整章重写为纯小说正文` });
        }
      } catch { /* 思考残留检测失败不阻塞 */ }

      // 1) 题材跑题检测
      try {
        const drift = scanTopicDrift(full, novel.genre);
        if (drift.length) {
          problems.push({ desc: `题材跑题（${drift.map((d) => d.word).join('、')}），与「${novel.genre}」题材不符` });
        }
      } catch { /* 跑题检测失败不阻塞 */ }

      // 2) AI 味检测（含黑名单硬过滤）
      let det = { score: 0, issues: [] };
      let bl = [];
      try {
        det = await runDetection(config, full);
        const hits = scanAiPatterns(full);
        bl = blacklistFlagWords(hits, full.length);
        const total = Math.min(100, det.score + blacklistPenalty(hits, full.length));
        if (total > aiScorePass() || bl.length > 0) {
          problems.push({ desc: `AI 味明显（${total} 分，阈值 ${aiScorePass()}${bl.length ? '；高频复用词语：' + bl.join('、') : ''}）` });
        }
        finalDetect = det;
        finalBlacklist = bl;
        finalRounds = [{ round: 1, detectScore: det.score, blacklistPenalty: blacklistPenalty(hits, full.length), score: total, blacklist: bl }];
      } catch { /* 检测失败不阻塞 */ }

      // 2b) 故事可读性检测：文笔干净但平铺直叙、无张力、无欲望尖点也判 rewrite
      let rd = { average: 0, verdict: 'pass', issues: [] };
      try {
        rd = await runReadability(config, full);
        if (rd.verdict === 'rewrite') {
          const rdIssues = (rd.issues || []).slice(0, 4)
            .map((i) => `[${i.dimension || '可读性'}] ${i.suggestion || i.problem || ''}`)
            .join('；');
          problems.push({ desc: `故事可读性不达标（平均 ${rd.average}/10${rdIssues ? '，' + rdIssues : ''}）：章节平铺直叙、缺乏冲突与欲望钩子，须重写注入戏剧张力` });
        }
      } catch { /* 可读性检测失败不阻塞 */ }

      // 3) 剧情一致性校验
      try {
        const consistency = await checkPlotConsistency(novel.id, idx, full, config);
        const cs = consistency?.overall_consistency;
        if (cs && cs !== 'consistent') {
          const issueLines = (consistency.issues || []).slice(0, 6).map((i) => `【${i.type || '逻辑'}】${i.description || ''}`).join('；');
          problems.push({ desc: `剧情逻辑问题（${cs}）${issueLines ? '：' + issueLines : ''}` });
        }
      } catch { /* 校验失败不阻塞 */ }

      // 4) 行为逻辑规则检查（轻量级，不调 LLM，用正则匹配常见行为逻辑矛盾）
      try {
        const behaviorIssues = [];
        const txt = full;
        // 深可见骨/骨折/贯穿伤/大出血 + 创可贴/简单包扎/贴个创口贴 = 伤害与处理不匹配
        const severeWound = /[深可]见骨|骨折|贯穿|骨裂|大出血|血流如注|伤口翻|皮肉翻开|露骨/;
        const trivialTreatment = /创可贴|创口贴|贴个|简单包扎|随便包了|止血贴/;
        if (severeWound.test(txt) && trivialTreatment.test(txt)) {
          const woundMatch = txt.match(severeWound);
          const treatMatch = txt.match(trivialTreatment);
          behaviorIssues.push(`行为逻辑：出现重度伤害（${woundMatch[0]}）后仅用${treatMatch[0]}处理，严重违反常识——重伤必须缝合/包扎止血/就医，不能贴个创可贴了事`);
        }
        // 致命伤/重伤后角色立即若无其事（同一段内从受伤跳到正常行动，无缓冲描写）
        const severeInjury = /[深可]见骨|骨折|贯穿|骨裂|大出血|血流如注|伤口翻|皮肉翻开|吐血|浑身是血|重伤|致命/;
        const normalAction = /掏出手机|刷了?[一几]?下|点开微信|编辑|收起手机|嘴角抽了抽|自言自语|语气平淡/;
        if (severeInjury.test(txt)) {
          const injuryIdx = txt.search(severeInjury);
          const after = txt.slice(injuryIdx, injuryIdx + 500);
          if (normalAction.test(after) && !after.includes('包扎') && !after.includes('缝合') && !after.includes('止血') && !after.includes('上药') && !after.includes('缠') && !after.includes('绷带')) {
            behaviorIssues.push('行为逻辑：角色受重伤后立即若无其事地做其他事（刷手机/自言自语），中间缺少伤口处理与情绪缓冲描写');
          }
        }
        // 角色在公共场合使用超自然/暴力行为，周围无旁观者反应
        const publicPlace = /医院|警察局|学校|商场|街道|饭馆|地铁|公交|广场|小区|楼道|走廊|大厅/;
        const obviousAction = /掐诀|念咒|画符|施法|飞剑|法术|灵光|血气|黑雾|阴气|鬼气|爆炸|打斗|踢飞|撞飞|砸/;
        if (publicPlace.test(txt) && obviousAction.test(txt)) {
          const hasWitness = /围观|尖叫|报警|逃跑|喊|惊叫|骚动|惊呼|吓|愣住|尖叫|躲避|众人|周围|路人|有人|群众|人群/;
          const placeMatch = txt.match(publicPlace);
          if (!hasWitness.test(txt)) {
            behaviorIssues.push(`行为逻辑：角色在${placeMatch[0]}等公共场合使用超自然/暴力能力，但周围没有任何旁观者反应——公共场合发生异常事件，必须有围观/尖叫/报警等反应`);
          }
        }
        for (const desc of behaviorIssues) {
          problems.push({ desc });
        }
      } catch { /* 行为规则检查失败不阻塞 */ }

      // 5) 表达层结构检测（免费正则，模型无关）：对白失衡/跨章口癖固化/自我复述。
      //    这些属"表达层"问题，整章重生成同样概率复发且代价高，收集为定向润色信号注入 autoPolish 与文笔门。
      structureFixes = [];
      try {
        // 5a) 对白/叙述结构失衡：全章零对话（流水账旁白体）或全章 85%+ 对话（剧本化）
        structureFixes.push(...scanStructureBalance(full));

        // 5a2) 硬逻辑矛盾（免费正则，模型无关）：
        //      时间倒置（先"凌晨三点"后"凌晨两点四十七分"且无回溯标记）→ 触发重生成；
        //      称呼身份矛盾（"老爹"被介绍成"爷爷的老伙计"）、场景元素错位（殡仪馆出现监护仪）→ 定向润色。
        for (const timelineIssue of scanTimelineContradiction(full)) {
          problems.push({ desc: `时间线硬伤：${timelineIssue}` });
        }
        structureFixes.push(...scanKinshipTitleConflict(full));
        structureFixes.push(...scanSceneElementMismatch(full));

        // 5b) 跨章口癖固化：最近 3 章正文与本章比对，找出"每章同款"的固化短语
        const priorRows = db.prepare(
          "SELECT content FROM chapters WHERE novel_id = ? AND chapter_index >= ? AND chapter_index < ? AND content != '' ORDER BY chapter_index DESC LIMIT 3"
        ).all(novel.id, Math.max(1, idx - 3), idx);
        if (priorRows.length) {
          const repeats = scanCrossChapterRepeats(full, priorRows.map((r) => r.content));
          if (repeats.length) {
            send({ type: 'status', message: `发现 ${repeats.length} 处跨章固化写法（${repeats.map((r) => r.slice(0, 8)).join('、')}…），将在润色中定向改写` });
            structureFixes.push(...repeats);
          }
          // 5c) 跨章自我复述：与最近一章全文做最长公共子串比对（滚动数组 DP，毫秒级）。
          //     正常承接只重叠结尾一两句；≥120 连续字判定大段复述须重写；80-119 字注入润色提示。
          if (prevChapter && String(prevChapter.content).length > 500) {
            const dupLen = longestDuplicateLength(full, String(prevChapter.content));
            if (dupLen >= 120) {
              problems.push({ desc: `本章存在 ≥${dupLen} 字的大段连续重复上一章内容，属于剧情复述而非推进。必须删掉复述段落，从上一章结尾之后的新内容写起` });
            } else if (dupLen >= 80) {
              structureFixes.push(`本章有约 ${dupLen} 字内容与上一章高度雷同（重复叙述/换皮描写），请把这些段落的表达彻底改写或压缩为一句话带过`);
            }
          }
        }
      } catch { /* 结构检测失败不阻塞 */ }

      lastProblems = problems;
      if (problems.length === 0) break; // 全部通过

      if (attempt < MAX_AUTO_REGENERATE) continue; // 整章重新生成

      // 已达重试上限：保存当前版本并提示，允许用户后续再手动修改
      send({ type: 'status', message: `已自动重试 ${MAX_AUTO_REGENERATE} 次仍有 ${problems.length} 处问题，先保存当前版本，可在章节操作中继续修改。` });
    }

    // 标题兜底：正文生成完毕后，若标题仍为空/占位（方案阶段偷懒生成"第N章"），用本章正文拟标题
    if (!title || isPlaceholderTitle(title)) {
      try {
        send({ type: 'status', message: `正在根据本章内容补拟标题…` });
        const headForTitle = full.replace(/^\s*第[一二三四五六七八九十百千\d]+章\s*/, '').trim().slice(0, 1200);
        const tRes3 = await chat({
          config,
          messages: [
            { role: 'system', content: CHAPTER_TITLE_SYSTEM },
            { role: 'user', content: `小说：《${novel.title}》（${novel.genre}）\n\n第 ${idx} 章正文开头：\n${headForTitle}\n\n请根据本章内容拟一个 4-15 字的自然标题，像真人作者随手起的，只输出标题本身。` }
          ],
          maxTokens: 100
        });
        let raw3 = (tRes3.content || '').trim();
        raw3 = raw3.replace(/["'《》「」『』]/g, '').replace(/^第[一二三四五六七八九十百千\d]+章\s*/g, '').replace(/\n+/g, ' ').trim();
        const t3 = raw3.slice(0, 15);
        if (t3 && !isPlaceholderTitle(t3)) title = t3;
      } catch { /* 补拟失败不阻塞，落库用原占位 */ }
    }

    // 自动去除 AI 味（autoPolish 开关）：质量门通过后，若开启则再跑一轮 iteratePolish，
    // 从机制上进一步压低 AI 分，此时只要求不再命中高频词即为收敛（避免与质量门双重过头）
    if (strictMode() && config.autoPolish) {
      try {
        send({ type: 'status', message: `正在按开关自动去除 AI 味…` });
        const iter = await iteratePolish(config, novel, full, {
          onStatus: (m) => send({ type: 'status', message: m }),
          maxRounds: AI_MAX_ROUNDS,
          opts: { knowledgeBlock, skillsBlock, genre: novel.genre, extraIssues: structureFixes }
        });
        if (iter.text && iter.text.trim()) {
          full = iter.text.trim();
          finalDetect = iter.lastDetect;
          finalBlacklist = iter.blacklist;
          finalRounds = iter.rounds;
          lastProblems = iter.blacklist.length ? [{ desc: `去 AI 味后仍命中高频词：${iter.blacklist.join('、')}` }] : [];
          send({ type: 'status', message: `自动去 AI 味完成，最终评分 ${iter.rounds.at(-1)?.score ?? iter.lastDetect.score ?? 0}${lastProblems.length ? '，仍有少量高频词残留' : '，全部达标'}` });
        }
      } catch { /* 自动去 AI 味失败不阻塞，保存质量门通过后的版本 */ }
    }

    // 文笔质量门：文笔总体分 < 6（平淡/对话生硬/句式呆板）时自动触发润色提升，而非仅发提示。
    // 采用"检测→润色→复检"迭代（最多 2 轮），让低分文笔真正被改写到达标，而不是只改一遍就放行。
    // JSON 解析失败或分数缺失时按"需润色"处理（降级兜底），避免文笔门被静默跳过。
    // 放在落库之前运行，润色只改写 full，随后统一落库，避免重复插入。
    if (strictMode()) {
      const wqKnowledgeIds = getNovelKnowledgeIds(novel);
      const wqKnowledgeBlock = formatKnowledgeBlock(wqKnowledgeIds);
      const wqSkillIds = getNovelSkillIds(novel);
      const wqAutoSkills = recommendSkillsForGenre(novel.genre).filter((id) => !wqSkillIds.includes(id));
      const wqSkillsBlock = formatSkillsBlock([...wqSkillIds, ...wqAutoSkills]);
      const wqWeak = [];
      try {
        for (let wqRound = 0; wqRound < 2; wqRound++) {
          let wqScore = null;
          let wqIssues = '';
          try {
            const wqRes = await chat({
              config,
              task: 'quality',
              messages: [
                { role: 'system', content: WRITING_QUALITY_SYSTEM },
                { role: 'user', content: `第${idx}章 标题：${title}\n\n${sampleText(full, 3500)}` }
              ],
              maxTokens: 1500
            });
            const wq = extractJson(wqRes.content);
            wqScore = wq?.overall?.score ?? null;
            wqIssues = (wq?.overall?.weaknesses || []).slice(0, 2).join('、');
            if (wqScore != null) wqWeak[0] = wqIssues;
          } catch { /* 评分失败，按需润色处理 */ }

          // 解析失败或分数缺失 → 视为需润色；分数存在且 ≥6 → 达标
          const needsPolish = wqScore == null || wqScore < 6;
          // 文笔达标但存在结构问题（称呼矛盾/场景错位/口癖固化等）时，仍强制一轮定向润色把问题修掉
          if (!needsPolish && structureFixes.length === 0) break;

          const reason = wqScore == null ? '文笔评分解析异常' : (`文笔 ${wqScore}/10 偏低（${wqIssues || '表达平淡'}）`);
          send({ type: 'status', message: `${reason}，正在自动润色提升…` });
          try {
            const wIter = await iteratePolish(config, novel, full, {
              onStatus: (m) => send({ type: 'status', message: m }),
              maxRounds: 1,
              opts: { knowledgeBlock: wqKnowledgeBlock, skillsBlock: wqSkillsBlock, genre: novel.genre, extraIssues: structureFixes }
            });
            if (wIter.text && wIter.text.trim() && wIter.text.trim().length >= Math.floor(full.length * 0.5)) {
              full = wIter.text.trim();
              if (!wqWeak[0]) wqWeak[0] = wqIssues || '提升表达自然度';
            }
            // 本轮润色已携带全部结构问题；文笔达标纯走结构修复时清空，避免第二轮重复修复
            if (!needsPolish) structureFixes = [];
          } catch { /* 文笔润色失败不阻塞，保留原版 */ }
        }
        if (wqWeak[0]) send({ type: 'status', message: `文笔润色完成（重点改善${wqWeak[0]}）` });
      } catch { /* 文笔检查失败不阻塞 */ }
    }

    // 多模型交叉读者终审：配置了多个不同模型时，用非写作模型的另一家模型以挑剔读者视角
    // 做最后一道试读（复用可读性检测 6 维度）。判 rewrite 时按其意见定向优化一轮。
    // 单模型环境自动跳过，零额外成本；为不同厂商模型的"盲区互查"，进一步压低单一模型风格缺陷。
    if (strictMode()) {
      try {
        const reviewerCfg = pickReviewerConfig(config);
        if (reviewerCfg) {
          send({ type: 'status', message: `交叉读者终审：${reviewerCfg.model || '第二模型'} 正在试读本章…` });
          let rd2 = { average: 0, verdict: 'pass', issues: [] };
          try { rd2 = await runReadability(reviewerCfg, full); } catch { /* 终审失败不阻塞 */ }
          if (rd2.verdict === 'rewrite') {
            const crossIssues = (rd2.issues || []).slice(0, 4)
              .map((i) => `[${i.dimension || '可读性'}] ${i.suggestion || i.problem || ''}`)
              .filter(Boolean);
            if (crossIssues.length) {
              send({ type: 'status', message: '交叉读者发现可读性问题，正在按意见定向优化…' });
              const cIter = await iteratePolish(reviewerCfg, novel, full, {
                onStatus: (m) => send({ type: 'status', message: m }),
                maxRounds: 1,
                opts: { knowledgeBlock, skillsBlock, genre: novel.genre, extraIssues: [...crossIssues, ...structureFixes] }
              });
              if (cIter.text && cIter.text.trim() && cIter.text.trim().length >= Math.floor(full.length * 0.5)) {
                full = cIter.text.trim();
                send({ type: 'status', message: '交叉终审优化完成' });
              }
            }
          }
        }
      } catch { /* 交叉终审整体失败不阻塞 */ }
    }

    // 保存章节（质检通过或达上限后的最终版）
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

    // 记录最终 AI 味检测
    try {
      saveDetection(novel.id, idx, finalRounds.at(-1)?.score ?? finalDetect.score ?? 0, finalDetect.issues, finalBlacklist, 'quality_gate');
      send({ type: 'status', message: `第 ${idx} 章已完成自动检查并保存${lastProblems.length ? `（残留 ${lastProblems.length} 处问题待处理）` : '（全部通过）'}` });
    } catch { /* 记录失败不阻塞 */ }

    // ★ 正文 + 去AI味已完成：立即回完成信号，避免后处理拖慢 SSE（后处理在下方继续后台消化，send 已有连接保护）
    try {
      const doneNovel = getNovel(novel.id);
      doneNovel.chapters = getChapters(novel.id);
      doneNovel.total_words = doneNovel.chapters.reduce((s, c) => s + c.word_count, 0);
      send({ type: 'progress', progress: 100, message: `第 ${idx} 章创作完成` });
      updateJob(job.id, { status: 'done', progress: 100, word_count: (getChapter(novel.id, idx)?.word_count || 0), result_ref: String(idx) });
      end({ type: 'done', data: { novel: doneNovel, chapter: getChapter(novel.id, idx), autoPolished: !!config.autoPolish, foreshadowings: getForeshadowings(novel.id), jobId: job.id } });
    } catch { /* 完成信号发送失败不阻塞后处理 */ }

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
          const rawText = (stRes.content || '').trim();
          // JSON 解析失败或 overview 缺失时，用模型原始输出截断作兜底基准，避免重锚定被静默丢弃
          const newBaseline = (stAnalysis && typeof stAnalysis === 'object')
            ? ((stAnalysis.overview || JSON.stringify(stAnalysis)).trim())
            : (rawText ? rawText.slice(0, 1200) : '');
          if (newBaseline) {
            const samples = (stAnalysis && Array.isArray(stAnalysis.example)) ? JSON.stringify(stAnalysis.example) : '';
            db.prepare("UPDATE novels SET style_baseline = ?, style_samples = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newBaseline, samples, novel.id);
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

    // 剧情一致性校验已在生成循环中前置完成（有问题→整章重生成），此处无需重复修复式校验

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

    // 完成信号已在正文落库+去AI味后提前发送（见上方★），此处仅做记忆后处理收尾
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
      const knowledgeIds = getNovelKnowledgeIds(novel);
      const knowledgeBlock = formatKnowledgeBlock(knowledgeIds);
      const skillIds = getNovelSkillIds(novel);
      const autoSkills = recommendSkillsForGenre(novel.genre).filter((id) => !skillIds.includes(id));
      const skillsBlock = formatSkillsBlock([...skillIds, ...autoSkills]);
      const iter = await iteratePolish(config, novel, chapter.content, {
        onStatus: (m) => send({ type: 'status', message: m }),
        maxRounds: AI_MAX_ROUNDS,
        opts: { knowledgeBlock, skillsBlock, genre: novel.genre }
      });
      if (!iter.text.trim()) return end({ type: 'error', message: 'AI 未返回内容，请重试。' });
      const finalText = cleanAiText(iter.text.trim());
      db.prepare('UPDATE chapters SET content = ?, word_count = ?, status = ? WHERE id = ?')
        .run(finalText, countWords(finalText), 'draft', chapter.id);
      touchNovel(novel.id);
      try {
        await writeChapterTxt(novel, { chapter_index: idx, title: chapter.title, content: finalText });
      } catch { /* 文件写入失败不阻塞 */ }
      const finalScore = iter.rounds.at(-1)?.score ?? 0;
      const passed = finalScore <= aiScorePass() && iter.blacklist.length === 0;
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
      const knowledgeIds = getNovelKnowledgeIds(novel);
      const knowledgeBlock = formatKnowledgeBlock(knowledgeIds);
      const skillIds = getNovelSkillIds(novel);
      const autoSkills = recommendSkillsForGenre(novel.genre).filter((id) => !skillIds.includes(id));
      const skillsBlock = formatSkillsBlock([...skillIds, ...autoSkills]);
      await runLLMStream(config, [
        { role: 'system', content: buildPolishSystem(getStyles(parseStyleIds(novel)), novel.style_baseline, novel.style_samples, parseStylePresets(novel), { knowledgeBlock, skillsBlock, genre: novel.genre }) },
        { role: 'user', content: `以下是一章小说原稿。请按人类写作风格整体改写，彻底去除一切 AI 痕迹，保留剧情与人设。\n\n原稿：\n${chapter.content}` }
      ], {
        ctrl,
        task: 'writing',
        maxTokens: Math.max(4000, Math.min(32000, (chapter.content.length + 2000) * 2)),
        onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
      });
      if (!full.trim()) return end({ type: 'error', message: 'AI 未返回内容，请重试。' });
      full = cleanAiText(full.trim());
      db.prepare('UPDATE chapters SET content = ?, word_count = ?, status = ? WHERE id = ?')
        .run(full, countWords(full), 'draft', chapter.id);
      touchNovel(novel.id);
      try {
        await writeChapterTxt(novel, { chapter_index: idx, title: chapter.title, content: full });
      } catch { /* 文件写入失败不阻塞 */ }
      let detect = { score: 0, issues: [] };
      try { detect = await runDetection(config, full); } catch { /* 检测失败不阻塞 */ }
      const bl = blacklistFlagWords(scanAiPatterns(full), full.length);
      saveDetection(novel.id, idx, detect.score, detect.issues, bl, 'polish');
      send({ type: 'progress', progress: 100, message: '润色完成' });
      end({ type: 'done', data: { chapter: getChapter(novel.id, idx), detect, rounds: [], passed: detect.score <= aiScorePass() } });
    }
  } catch (e) {
    if (e.name === 'AbortError') return end({ type: 'aborted', message: '已停止润色' });
    return end({ type: 'error', message: e.message });
  }
});

// ---------- 按作者要求修改章节 ----------
router.post('/novels/:id/chapters/:idx/revise', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const { config, error } = requireLLM();
  if (error) return res.status(400).json({ error: error.message });

  const idx = Number(req.params.idx);
  const chapter = getChapter(novel.id, idx);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  if (!chapter.content) return res.status(400).json({ error: '本章还没有内容可修改' });

  const instructions = String(req.body?.instructions || '').trim();
  if (!instructions) return res.status(400).json({ error: '请填写修改要求' });

  const { ctrl, send, end } = startSSE(req, res);
  send({ type: 'status', message: `正在按您的要求修改「${chapter.title}」…` });
  send({ type: 'progress', progress: 5, message: `正在按您的要求修改「${chapter.title}」…` });

  backupChapter(novel.id, idx, '按作者要求修改');

  try {
    let full = '';
    const knowledgeIds = getNovelKnowledgeIds(novel);
    const knowledgeBlock = formatKnowledgeBlock(knowledgeIds);
    const skillIds = getNovelSkillIds(novel);
    const autoSkills = recommendSkillsForGenre(novel.genre).filter((id) => !skillIds.includes(id));
    const skillsBlock = formatSkillsBlock([...skillIds, ...autoSkills]);
    await runLLMStream(config, [
      { role: 'system', content: buildReviseSystem(getStyles(parseStyleIds(novel)), novel.style_baseline, novel.style_samples, parseStylePresets(novel), { knowledgeBlock, skillsBlock, genre: novel.genre }) },
      { role: 'user', content: `以下是第 ${idx} 章《${chapter.title}》原稿与作者的修改要求。请只按修改要求改写，未被要求的段落保持原样，输出改写后的完整正文。

【作者的修改要求】
${instructions}

【原稿】
${chapter.content}` }
    ], {
      ctrl,
      task: 'writing',
      maxTokens: Math.max(4000, Math.min(32000, (chapter.content.length + 3000) * 2)),
      onDelta: (d) => { full += d; send({ type: 'delta', content: d }); }
    });

    if (!full.trim()) return end({ type: 'error', message: 'AI 未返回内容，请重试。' });

    full = cleanAiText(full.trim());
    db.prepare('UPDATE chapters SET content = ?, word_count = ?, status = ? WHERE id = ?')
      .run(full, countWords(full), 'draft', chapter.id);
    touchNovel(novel.id);
    try {
      await writeChapterTxt(novel, { chapter_index: idx, title: chapter.title, content: full });
    } catch { /* 文件写入失败不阻塞 */ }

    // 改写后附带一次 AI 味检测报告（仅提示，不阻塞）
    let detect = { score: 0, issues: [] };
    let blacklist = [];
    try {
      const det = await runDetection(config, full);
      detect = det;
      const hits = scanAiPatterns(full);
      blacklist = blacklistFlagWords(hits, full.length);
      const total = Math.min(100, det.score + blacklistPenalty(hits, full.length));
      saveDetection(novel.id, idx, total, det.issues, blacklist, 'revise');
      send({ type: 'status', message: `修改完成，AI 味检测 ${total} 分${total > aiScorePass() ? '（略有残留，可再次润色）' : '（达标）'}` });
    } catch { /* 检测失败不阻塞 */ }

    send({ type: 'progress', progress: 100, message: '修改完成' });
    end({ type: 'done', data: { chapter: getChapter(novel.id, idx), detect, passed: detect.score <= aiScorePass() } });
  } catch (e) {
    if (e.name === 'AbortError') return end({ type: 'aborted', message: '已停止修改' });
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
    const bl = blacklistFlagWords(hits, chapter.content.length);
    const total = Math.min(100, det.score + blacklistPenalty(hits, chapter.content.length));
    saveDetection(novel.id, idx, total, det.issues, bl, 'detect');
    res.json({
      ok: true,
      chapter_index: idx,
      score: total,
      detectScore: det.score,
      blacklist: bl,
      issues: det.issues,
      passed: total <= aiScorePass() && bl.length === 0
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
  send({ type: 'progress', progress: 2, message: '正在分块处理全文…' });

  const text = String(sourceText);

  // 分块处理：将全文按固定大小分块，保证不遗漏任何内容
  // 最多 50 块，每块至少 50K 字，超大文本自动增大块大小
  const maxChunks = 50;
  const minChunkSize = 50000;
  const chunkSize = Math.max(minChunkSize, Math.ceil(text.length / maxChunks));
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }

  send({ type: 'progress', progress: 5, message: `正在用 AI 逐块分析写作风格（全文 ${text.length} 字，${chunks.length} 块，每块约 ${chunkSize} 字，已开启限速保护避免触发 API 限流）…` });

  try {
    const partialResults = await analyzeChunksRateLimited({
      config,
      ctrl,
      chunks,
      sse: { send },
      buildUserMessage: (chunk, chunkIndex) => `以下是小说《${String(name).trim()}》的第 ${chunkIndex + 1} 段文本：\n\n${chunk}`
    });

    if (!partialResults.length) {
      return end({ type: 'error', message: '所有块分析均失败，请稍后重试或更换模型。' });
    }

    send({ type: 'progress', progress: 78, message: `分块分析完成（${partialResults.length}/${chunks.length} 块成功），正在综合结果…` });

    const r = await synthesizeWithRateLimit({
      config,
      ctrl,
      system: STYLE_ANALYZE_SYSTEM,
      user: `以下是对同一部小说《${String(name).trim()}》不同段落的分析结果，请综合为一份统一的风格分析 JSON：\n\n${JSON.stringify(partialResults, null, 2)}`,
      sse: { send }
    });

    const rawAnalysis = extractJson(r?.content || '');
    if (!rawAnalysis) {
      return end({ type: 'error', message: '风格分析综合失败：AI 返回内容无法解析，请重试或更换模型。' });
    }

    send({ type: 'progress', progress: 100, message: '分析完成！' });

    // 从分析结果中提取 example 句段作为 style_samples 独立存储
    const examples = Array.isArray(rawAnalysis.example) ? rawAnalysis.example.join('\n') : '';
    const analysis = { ...rawAnalysis };
    delete analysis.example;

    const sampleText = text.slice(0, 20000);
    const info = db.prepare('INSERT INTO styles (name, notes, analysis, source_text, style_samples) VALUES (?,?,?,?,?)')
      .run(String(name).trim(), notes || '', JSON.stringify(analysis), sampleText, examples);
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

// ---------- 技能库 ----------
router.get('/skills', (req, res) => {
  res.json(db.prepare('SELECT * FROM skills ORDER BY updated_at DESC').all());
});

router.get('/skills/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '技能不存在' });
  res.json(s);
});

router.post('/skills', (req, res) => {
  const { name, type, description, content, tags } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写技能名称' });
  if (!content || !String(content).trim()) return res.status(400).json({ error: '请填写技能内容' });
  const info = db.prepare(
    'INSERT INTO skills (name, type, description, content, tags) VALUES (?,?,?,?,?)'
  ).run(String(name).trim(), type || 'technique', description || '', content, tags || '');
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(info.lastInsertRowid);
  res.json(skill);
});

router.put('/skills/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '技能不存在' });
  const sets = [];
  const vals = [];
  for (const f of ['name', 'type', 'description', 'content', 'tags']) {
    if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[f]); }
  }
  if (sets.length) {
    vals.push(s.id);
    db.prepare(`UPDATE skills SET ${sets.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`).run(...vals);
  }
  res.json(db.prepare('SELECT * FROM skills WHERE id = ?').get(s.id));
});

router.delete('/skills/:id', (req, res) => {
  db.prepare('DELETE FROM skills WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// 批量导入技能（SKILL.md 格式：YAML frontmatter 的 name/description + 正文）
router.post('/skills/import', (req, res) => {
  const files = req.body?.files;
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: '请提供要导入的技能文件' });

  const results = [];
  const insertSkill = db.prepare(
    'INSERT INTO skills (name, type, description, content, tags) VALUES (?,?,?,?,?)'
  );

  for (const f of files) {
    const parsed = parseSkillFile({ name: f?.name, content: f?.content });
    if (parsed.error) { results.push({ file: f?.name, ok: false, error: parsed.error }); continue; }

    // 同名不重复导入
    const existing = db.prepare('SELECT id FROM skills WHERE name = ?').get(parsed.name);
    if (existing) {
      db.prepare(`UPDATE skills SET description = ?, content = ?, tags = ?, type = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(parsed.description, parsed.content, parsed.tags, 'technique', existing.id);
      results.push({ file: f?.name, ok: true, name: parsed.name, updated: true });
      continue;
    }

    const info = insertSkill.run(parsed.name, 'technique', parsed.description, parsed.content, parsed.tags);
    results.push({ file: f?.name, ok: true, name: parsed.name, id: info.lastInsertRowid, updated: false });
  }

  res.json({ results, ok: results.length, fail: results.filter((r) => !r.ok).length });
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
    ai_score_pass: Number(getSetting('ai_score_pass', String(AI_SCORE_PASS_DEFAULT))),
    managerSendBy: getSetting('manager_send_by', 'enter')
  });
});

router.put('/settings', async (req, res) => {
  const { llm_config, novels_root, migrate_novels, strict_ai_mode, ai_score_pass, managerSendBy } = req.body || {};
  if (llm_config && typeof llm_config === 'object') {
    setSetting('llm_config', JSON.stringify(normalizeLLMConfig(llm_config)));
  }
  if (strict_ai_mode !== undefined) {
    setSetting('strict_ai_mode', strict_ai_mode ? '1' : '0');
  }
  if (ai_score_pass !== undefined) {
    const n = Number(ai_score_pass);
    setSetting('ai_score_pass', String(Number.isFinite(n) && n > 0 ? Math.round(n) : AI_SCORE_PASS_DEFAULT));
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
  res.json({ ok: true, novels_root: getNovelsRoot(), strict_ai_mode: getSetting('strict_ai_mode', '1'), ai_score_pass: Number(getSetting('ai_score_pass', String(AI_SCORE_PASS_DEFAULT))), managerSendBy: getSetting('manager_send_by', 'enter') });
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
  presets.push({ id, name: String(name), llm_config: normalizeLLMConfig(llm_config), created_at: new Date().toISOString() });
  setLLMPresets(presets);
  res.json({ ok: true, preset: { id, name: String(name), llm_config: normalizeLLMConfig(llm_config) } });
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
  const cfg = normalizeLLMConfig(preset.llm_config);
  setSetting('llm_config', JSON.stringify(cfg));
  res.json({ ok: true, llm_config: cfg });
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
// 生成资源观测汇总：续写轮数分布 + AI 检测分数分布，供调整阈值/观测成本
router.get('/stats/generation', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(rounds),0) rounds, COALESCE(ROUND(AVG(rounds),2),0) avg_rounds, COALESCE(SUM(duration_ms),0) duration_ms FROM generation_stats').get();
    const byReason = db.prepare('SELECT pipe_reason, COUNT(*) n FROM generation_stats GROUP BY pipe_reason').all();
    const roundDist = db.prepare('SELECT rounds, COUNT(*) n FROM generation_stats GROUP BY rounds ORDER BY rounds').all();
    const recent = db.prepare('SELECT * FROM generation_stats ORDER BY id DESC LIMIT 10').all();
    res.json({ total, byReason, roundDist, recent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI 味检测分数分布：观察达标率，判断 aiScorePass() 阈值是否合理
router.get('/stats/ai-detect', (req, res) => {
  try {
    const all = db.prepare('SELECT score, source FROM ai_detections').all();
    if (!all.length) return res.json({ total: 0, passRate: null, buckets: [], bySource: [] });
    const pass = all.filter((d) => d.score <= 20).length;
    const buckets = [
      { label: '0-10', n: 0 }, { label: '11-20', n: 0 }, { label: '21-30', n: 0 },
      { label: '31-40', n: 0 }, { label: '41-60', n: 0 }, { label: '61+', n: 0 }
    ];
    for (const d of all) {
      const s = Number(d.score) || 0;
      if (s <= 10) buckets[0].n++;
      else if (s <= 20) buckets[1].n++;
      else if (s <= 30) buckets[2].n++;
      else if (s <= 40) buckets[3].n++;
      else if (s <= 60) buckets[4].n++;
      else buckets[5].n++;
    }
    const bySource = db.prepare('SELECT source, COUNT(*) n, ROUND(AVG(score),1) avg_score FROM ai_detections GROUP BY source').all();
    res.json({
      total: all.length,
      passRate: Math.round((pass / all.length) * 1000) / 10,
      threshold: 20,
      buckets,
      bySource
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/novels/:id/job', (req, res) => {
  const job = getActiveJobByNovel(req.params.id);
  res.json({ job });
});

router.get('/jobs/active', (req, res) => {
  res.json({ jobs: listActiveJobs() });
});

// 停止/清理任务：把该小说当前 running 的 job 标记为 aborted。
// 用于前端「停止生成」以及清理服务器重启后残留的僵尸任务。
router.post('/novels/:id/job/abort', (req, res) => {
  const job = getActiveJobByNovel(req.params.id);
  if (!job) return res.json({ ok: true, job: null });
  const updated = abortJob(job.id);
  res.json({ ok: true, job: updated });
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
  // 当前打开的小说上下文：让 AI 不需要反问"是哪本书"
  let currentNovelText = '';
  if (novelId != null) {
    const n = getNovel(novelId);
    if (n) {
      const chs = getChapters(novelId);
      const done = (chs || []).filter((c) => c.word_count).length;
      currentNovelText = `\n\n【当前打开的小说】《${n.title || '未命名'}》：
- 小说 ID：${n.id}（工具调用 get_novel_progress / update_outline / update_character / request_revise / request_generate_chapter 时，涉及这本书必须使用 novel_id=${n.id}）
- 类型：${n.genre || '未设置'}　状态：${n.status || '未开始'}
- 已写 ${done}/${n.target_chapters || 0} 章（共 ${n.target_chapters || '?'} 章目标）
- 打开的小说只有一本时，作者说"这本书"就是指它，直接回答或执行，不要反问是哪本书。`;
    }
  }
  const mem = novelId != null
    ? db.prepare('SELECT content FROM manager_memory WHERE (novel_id = ? OR novel_id IS NULL) ORDER BY id DESC LIMIT 12').all(novelId)
    : db.prepare('SELECT content FROM manager_memory WHERE novel_id IS NULL ORDER BY id DESC LIMIT 12').all();
  const memText = mem.length
    ? '\n\n【长期记忆（跨对话保留）】\n' + mem.map((m) => '- ' + String(m.content).replace(/\s+/g, ' ')).join('\n')
    : '';
  return `你是 AI 小说工坊的"总管 AI"，对所有小说创作有最高权限。

你可调用工具查看任意小说进度、修改大纲/角色、引入共享角色、触发修订或章节生成、联网搜索资料。你的记忆持久在后端，与所用大模型解耦——换模型不丢。

${SEARCH_SYSTEM_PROMPT}

${activeText}${currentNovelText}${memText}

行为准则：
1. 读类工具（含联网搜索）可直接用；写类工具必须由前端弹出授权条由作者确认后才会真正执行——你执行被拒绝时，体面地告知作者"未被授权"。
2. 沟通风格如真人作家总管，简洁自然，不堆术语。
3. 涉及【当前打开的小说】时，直接根据上面的 ID 与信息回答或调用工具，不要反问"是哪本书"。只有作者明确提到"另一本/别的书"且你知道书名但不确定 ID 时，才调用 get_novel_progress 确认。
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

      const executedResults = [];
      for (const tc of r1.toolCalls) {
        const reg = toolRegistry[tc.name];
        if (!reg) { pending.push({ tool_call_id: tc.id, name: tc.name, args: tc.args, error: '未知工具' }); continue; }
        let parsed = {};
        try { parsed = JSON.parse(tc.args || '{}'); } catch { /* ignore */ }
        if (!reg.needsAuth) {
          const out = await reg.executor(parsed).catch((e) => ({ error: e.message }));
          db.prepare('INSERT INTO manager_messages (novel_id, role, content, tool_name, tool_call_id) VALUES (?,?,?,?,?)')
            .run(parsed.novel_id || novelId, 'tool', JSON.stringify(out), tc.name, tc.id);
          executedResults.push({ name: tc.name, args: parsed, result: out });
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
      // 把刚执行的读类工具结果喂给模型，让它能基于真实数据组织回答（避免模型编造进度）
      if (executedResults.length) {
        const toolSummary = executedResults.map((e) => {
          const pretty = typeof e.result === 'string' ? e.result : JSON.stringify(e.result);
          return `【${e.name}】${pretty}`;
        }).join('\n\n');
        msgs2.push({ role: 'user', content: `以下是刚才工具调用返回的真实结果，请以此为准回答作者，不要编造数据：\n\n${toolSummary}` });
      }
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

    // 分块用于 RAG 样本存储（取前 30 段 4000 字块）
    const sampleChunks = [];
    for (let i = 0; i < text.length && sampleChunks.length < 30; i += 4000) {
      sampleChunks.push(text.slice(i, i + 4000));
    }
    saveSamples(corpusId, sampleChunks);

    // 分块处理：将全文按固定大小分块，保证不遗漏任何内容
    // 最多 50 块，每块至少 50K 字，超大文本自动增大块大小
    const maxChunks = 50;
    const minChunkSize = 50000;
    const chunkSize = Math.max(minChunkSize, Math.ceil(text.length / maxChunks));
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }

    updateCorpusStatus(corpusId, 'learning', { totalWords: text.length });
    send({ type: 'status', message: `已分块 ${sampleChunks.length} 段，全文 ${text.length} 字，分成 ${chunks.length} 块（每块约 ${chunkSize} 字），自动限速分析，避免触发 API 限流。` });

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

    send({ type: 'progress', progress: 5, message: `正在用 AI 逐块分析（全文 ${text.length} 字，${chunks.length} 块，已开启限速保护避免触发 API 限流）…` });

    const partialResults = await analyzeChunksRateLimited({
      config,
      ctrl,
      chunks,
      sse: { send },
      buildUserMessage: (chunk, chunkIndex) => `以下是${genre}题材小说《${title || '未命名'}》的第 ${chunkIndex + 1} 段文本：\n\n${chunk}`
    });

    if (!partialResults.length) {
      updateCorpusStatus(corpusId, 'failed');
      return end({ type: 'error', message: '所有段落分析均失败，请稍后重试或检查模型状态。' });
    }

    send({ type: 'progress', progress: 75, message: '正在综合各段分析结果…' });

    const r = await synthesizeWithRateLimit({
      config,
      ctrl,
      system: FINAL_SYNTHESIS_SYSTEM,
      user: `以下是对同一部${genre}题材小说《${title || '未命名'}》不同段落的分析结果，请综合为一份完整报告：\n\n${JSON.stringify(partialResults, null, 2)}`,
      sse: { send }
    });

    const analysis = r?.content || '';
    const parsed = extractJson(analysis);
    if (!parsed) {
      updateCorpusStatus(corpusId, 'failed');
      return end({ type: 'error', message: '合成分析结果无法解析，请重试或更换模型。' });
    }

    send({ type: 'progress', progress: 100, message: '学习完成！' });
    updateCorpusStatus(corpusId, 'learned', { analysis: JSON.stringify(parsed, null, 2), learnedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    send({ type: 'status', message: '学习完成！该知识库已可在新建小说时勾选使用。' });

    const corpus = getCorpus(corpusId);
    return end({ type: 'done', data: { corpus, analysis: parsed } });
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

// 同类小说参考搜索：自动搜索网络热门同类小说供创作参考
function formatSearchReference(results, genre) {
  if (!results || !results.length) return '';
  const lines = [`【同类小说参考（${genre}题材热门作品）——仅供节奏与结构参考，属其他作品】`];
  for (const r of results) {
    if (r.title) lines.push(`- 《${r.title}》（可在网上搜索该书名了解其节奏与题材热度，正文中严禁出现该书任何人物/情节）`);
  }
  lines.push('\n参考以上作品的节奏、冲突设置和人物关系手法。这些是其他作品，书中的人物、地名、组织、情节一律不得出现在本书正文中。');
  return lines.join('\n');
}

router.post('/novels/:id/reference-search', async (req, res) => {
  const novel = getNovel(req.params.id);
  if (!novel) return res.status(404).json({ error: '小说不存在' });
  const genre = novel.genre || '';
  const title = novel.title || '';
  const keywords = `${genre}小说 热门推荐 排行榜 ${title}`;
  try {
    const data = await webSearch(keywords, {
      engine: getSetting('search_engine', 'duckduckgo'),
      searxUrl: getSetting('searx_url', ''),
      bingApiKey: getSetting('bing_api_key', ''),
      bingEndpoint: getSetting('bing_endpoint', ''),
      count: 5,
      fetchContent: true
    });
    const results = (data.results || []).slice(0, 5).map((r) => ({
      title: r.title,
      snippet: r.snippet || r.content?.slice(0, 200) || '',
      url: r.url
    }));
    res.json({ ok: true, results, formatted: formatSearchReference(results, genre) });
  } catch (e) {
    res.json({ ok: false, error: e.message, results: [], formatted: '' });
  }
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
