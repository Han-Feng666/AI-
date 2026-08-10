/**
 * 自主后台学习系统 — 自动在空闲时跑分析任务
 * - 定时任务队列
 * - Ollama 空闲检测
 * - 自动跑章节摘要/事实抽取/风格分析
 */
import { db, getSetting, setSetting } from './db.js';
import { getLocalModelStatus, ollamaChat } from './local_llm.js';
import { offlineAnalyzeStyle } from './offline_learn.js';

// ===== 任务队列 =====

const _queue = [];
let _running = false;
let _currentTask = null;
let _intervalTimer = null;

const TASK_TYPES = {
  SUMMARIZE_CHAPTER: 'summarize_chapter',
  EXTRACT_FACTS: 'extract_facts',
  ANALYZE_STYLE: 'analyze_style',
  LEARN_CORPUS: 'learn_corpus',
  EXTRACT_CHARACTERS: 'extract_characters',
};

function enqueueTask(task) {
  const fullTask = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    status: 'pending',
    progress: 0,
    ...task,
  };
  _queue.push(fullTask);
  return fullTask.id;
}

function getQueueStatus() {
  return {
    queue: _queue.map((t) => ({
      id: t.id,
      type: t.type,
      novelId: t.novelId,
      status: t.status,
      progress: t.progress,
      createdAt: new Date(t.createdAt).toISOString(),
    })),
    current: _currentTask ? {
      id: _currentTask.id,
      type: _currentTask.type,
      novelId: _currentTask.novelId,
      progress: _currentTask.progress,
    } : null,
    running: _running,
    queueLength: _queue.length,
  };
}

// ===== Ollama 空闲检测 =====

let _lastOllamaCheck = 0;
let _ollamaIdle = true;

async function checkOllamaIdle() {
  const now = Date.now();
  // 最多每 30 秒检测一次
  if (now - _lastOllamaCheck < 30000) return _ollamaIdle;
  _lastOllamaCheck = now;

  try {
    const status = await getLocalModelStatus();
    if (!status.ollama.available) {
      _ollamaIdle = false;
      return false;
    }
    // 简单判断：如果当前没有正在运行的任务，就认为 Ollama 空闲
    _ollamaIdle = !_running;
    return _ollamaIdle;
  } catch {
    _ollamaIdle = false;
    return false;
  }
}

// ===== 任务执行器 =====

async function executeTask(task) {
  const status = await getLocalModelStatus();
  const useOllama = status.activeLayer === 'ollama';
  const model = status.ollama.selectedModel || status.ollama.models[0];

  switch (task.type) {
    case TASK_TYPES.SUMMARIZE_CHAPTER:
      return await runSummarizeChapter(task, useOllama, status.ollama.url, model);
    case TASK_TYPES.EXTRACT_FACTS:
      return await runExtractFacts(task, useOllama, status.ollama.url, model);
    case TASK_TYPES.ANALYZE_STYLE:
      return await runAnalyzeStyle(task, useOllama, status.ollama.url, model);
    case TASK_TYPES.LEARN_CORPUS:
      return await runLearnCorpus(task, useOllama, status.ollama.url, model);
    case TASK_TYPES.EXTRACT_CHARACTERS:
      return await runExtractCharacters(task, useOllama, status.ollama.url, model);
    default:
      throw new Error(`Unknown task type: ${task.type}`);
  }
}

// ===== 具体任务实现 =====

async function runSummarizeChapter(task, useOllama, ollamaUrl, model) {
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(task.chapterId);
  if (!chapter) throw new Error('章节不存在');

  if (useOllama && model) {
    const messages = [
      { role: 'system', content: '你是一个小说编辑助手。请用 200 字以内总结这一章的核心事件、角色行动和剧情推进。' },
      { role: 'user', content: `第${chapter.chapter_index}章 ${chapter.title}\n\n${chapter.content.slice(0, 8000)}` }
    ];
    const result = await ollamaChat({ url: ollamaUrl, model, messages, temperature: 0.3 });
    // 存入摘要表（level=0 单章摘要，与 P0 分层摘要树共用结构）
    db.prepare(`INSERT INTO chapter_summaries (novel_id, chapter_index, level, start_chapter, end_chapter, summary)
                VALUES (?, ?, 0, ?, ?, ?)
                ON CONFLICT(novel_id, level, start_chapter) DO UPDATE SET summary = excluded.summary`)
      .run(task.novelId, chapter.chapter_index, chapter.chapter_index, chapter.chapter_index, result.content);
    return { summary: result.content };
  }
  // 离线模式：用统计摘要
  const sentences = chapter.content.split(/[。！？\n]+/).filter((s) => s.trim().length > 5);
  const summary = `第${chapter.chapter_index}章摘要（离线模式）：\n本章共${chapter.content.length}字，${sentences.length}个句子。首句：${sentences[0]?.slice(0, 50) || ''}。末句：${sentences[sentences.length - 1]?.slice(0, 50) || ''}。`;
  db.prepare(`INSERT INTO chapter_summaries (novel_id, chapter_index, level, start_chapter, end_chapter, summary)
              VALUES (?, ?, 0, ?, ?, ?)
              ON CONFLICT(novel_id, level, start_chapter) DO UPDATE SET summary = excluded.summary`)
    .run(task.novelId, chapter.chapter_index, chapter.chapter_index, chapter.chapter_index, summary);
  return { summary };
}

