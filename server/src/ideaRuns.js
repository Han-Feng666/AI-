import { db } from './db.js';

// 灵感生成运行记录：/ideas 是流式单次请求，连接中断（断网/刷新/休眠）后前端无法重新
// 挂回同一个 POST 流。把每次生成的最终产物按 request_id 落盘，断线后前端凭同一
// request_id 轮询取回，实现"断网/额度耗尽后不丢正在生成的整批创意"。
const MAX_AGE_HOURS = 48;

export function startIdeaRun(requestId, params = '') {
  if (!requestId) return null;
  db.prepare(
    `INSERT INTO idea_runs (request_id, status, ideas, error, params, updated_at) VALUES (?, 'running', '', '', ?, datetime('now','localtime'))
     ON CONFLICT(request_id) DO UPDATE SET status = 'running', ideas = '', error = '', params = excluded.params, updated_at = datetime('now','localtime')`
  ).run(String(requestId), typeof params === 'string' ? params : JSON.stringify(params));
  return getIdeaRun(requestId);
}

// 把最终事件（done/error/aborted）写回运行记录
export function finishIdeaRun(requestId, result) {
  if (!requestId) return null;
  const type = result?.type;
  if (type === 'done') {
    const ideas = Array.isArray(result?.data?.ideas) ? result.data.ideas : [];
    db.prepare(
      `UPDATE idea_runs SET status = 'done', ideas = ?, error = '', updated_at = datetime('now','localtime') WHERE request_id = ?`
    ).run(JSON.stringify(ideas), String(requestId));
  } else if (type === 'error') {
    db.prepare(
      `UPDATE idea_runs SET status = 'error', error = ?, updated_at = datetime('now','localtime') WHERE request_id = ?`
    ).run(String(result?.message || '生成失败'), String(requestId));
  } else if (type === 'aborted') {
    db.prepare(
      `UPDATE idea_runs SET status = 'aborted', error = ?, updated_at = datetime('now','localtime') WHERE request_id = ?`
    ).run(String(result?.message || '已停止'), String(requestId));
  }
  return getIdeaRun(requestId);
}

export function getIdeaRun(requestId) {
  if (!requestId) return null;
  const r = db.prepare('SELECT * FROM idea_runs WHERE request_id = ?').get(String(requestId));
  if (!r) return null;
  let ideas = [];
  try { ideas = JSON.parse(r.ideas || '[]'); } catch { ideas = []; }
  return { request_id: r.request_id, status: r.status, ideas, error: r.error || '', created_at: r.created_at, updated_at: r.updated_at };
}

// 清理过期记录（48 小时），避免表无限增长。启动与每次写入时机均可调用。
export function pruneIdeaRuns() {
  try {
    db.prepare("DELETE FROM idea_runs WHERE updated_at < datetime('now','localtime','-" + MAX_AGE_HOURS + " hours')").run();
  } catch { /* 清理失败不阻塞 */ }
}
