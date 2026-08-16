import { db } from './db.js';

// 内存 pub/sub：Job 状态变化时推给订阅者（/jobs/stream SSE 与多书并行通知用）
const subscribers = new Set();
function emit(ev) {
  for (const cb of subscribers) {
    try { cb(ev); } catch { /* ignore */ }
  }
}

export function subscribeJobEvents(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function createJob(novelId, stage, params = '') {
  const info = db.prepare(
    `INSERT INTO generation_jobs (novel_id, stage, status, params) VALUES (?, ?, 'running', ?)`
  ).run(novelId, stage, typeof params === 'string' ? params : JSON.stringify(params));
  const job = getJob(info.lastInsertRowid);
  emit({ kind: 'created', job });
  return job;
}

export function updateJob(id, patch = {}) {
  const fields = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (['status', 'progress', 'word_count', 'stream_cursor', 'error', 'result_ref'].includes(k)) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (!fields.length) return getJob(id);
  fields.push(`updated_at = datetime('now','localtime')`);
  vals.push(id);
  db.prepare(`UPDATE generation_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  const job = getJob(id);
  emit({ kind: 'updated', job });
  return job;
}

export function getJob(id) {
  return db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id);
}

export function listJobsByNovel(novelId, limit = 20) {
  return db.prepare('SELECT * FROM generation_jobs WHERE novel_id = ? ORDER BY id DESC LIMIT ?').all(novelId, limit);
}

export function getActiveJobByNovel(novelId) {
  return db.prepare("SELECT * FROM generation_jobs WHERE novel_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(novelId);
}

export function listActiveJobs() {
  return db.prepare("SELECT * FROM generation_jobs WHERE status = 'running' ORDER BY id DESC").all();
}

// 服务器启动时调用：把残留的 running job 全部标记为 aborted。
// 服务器重启后进程内调度已丢失，任何 running 都是僵尸记录，会误导前端恢复 busy 状态。
export function clearZombieJobs() {
  const rows = db.prepare("SELECT id FROM generation_jobs WHERE status = 'running'").all();
  if (!rows.length) return 0;
  for (const r of rows) {
    db.prepare("UPDATE generation_jobs SET status = 'aborted', error = '服务器重启，任务已中断', updated_at = datetime('now','localtime') WHERE id = ?").run(r.id);
    emit({ kind: 'updated', job: getJob(r.id) });
  }
  return rows.length;
}

// 将指定 job 标记为 aborted（用户点击停止/清理僵尸任务）
export function abortJob(id) {
  const job = getJob(id);
  if (!job) return null;
  if (job.status !== 'running') return job;
  db.prepare("UPDATE generation_jobs SET status = 'aborted', error = '用户手动停止', updated_at = datetime('now','localtime') WHERE id = ?").run(id);
  emit({ kind: 'updated', job: getJob(id) });
  return getJob(id);
}

// 切入：若该 novel 该 stage 已有 running job，拒绝新建，返回 null 由调用方决定（409）
// 超过 20 分钟的 running job 视为卡死，自动标记为 failed 并允许新建
const STALE_JOB_MINUTES = 20;
export function tryCreateJob(novelId, stage, params = '') {
  const existing = db.prepare(
    `SELECT id, created_at FROM generation_jobs WHERE novel_id = ? AND stage = ? AND status = 'running' ORDER BY id DESC LIMIT 1`
  ).get(novelId, stage);
  if (existing) {
    const createdAt = new Date(existing.created_at + 'Z').getTime();
    const now = Date.now();
    const elapsed = (now - createdAt) / 60000;
    if (elapsed > STALE_JOB_MINUTES) {
      db.prepare("UPDATE generation_jobs SET status = 'failed', error = '任务超时（超过 30 分钟仍未完成，自动清理）', updated_at = datetime('now','localtime') WHERE id = ?").run(existing.id);
      emit({ kind: 'updated', job: getJob(existing.id) });
      return { conflict: false, job: createJob(novelId, stage, params) };
    }
    return { conflict: true, jobId: existing.id };
  }
  return { conflict: false, job: createJob(novelId, stage, params) };
}
