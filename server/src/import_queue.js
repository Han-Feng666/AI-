import { db } from './db.js';
import {
  fetchBookMeta,
  fetchChapter,
  throttle,
  RISK_LIMIT_STREAK,
  FanqieError,
} from './fanqie.js';
import { fetchBookInfo, fetchToc, fetchContent, BookSourceError } from './booksource.js';

/**
 * 批量导入队列（进程内单例，同一时刻处理 1 本书）
 * - enqueue: 幂等入队（进行中/已完成拒绝；failed/cancelled 复用行重置）
 * - 执行: pending → fetching（逐章抓取）→ analyzing（复用分析管线）→ done | failed | cancelled
 * - source_type: 'fanqie'（网页抓取+反混淆）| 'booksource'（Legado 书源规则抓取）
 * - 持久化: content 全文落库，失败重试/重启恢复时免重抓；runner 由 routes 注入（setImportRunner）
 */

const ACTIVE_STATUSES = "('pending','fetching','analyzing')";

let running = false;
let cancelRequested = false;
let currentCtrl = null; // 当前执行任务的 AbortController（cancelAll 时中断 LLM 分析）
let runner = null; // async ({ job, content, meta, onProgress, ctrl }) => ({ styleId } | { corpusId })

export function setImportRunner(fn) {
  runner = fn;
}

