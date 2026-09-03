import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { validateSource } from './booksource.js';

/**
 * 内置书源 seed：启动时把 data/book_sources_builtin.json 同步进 book_sources 表。
 * - 首次插入状态 enabled；ON CONFLICT 只更新规则，保留用户改过的 status（禁用不被覆盖）
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_PATH = path.join(__dirname, 'data', 'book_sources_builtin.json');

export function seedBuiltinSources() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(BUILTIN_PATH, 'utf-8'));
  } catch {
    return { seeded: 0 };
  }
  const list = Array.isArray(raw) ? raw : [raw];
  let n = 0;
  for (const item of list) {
    try {
      const s = validateSource(item);
      db.prepare(
        `INSERT INTO book_sources (name, source_url, search_url, rules_json, partial_json, status)
         VALUES (?, ?, ?, ?, ?, 'enabled')
         ON CONFLICT(source_url) DO UPDATE SET
           name = excluded.name, search_url = excluded.search_url,
           rules_json = excluded.rules_json, partial_json = excluded.partial_json`
      ).run(s.name, s.sourceUrl, s.searchUrl, JSON.stringify(s.rules), JSON.stringify(s.partial));
      n++;
    } catch {
      // 非法条目跳过，不阻塞启动
    }
  }
  return { seeded: n };
}
