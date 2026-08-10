import express from 'express';
import { db, touchNovel } from '../db.js';

// Phase 增强 5：把 routes.js 内的 relationship-nodes + shared-characters 抽离成独立子路由
export const relationshipRouter = express.Router();

relationshipRouter.get('/novels/:id/relationship-nodes', (req, res) => {
  const rows = db.prepare('SELECT character_id, x, y FROM relationship_nodes WHERE novel_id = ?').all(req.params.id);
  res.json({ nodes: rows });
});

relationshipRouter.put('/novels/:id/relationship-nodes/:cid', (req, res) => {
  const { x, y } = req.body || {};
  if (typeof x !== 'number' || typeof y !== 'number') return res.status(400).json({ error: '需要 x/y 数字' });
  db.prepare(`INSERT INTO relationship_nodes (novel_id, character_id, x, y) VALUES (?,?,?,?)
              ON CONFLICT(novel_id, character_id) DO UPDATE SET x=excluded.x, y=excluded.y`)
    .run(req.params.id, req.params.cid, x, y);
  res.json({ ok: true });
});

relationshipRouter.put('/novels/:id/relationship-nodes', (req, res) => {
  const list = Array.isArray((req.body || {}).nodes) ? req.body.nodes : [];
  const up = db.prepare(`INSERT INTO relationship_nodes (novel_id, character_id, x, y) VALUES (?,?,?,?)
                        ON CONFLICT(novel_id, character_id) DO UPDATE SET x=excluded.x, y=excluded.y`);
  const tx = db.transaction((rows) => rows.forEach((r) => up.run(req.params.id, r.character_id, Number(r.x), Number(r.y))));
  tx(list);
  res.json({ ok: true });
});

export const sharedCharactersRouter = express.Router();

sharedCharactersRouter.get('/shared-characters', (req, res) => {
  const rows = db.prepare('SELECT * FROM shared_characters ORDER BY id DESC').all();
  res.json({ characters: rows });
});

sharedCharactersRouter.post('/shared-characters', (req, res) => {
  const { name, role_type, personality, background, description, avatar_color, source_novel_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name 必填' });
  const info = db.prepare('INSERT INTO shared_characters (name, role_type, personality, background, description, avatar_color, source_novel_id) VALUES (?,?,?,?,?,?,?)')
    .run(name, role_type || '配角', personality || '', background || '', description || '', avatar_color || '#6366f1', source_novel_id || null);
  res.json(db.prepare('SELECT * FROM shared_characters WHERE id = ?').get(info.lastInsertRowid));
});

sharedCharactersRouter.put('/shared-characters/:sid', (req, res) => {
  const row = db.prepare('SELECT * FROM shared_characters WHERE id = ?').get(req.params.sid);
  if (!row) return res.status(404).json({ error: '不存在' });
  const fields = ['name', 'role_type', 'personality', 'background', 'description', 'avatar_color'];
  const sets = []; const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { sets.push(`${f} = ?`); vals.push(String(req.body[f])); }
  }
  if (sets.length) {
    vals.push(req.params.sid);
    db.prepare(`UPDATE shared_characters SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    db.prepare(`UPDATE characters SET name = ?, role_type = ?, personality = ?, background = ?, description = ?, avatar_color = ?
                WHERE shared_id = ?`)
      .run(req.body.name ?? row.name, req.body.role_type ?? row.role_type,
           req.body.personality ?? row.personality, req.body.background ?? row.background,
           req.body.description ?? row.description, req.body.avatar_color ?? row.avatar_color,
           req.params.sid);
  }
  res.json(db.prepare('SELECT * FROM shared_characters WHERE id = ?').get(req.params.sid));
});

sharedCharactersRouter.delete('/shared-characters/:sid', (req, res) => {
  db.prepare('DELETE FROM shared_characters WHERE id = ?').run(req.params.sid);
  db.prepare('UPDATE characters SET shared_id = NULL WHERE shared_id = ?').run(req.params.sid);
  res.json({ ok: true });
});

sharedCharactersRouter.post('/novels/:id/shared-characters/:sid/introduce', (req, res) => {
  const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '小说不存在' });
  const sc = db.prepare('SELECT * FROM shared_characters WHERE id = ?').get(req.params.sid);
  if (!sc) return res.status(404).json({ error: '共享角色不存在' });
  const existing = db.prepare('SELECT * FROM characters WHERE novel_id = ? AND shared_id = ?').all(row.id, sc.id);
  if (existing.length) return res.json(existing[0]);
  const info = db.prepare('INSERT INTO characters (novel_id, name, role_type, personality, background, description, avatar_color, shared_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(row.id, sc.name, sc.role_type, sc.personality, sc.background, sc.description, sc.avatar_color, sc.id);
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(info.lastInsertRowid);
  touchNovel(row.id);
  res.json(character);
});

sharedCharactersRouter.post('/novels/:id/characters/:cid/promote', (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id = ? AND novel_id = ?').get(req.params.cid, req.params.id);
  if (!c) return res.status(404).json({ error: 'character 不存在' });
  if (c.shared_id) {
    return res.json(db.prepare('SELECT * FROM shared_characters WHERE id = ?').get(c.shared_id));
  }
  const info = db.prepare('INSERT INTO shared_characters (name, role_type, personality, background, description, avatar_color, source_novel_id) VALUES (?,?,?,?,?,?,?)')
    .run(c.name, c.role_type, c.personality, c.background, c.description, c.avatar_color, c.novel_id);
  db.prepare('UPDATE characters SET shared_id = ? WHERE id = ?').run(info.lastInsertRowid, c.id);
  res.json(db.prepare('SELECT * FROM shared_characters WHERE id = ?').get(info.lastInsertRowid));
});