function touch(id, fields = {}) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => fields[k]);
  db.prepare(
    `UPDATE import_jobs SET ${sets ? sets + ', ' : ''}updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(...vals, id);
}

/** 幂等入队：进行中/已完成返回 duplicated；failed/cancelled 复用行重置后重新排队 */
export function enqueue({ bookId, target, genre = '', sourceType = 'fanqie', bookUrl = '', sourceSite = '', title = '', author = '' }) {
  const existing = db
    .prepare('SELECT * FROM import_jobs WHERE book_id = ? AND target = ?')
    .get(bookId, target);

  if (existing) {
    if (existing.status === 'done') return { duplicated: true, reason: '该书已导入过', job: existing };
    if (['pending', 'fetching', 'analyzing'].includes(existing.status)) {
      return { duplicated: true, reason: '该书已在队列中', job: existing };
    }
    // failed / cancelled：复用行重新排队（保留 content 缓存，重试免重抓）
    touch(existing.id, { status: 'pending', error: '', result_ref: '' });
    kick();
    return { duplicated: false, job: getJob(existing.id) };
  }

  const info = db
    .prepare(
      `INSERT INTO import_jobs (book_id, target, genre, source_type, book_url, source_site, title, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(bookId, target, genre, sourceType, bookUrl, sourceSite, title, author);
  kick();
  return { duplicated: false, job: getJob(info.lastInsertRowid) };
}

export function getJob(id) {
  return db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(id) || null;
}

export function listJobs() {
  // 列表不含 content 大字段
  return db
    .prepare(
      `SELECT id, book_id, title, author, genre, target, status, progress, message,
              total_chapters, fetched_chapters, skipped_chapters, deobf_unknown,
              result_ref, error, created_at, updated_at
       FROM import_jobs ORDER BY id ASC`
    )
    .all();
}

/** 取消所有未完成任务；执行中任务的抓取在章节间隙感知取消，LLM 分析经 AbortController 中断 */
export function cancelAll() {
  cancelRequested = true;
  try { currentCtrl?.abort(); } catch { /* ctrl 未初始化时忽略 */ }
  db.prepare(
    `UPDATE import_jobs SET status = 'cancelled',
      error = CASE WHEN status IN ('fetching','analyzing') THEN '用户取消' ELSE error END,
      updated_at = datetime('now','localtime')
     WHERE status IN ('pending','fetching','analyzing')`
  ).run();
  return listJobs();
}

export function retryJob(id) {
  const job = getJob(id);
  if (!job) return { error: '任务不存在' };
  if (!['failed', 'cancelled'].includes(job.status)) return { error: '仅失败/已取消的任务可重试' };
  touch(id, { status: 'pending', error: '', result_ref: '' });
  kick();
  return { job: getJob(id) };
}

export function deleteJob(id) {
  const job = getJob(id);
  if (!job) return { error: '任务不存在' };
  if (['pending', 'fetching', 'analyzing'].includes(job.status)) {
    return { error: '进行中的任务请先取消再删除' };
  }
  db.prepare('DELETE FROM import_jobs WHERE id = ?').run(id);
  return { ok: true };
}

/** 服务启动恢复：中断的 fetching 清缓存重抓；analyzing 保留缓存直接重排队 */
export function resumeOnBoot() {
  db.prepare(
    `UPDATE import_jobs SET status = 'pending', content = '', message = '',
      updated_at = datetime('now','localtime')
     WHERE status = 'fetching'`
  ).run();
  db.prepare(
    `UPDATE import_jobs SET status = 'pending',
      updated_at = datetime('now','localtime')
     WHERE status = 'analyzing'`
  ).run();
  kick();
}

function kick() {
  if (running) return;
  running = true;
  // 异步驱动，避免阻塞 HTTP 响应与启动流程
  setTimeout(() => runLoop().catch(() => {}).finally(() => { running = false; }), 0);
}

async function runLoop() {
  while (true) {
    if (cancelRequested) {
      cancelRequested = false;
      const still = db
        .prepare(`SELECT COUNT(*) AS n FROM import_jobs WHERE status IN ${ACTIVE_STATUSES}`)
        .get().n;
      if (!still) return;
    }
    const job = db
      .prepare(`SELECT * FROM import_jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 1`)
      .get();
    if (!job) return;
    try {
      await executeJob(job);
    } catch (e) {
      const msg = e instanceof FanqieError ? `${e.code}: ${e.message}` : e.message;
      touch(job.id, { status: 'failed', error: msg });
    }
  }
}

async function executeJob(job) {
  const ctrl = new AbortController();
  currentCtrl = ctrl;
  try {
    await executeJobInner(job, ctrl);
  } finally {
    if (currentCtrl === ctrl) currentCtrl = null;
  }
}

async function executeJobInner(job, ctrl) {
  if (job.source_type === 'booksource') return executeSourceJob(job, ctrl);
  return executeFanqieJob(job, ctrl);
}

async function executeFanqieJob(job, ctrl) {
  // content 缓存有效则跳过抓取（失败重试 / analyzing 恢复）
  let content = job.content && job.content.trim() ? job.content : '';
  let skipped = job.skipped_chapters || 0;
  let deobfUnknown = job.deobf_unknown || 0;
  let title = job.title;
  let author = job.author;

  if (!content) {
    touch(job.id, { status: 'fetching', message: '获取书籍信息…', error: '', progress: 0 });
    const meta = await fetchBookMeta(job.book_id);
    title = meta.title;
    author = meta.author;
    touch(job.id, {
      title: meta.title,
      author: meta.author,
      total_chapters: meta.chapterCount,
      message: `网页端可读 ${meta.readableCount}/${meta.chapterCount} 章`,
    });

    // 番茄网页端统一只开放部分章节（通常前 10 章），锁定章节仅有试读残片
    const readableChapters = meta.chapters.filter((c) => !c.locked);
    skipped = meta.chapterCount - readableChapters.length;
    if (!readableChapters.length) {
      touch(job.id, {
        status: 'failed',
        error: '该书在番茄网页端没有可读章节（全部被锁定为试读）',
        skipped_chapters: skipped,
      });
      return;
    }

    const parts = [];
    let consecutiveRisk = 0;
    let failedChapters = 0;
    let fetchedCount = 0;
    for (let i = 0; i < readableChapters.length; i++) {
      if (isCancelled(job.id)) return;
      const ch = readableChapters[i];
      touch(job.id, { message: `抓取章节 ${i + 1}/${readableChapters.length}` });
      try {
        const r = await fetchChapter(job.book_id, ch.itemId);
        consecutiveRisk = 0;
        if (r.text) {
          fetchedCount++;
          parts.push(`${r.title}\n${r.text}`);
          touch(job.id, {
            fetched_chapters: fetchedCount,
            progress: 5 + Math.round(((i + 1) / readableChapters.length) * 55),
            deobf_unknown: deobfUnknown + (r.residual || 0),
          });
          deobfUnknown += r.residual || 0;
        }
      } catch (e) {
        // 锁定章节残片：静默跳过，计入 skipped
        if (e.code !== 'CHAPTER_LOCKED') {
          failedChapters++;
        }
        touch(job.id, { skipped_chapters: skipped + failedChapters });
        if (e.code === 'RISK_LIMITED') {
          consecutiveRisk++;
          if (consecutiveRisk >= RISK_LIMIT_STREAK) {
            // 风控升级：保存已抓内容后失败退出，用户稍后重试（免重抓）
            touch(job.id, {
              status: 'failed',
              content: parts.join('\n\n'),
              error: `连续 ${consecutiveRisk} 章被番茄风控限流，任务暂停。请稍后重试（已抓取内容已保留）`,
            });
            return;
          }
        } else if (e.code === 'DEOBF_BROKEN') {
          touch(job.id, { status: 'failed', content: parts.join('\n\n'), error: e.message });
          return;
        }
        // 其他单章失败：跳过继续
      }
      await throttle();
    }
    content = parts.join('\n\n');
    skipped += failedChapters;
  }

  if (isCancelled(job.id)) return;
  if (!content.trim()) {
    touch(job.id, { status: 'failed', error: '未抓取到任何章节内容', skipped_chapters: skipped });
    return;
  }
  touch(job.id, { status: 'analyzing', message: '分析入库…', content, skipped_chapters: skipped });

  try {
    const result = await runPipeline(job, content, title, author, ctrl);
    const ref = result?.styleId
      ? `style:${result.styleId}`
      : result?.corpusId
        ? `knowledge:${result.corpusId}`
        : '';
    touch(job.id, { status: 'done', message: '完成', progress: 100, result_ref: ref });
  } catch (e) {
    if (isCancelled(job.id) || ctrl.signal.aborted) {
      touch(job.id, { status: 'cancelled', message: '已取消', error: '用户取消' });
    } else {
      touch(job.id, { status: 'failed', error: `分析失败: ${e.message}` });
    }
  }
}

async function runPipeline(job, content, title, author, ctrl) {
  if (!runner) throw new Error('导入管线未注册（setImportRunner）');
  return runner({
    job,
    content,
    meta: { title, author },
    ctrl,
    onProgress: (progress, message) => {
      // 分析阶段管线 progress 为 5-100，映射到 60-100 避免进度回退
      const p = Number.isFinite(progress) ? 60 + Math.round(Math.max(0, Math.min(100, progress)) * 0.4) : 60;
      touch(job.id, { progress: p, message: message || '分析中…' });
    },
  });
}

/** 书源任务：目录 → 逐章正文（站点节流在 booksource.js 内部）→ 分析管线 */
async function executeSourceJob(job, ctrl) {
  let content = job.content && job.content.trim() ? job.content : '';
  let skipped = job.skipped_chapters || 0;
  let title = job.title;
  let author = job.author;

  if (!content) {
    touch(job.id, { status: 'fetching', message: '获取书籍信息…', error: '', progress: 0 });

    // 从队列行还原书源规则（存入时由 routes 检查可用性；禁用书源的任务按已入队内容继续执行）
    let source = null;
    try {
      const src = db.prepare('SELECT * FROM book_sources WHERE source_url = ?').get(job.source_site);
      if (src && src.status === 'enabled') {
        source = {
          name: src.name,
          sourceUrl: src.source_url,
          searchUrl: src.search_url,
          rules: JSON.parse(src.rules_json),
          partial: JSON.parse(src.partial_json || '[]')
        };
      }
    } catch { /* 规则缺失走下方失败 */ }
    if (!source) {
      touch(job.id, { status: 'failed', error: '书源已被删除或禁用，无法抓取' });
      return;
    }

    let chapters = [];
    try {
      const info = await fetchBookInfo(source, job.book_url);
      if (info.title) title = info.title;
      if (info.author) author = info.author;
      chapters = await fetchToc(source, job.book_url);
    } catch (e) {
      const msg = e instanceof BookSourceError ? `${e.code}: ${e.message}` : e.message;
      touch(job.id, { status: 'failed', error: `抓取目录失败: ${msg}` });
      return;
    }

    touch(job.id, {
      title,
      author,
      total_chapters: chapters.length,
      message: `共 ${chapters.length} 章，开始抓取正文`,
    });

    const parts = [];
    let consecutiveFail = 0;
    let failedChapters = 0;
    let fetchedCount = 0;
    for (let i = 0; i < chapters.length; i++) {
      if (isCancelled(job.id)) return;
      const ch = chapters[i];
      touch(job.id, { message: `抓取章节 ${i + 1}/${chapters.length}` });
      try {
        const body = await fetchContent(source, ch.url);
        consecutiveFail = 0;
        fetchedCount++;
        parts.push(`${ch.title}\n${body}`);
        touch(job.id, {
          fetched_chapters: fetchedCount,
          progress: 5 + Math.round(((i + 1) / chapters.length) * 55),
        });
      } catch (e) {
        failedChapters++;
        consecutiveFail++;
        touch(job.id, { skipped_chapters: skipped + failedChapters });
        if (consecutiveFail >= RISK_LIMIT_STREAK) {
          touch(job.id, {
            status: 'failed',
            content: parts.join('\n\n'),
            error: `连续 ${consecutiveFail} 章抓取失败，站点可能已失效。请稍后重试（已抓取内容已保留）`,
          });
          return;
        }
      }
    }
    content = parts.join('\n\n');
    skipped += failedChapters;
  }

  if (isCancelled(job.id)) return;
  if (!content.trim()) {
    touch(job.id, { status: 'failed', error: '未抓取到任何章节内容', skipped_chapters: skipped });
    return;
  }
  touch(job.id, { status: 'analyzing', message: '分析入库…', content, skipped_chapters: skipped });

  try {
    const result = await runPipeline(job, content, title, author, ctrl);
    const ref = result?.styleId
      ? `style:${result.styleId}`
      : result?.corpusId
        ? `knowledge:${result.corpusId}`
        : '';
    touch(job.id, { status: 'done', message: '完成', progress: 100, result_ref: ref });
  } catch (e) {
    if (isCancelled(job.id) || ctrl.signal.aborted) {
      touch(job.id, { status: 'cancelled', message: '已取消', error: '用户取消' });
    } else {
      touch(job.id, { status: 'failed', error: `分析失败: ${e.message}` });
    }
  }
}

function isCancelled(jobId) {
  const row = db.prepare('SELECT status FROM import_jobs WHERE id = ?').get(jobId);
  return !row || row.status === 'cancelled';
}