async function runExtractFacts(task, useOllama, ollamaUrl, model) {
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(task.chapterId);
  if (!chapter) throw new Error('章节不存在');

  if (useOllama && model) {
    const messages = [
      { role: 'system', content: '你是一个小说编辑助手。请提取本章中的关键事实（角色行为、关系变化、地点变化、重要物品等），每行一条，格式：- 事实描述' },
      { role: 'user', content: `第${chapter.chapter_index}章\n\n${chapter.content.slice(0, 8000)}` }
    ];
    const result = await ollamaChat({ url: ollamaUrl, model, messages, temperature: 0.2 });
    const facts = result.content.split('\n').filter((l) => l.trim().startsWith('-')).map((l) => l.trim().slice(2).trim());
    for (const fact of facts) {
      db.prepare(`INSERT INTO novel_facts (novel_id, subject_type, subject_name, fact_key, fact_value, chapter_index)
                  VALUES (?, 'auto_learn', ?, ?, ?, ?)`)
        .run(task.novelId, `第${chapter.chapter_index}章`, `fact_${Date.now()}_${Math.floor(Math.random() * 1000)}`, fact, chapter.chapter_index);
    }
    return { facts: facts.length };
  }
  // 离线模式：跳过
  return { facts: 0, note: '离线模式跳过事实抽取，连接 Ollama 后可自动执行' };
}

async function runAnalyzeStyle(task, useOllama, ollamaUrl, model) {
  const chapters = db.prepare('SELECT content FROM chapters WHERE novel_id = ? ORDER BY chapter_index LIMIT 5').all(task.novelId);
  if (!chapters.length) throw new Error('小说没有章节内容');

  const fullText = chapters.map((c) => c.content).join('\n').slice(0, 50000);

  if (useOllama && model) {
    const messages = [
      { role: 'system', content: '你是文笔分析专家。请分析以下文本的文风特征，输出 JSON：{"writing_style":"...","plot_patterns":"...","logic_rules":"...","worldview":"...","character_craft":"...","repliclicable_techniques":"..."}' },
      { role: 'user', content: fullText }
    ];
    const result = await ollamaChat({ url: ollamaUrl, model, messages, temperature: 0.3 });
    try {
      const json = JSON.parse(result.content.match(/\{[\s\S]*\}/)?.[0] || '{}');
      db.prepare("UPDATE novels SET style_baseline = ? WHERE id = ?").run(JSON.stringify(json), task.novelId);
      return { analysis: json };
    } catch {
      return { analysis: result.content, note: '解析失败，已存储原始结果' };
    }
  }
  // 离线模式：用统计引擎
  const report = offlineAnalyzeStyle(fullText);
  db.prepare("UPDATE novels SET style_baseline = ? WHERE id = ?").run(JSON.stringify(report), task.novelId);
  return { analysis: report };
}

async function runLearnCorpus(task, useOllama, ollamaUrl, model) {
  const corpus = db.prepare('SELECT * FROM knowledge_corpora WHERE id = ?').get(task.corpusId);
  if (!corpus) throw new Error('知识库不存在');
  const samples = db.prepare('SELECT text FROM knowledge_samples WHERE corpus_id = ? ORDER BY chunk_index').all(task.corpusId);
  if (!samples.length) throw new Error('知识库没有文本样本');

  const fullText = samples.map((s) => s.text).join('\n').slice(0, 100000);

  if (useOllama && model) {
    const messages = [
      { role: 'system', content: '你是文笔学习专家。请分析这段小说文本的6个维度：1.文笔风格 2.剧情套路 3.逻辑规律 4.世界观构建 5.人物塑造 6.可复用技法。输出 JSON 格式。' },
      { role: 'user', content: fullText }
    ];
    const result = await ollamaChat({ url: ollamaUrl, model, messages, temperature: 0.3 });
    try {
      const json = JSON.parse(result.content.match(/\{[\s\S]*\}/)?.[0] || '{}');
      db.prepare("UPDATE knowledge_corpora SET status = 'learned', analysis = ?, learned_at = datetime('now','localtime') WHERE id = ?")
        .run(JSON.stringify(json, null, 2), task.corpusId);
      return { analysis: json };
    } catch {
      db.prepare("UPDATE knowledge_corpora SET status = 'learned', analysis = ?, learned_at = datetime('now','localtime') WHERE id = ?")
        .run(result.content, task.corpusId);
      return { analysis: result.content };
    }
  }
  // 离线模式：用统计引擎
  const report = offlineAnalyzeStyle(fullText);
  db.prepare("UPDATE knowledge_corpora SET status = 'learned', analysis = ?, learned_at = datetime('now','localtime') WHERE id = ?")
    .run(JSON.stringify(report, null, 2), task.corpusId);
  return { analysis: report };
}

