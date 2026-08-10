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

// 切入：若该 novel 该 stage 已有 running job，拒绝新建，返回 null 由调用方决定（409）
export function tryCreateJob(novelId, stage, params = '') {
  const existing = db.prepare(
    "SELECT id FROM generation_jobs WHERE novel_id = ? AND stage = ? AND status = 'running' ORDER BY id DESC LIMIT 1"
  ).get(novelId, stage);
  if (existing) return { conflict: true, jobId: existing.id };
  return { conflict: false, job: createJob(novelId, stage, params) };
}
