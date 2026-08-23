// db 全新建库初始化自检：在临时目录创建全新数据库并完整建表，
// 用于在构建/升级前发现"ensureColumn 在表创建前调用"这类初始化崩溃。
// 用法：node scripts/db-smoke.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-db-smoke-'));
process.env.NOVEL_DATA_DIR = tmpDir;

try {
  const { db } = await import('../src/db.js');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);

  const required = [
    'novels', 'chapters', 'styles', 'skills', 'characters', 'relationships',
    'foreshadowings', 'generation_jobs', 'adaptation_jobs', 'adaptation_candidates',
    'ai_detections', 'knowledge_corpora', 'knowledge_samples', 'settings',
    'world_settings', 'character_voices', 'character_timeline', 'novel_timeline',
    'style_drift_log', 'generation_stats', 'manager_messages', 'manager_memory'
  ];
  const missing = required.filter((t) => !tables.includes(t));
  if (missing.length) {
    console.error(`[SMOKE] 缺失表: ${missing.join(', ')}`);
    process.exit(1);
  }

  // 检查此前出错的兼容列存在性（ensureColumn 链路）
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const checks = [
    ['adaptation_jobs', ['plans']],
    ['novels', ['skill_ids', 'genre', 'style_ids', 'style_presets']],
    ['chapters', ['summary', 'emotion', 'ai_score', 'beats']]
  ];
  const colMissing = [];
  for (const [t, list] of checks) {
    const c = cols(t);
    for (const col of list) if (!c.includes(col)) colMissing.push(`${t}.${col}`);
  }
  if (colMissing.length) {
    console.error(`[SMOKE] 缺失列: ${colMissing.join(', ')}`);
    process.exit(1);
  }

  // 验证预设技能种子已写入
  const skillCount = db.prepare('SELECT COUNT(*) n FROM skills').get().n;
  if (skillCount < 6) {
    console.error(`[SMOKE] 预设技能种子异常: 期望≥6，实际 ${skillCount}`);
    process.exit(1);
  }

  console.log(`[SMOKE] OK: 全新库初始化成功，${tables.length} 张表，${skillCount} 个预设技能`);
} catch (e) {
  console.error('[SMOKE] FAIL: 全新库初始化崩溃:\n', e && e.stack ? e.stack : e);
  process.exit(1);
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}