async function runExtractCharacters(task, useOllama, ollamaUrl, model) {
  const chapter = db.prepare('SELECT * FROM chapters WHERE id = ?').get(task.chapterId);
  if (!chapter) throw new Error('章节不存在');

  if (useOllama && model) {
    const messages = [
      { role: 'system', content: '你是角色分析专家。请提取本章中出现的角色，输出 JSON 数组：[{"name":"角色名","role_type":"主角|配角|反派","actions":"本章行为","personality":"性格特征"}]' },
      { role: 'user', content: `第${chapter.chapter_index}章\n\n${chapter.content.slice(0, 8000)}` }
    ];
    const result = await ollamaChat({ url: ollamaUrl, model, messages, temperature: 0.2 });
    try {
      const chars = JSON.parse(result.content.match(/\[[\s\S]*\]/)?.[0] || '[]');
      for (const c of chars) {
        const existing = db.prepare('SELECT id FROM characters WHERE novel_id = ? AND name = ?').get(task.novelId, c.name);
        if (!existing) {
          db.prepare("INSERT INTO characters (novel_id, name, role_type, personality, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))")
            .run(task.novelId, c.name, c.role_type || '配角', c.personality || '');
        }
      }
      return { characters: chars.length };
    } catch {
      return { characters: 0, note: '解析失败' };
    }
  }
  return { characters: 0, note: '离线模式跳过角色提取' };
}

// ===== 主循环 =====

async function processNextTask() {
  if (_running) return;
  const task = _queue.find((t) => t.status === 'pending');
  if (!task) return;

  _running = true;
  _currentTask = task;
  task.status = 'running';
  task.progress = 10;

  try {
    task.progress = 30;
    const result = await executeTask(task);
    task.progress = 100;
    task.status = 'completed';
    task.result = result;
  } catch (e) {
    task.status = 'failed';
    task.error = e.message;
  } finally {
    _running = false;
    _currentTask = null;
  }

  // 清理已完成的任务（保留最近 20 条）
  const completed = _queue.filter((t) => t.status === 'completed' || t.status === 'failed');
  if (completed.length > 20) {
    const toRemove = completed.slice(0, completed.length - 20);
    for (const t of toRemove) {
      const idx = _queue.indexOf(t);
      if (idx >= 0) _queue.splice(idx, 1);
    }
  }
}

function startAutoLearnLoop() {
  if (_intervalTimer) return;
  // 每 60 秒检查一次队列
  _intervalTimer = setInterval(async () => {
    await processNextTask();
  }, 60000);
  setSetting('auto_learn_enabled', '1');
}

function stopAutoLearnLoop() {
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
  setSetting('auto_learn_enabled', '0');
}

// ===== 自动任务生成 =====

function autoEnqueuePendingTasks() {
  // 1. 未做摘要的章节（level=0 单章摘要缺失的）
  const chapters = db.prepare(`
    SELECT c.id, c.novel_id, c.chapter_index 
    FROM chapters c 
    LEFT JOIN chapter_summaries cs ON cs.novel_id = c.novel_id AND cs.level = 0 AND cs.start_chapter = c.chapter_index 
    WHERE cs.id IS NULL AND c.status = 'completed' AND c.content != ''
    LIMIT 5
  `).all();
  for (const ch of chapters) {
    enqueueTask({ type: TASK_TYPES.SUMMARIZE_CHAPTER, novelId: ch.novel_id, chapterId: ch.id });
  }

  // 2. 未学习的知识库
  const corpora = db.prepare("SELECT id FROM knowledge_corpora WHERE status = 'pending' LIMIT 3").all();
  for (const c of corpora) {
    enqueueTask({ type: TASK_TYPES.LEARN_CORPUS, corpusId: c.id });
  }

  // 3. 未做风格分析的小说（最近有新章节的）
  const novels = db.prepare(`
    SELECT n.id FROM novels n 
    WHERE (n.style_baseline IS NULL OR n.style_baseline = '') 
    AND (SELECT COUNT(*) FROM chapters WHERE novel_id = n.id) > 0 
    LIMIT 2
  `).all();
  for (const n of novels) {
    enqueueTask({ type: TASK_TYPES.ANALYZE_STYLE, novelId: n.id });
  }
}

// ===== 公共 API =====

export function enqueueAutoLearnTask(task) {
  return enqueueTask(task);
}

export function getAutoLearnStatus() {
  return getQueueStatus();
}

export function startAutoLearn() {
  startAutoLearnLoop();
  // 立即检查一次待处理任务
  autoEnqueuePendingTasks();
  return { started: true, queueLength: _queue.length };
}

export function stopAutoLearn() {
  stopAutoLearnLoop();
  return { stopped: true };
}

export function triggerPendingTasks() {
  autoEnqueuePendingTasks();
  // 立即尝试执行
  processNextTask();
  return getQueueStatus();
}

export { TASK_TYPES };
