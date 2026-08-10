import express from 'express';
import { db } from '../db.js';

// Phase 增强 5：manager_memory CRUD 抽离
export const managerMemoryRouter = express.Router();

managerMemoryRouter.get('/manager/memory', (req, res) => {
  const nid = req.query.novel_id ? Number(req.query.novel_id) : null;
  const rows = nid
    ? db.prepare('SELECT id, novel_id, kind, content, created_at FROM manager_memory WHERE (novel_id = ? OR novel_id IS NULL) ORDER BY id').all(nid)
    : db.prepare('SELECT id, novel_id, kind, content, created_at FROM manager_memory ORDER BY id').all();
  res.json({ memories: rows });
});

managerMemoryRouter.post('/manager/memory', (req, res) => {
  const { novel_id, kind, content } = req.body || {};
  if (!content) return res.status(400).json({ error: '内容必填' });
  const info = db.prepare('INSERT INTO manager_memory (novel_id, kind, content) VALUES (?,?,?)')
    .run(novel_id || null, String(kind || 'note'), String(content));
  res.json({ id: info.lastInsertRowid });
});

managerMemoryRouter.put('/manager/memory/:mid', (req, res) => {
  const { content, kind } = req.body || {};
  if (!content) return res.status(400).json({ error: '内容必填' });
  db.prepare('UPDATE manager_memory SET content = ?, kind = ? WHERE id = ?')
    .run(String(content), String(kind || 'note'), req.params.mid);
  res.json({ ok: true });
});

managerMemoryRouter.delete('/manager/memory/:mid', (req, res) => {
  db.prepare('DELETE FROM manager_memory WHERE id = ?').run(req.params.mid);
  res.json({ ok: true });
});
