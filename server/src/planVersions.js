import { db } from './db.js';
import { getNovel, getCharacters, getRelationships, getChapters } from './lib.js';

export function nextVersionNo(novelId) {
  const r = db.prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM plan_versions WHERE novel_id = ?').get(novelId);
  return (r?.m || 0) + 1;
}

export function buildSnapshot(novelId) {
  const novel = getNovel(novelId);
  if (!novel) return null;
  const chars = getCharacters(novelId);
  const rels = getRelationships(novelId);
  const chapters = getChapters(novelId).filter((c) => !c.content);
  const nameMap = {};
  for (const c of chars) nameMap[c.id] = c.name;
  return {
    title: novel.title || '',
    genre: novel.genre || '',
    concept: novel.concept || '',
    world_view: novel.world_view || '',
    outline: novel.outline || '',
    characters: chars.map((c) => ({
      name: c.name, role_type: c.role_type, personality: c.personality,
      background: c.background, description: c.description
    })),
    relationships: rels.map((r) => ({
      a: nameMap[r.source_id] || '', b: nameMap[r.target_id] || '',
      relation_type: r.relation_type, description: r.description
    })),
    chapters: chapters.map((c) => ({
      title: c.title, summary: c.summary || '', chapter_index: c.chapter_index
    }))
  };
}

export function saveVersion(novelId, snapshot, kind = 'revise', feedback = '') {
  const vno = nextVersionNo(novelId);
  const info = db.prepare('INSERT INTO plan_versions (novel_id, version_no, snapshot, kind, feedback) VALUES (?, ?, ?, ?, ?)')
    .run(novelId, vno, JSON.stringify(snapshot), kind, feedback);
  return db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(info.lastInsertRowid);
}

export function listVersions(novelId) {
  return db.prepare('SELECT id, version_no, kind, feedback, accepted, created_at FROM plan_versions WHERE novel_id = ? ORDER BY version_no DESC').all(novelId);
}

export function getVersion(vid) {
  const v = db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(vid);
  if (!v) return null;
  v.snapshot = JSON.parse(v.snapshot || '{}');
  return v;
}

export function getLatestPending(novelId) {
  const v = db.prepare("SELECT * FROM plan_versions WHERE novel_id = ? AND accepted = 0 ORDER BY version_no DESC LIMIT 1").get(novelId);
  if (!v) return null;
  v.snapshot = JSON.parse(v.snapshot || '{}');
  return v;
}

export function appendChangeLog(novelId, prevNo, nextNo, feedback, summary) {
  db.prepare('INSERT INTO plan_change_log (novel_id, prev_version_no, next_version_no, feedback, summary) VALUES (?, ?, ?, ?, ?)')
    .run(novelId, prevNo ?? null, nextNo ?? null, feedback || '', summary || '');
}

export function acceptVersion(vid) {
  db.prepare('UPDATE plan_versions SET accepted = 1 WHERE id = ?').run(vid);
  return getVersion(vid);
}

export function saveDraft(novelId, form) {
  db.prepare('INSERT INTO plan_drafts (novel_id, form, updated_at) VALUES (?, ?, datetime(\'now\',\'localtime\')) ON CONFLICT(novel_id) DO UPDATE SET form = excluded.form, updated_at = datetime(\'now\',\'localtime\')')
    .run(novelId, JSON.stringify(form));
}

export function getDraft(novelId) {
  const r = db.prepare('SELECT * FROM plan_drafts WHERE novel_id = ?').get(novelId);
  if (!r) return null;
  try { r.form = JSON.parse(r.form); } catch { r.form = {}; }
  return r;
}
