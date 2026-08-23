import { db } from './db.js';
export { parseSkillFile } from './skill_parser.js';

export function getNovelSkillIds(novel) {
  if (!novel) return [];
  const v = novel.skill_ids;
  if (Array.isArray(v)) return v.map(Number).filter(Boolean);
  try { return JSON.parse(v || '[]').map(Number).filter(Boolean); } catch { return []; }
}

export function getSkills(ids) {
  if (!ids || !ids.length) return [];
  const unique = [...new Set(ids.map(Number).filter(Boolean))];
  if (!unique.length) return [];
  const placeholders = unique.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM skills WHERE id IN (${placeholders})`).all(...unique);
}

export function formatSkillsBlock(ids) {
  const skills = getSkills(ids);
  if (!skills.length) return '';
  const parts = skills.map((s) => {
    let text = s.content || s.description || '';
    if (s.description && s.content) {
      text = `${s.description}：${s.content}`;
    }
    return `【${s.name}】\n${text}`;
  });
  return `\n\n【本章需遵循的写作技法】
以下技法要求必须融入本章写作，不能当成参考建议：
${parts.join('\n\n')}`;
}

// ---- 根据小说题材推荐技能（技能 tags 含题材关键词时自动带入选） ----
export function recommendSkillsForGenre(genre) {
  if (!genre) return [];
  const keywords = String(genre).split(/[/、,，\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!keywords.length) return [];
  try {
    const all = db.prepare('SELECT id, name, description, content, tags FROM skills ORDER BY updated_at DESC').all();
    return all.filter((s) => {
      const tagText = String(s.tags || '') + String(s.name || '') + String(s.description || '');
      return keywords.some((k) => k && tagText.includes(k));
    }).map((s) => s.id);
  } catch { return []; }
}