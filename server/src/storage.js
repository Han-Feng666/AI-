import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.join(__dirname, 'data', 'novels');

export function getNovelsRoot() {
  return getSetting('novels_root') || process.env.NOVELS_ROOT_DEFAULT || DEFAULT_ROOT;
}

export async function ensureRoot() {
  await fsp.mkdir(getNovelsRoot(), { recursive: true });
}

export async function setNovelsRoot(root, { migrate = false } = {}) {
  const target = String(root || '').trim();
  if (!target) throw new Error('存储目录不能为空');
  const prev = getNovelsRoot();
  const abs = path.resolve(target);
  await fsp.mkdir(abs, { recursive: true });
  if (migrate && path.resolve(prev) !== abs) {
    await migrateRoot(prev, abs);
  }
  setSetting('novels_root', abs);
  return abs;
}

async function migrateRoot(from, to) {
  const folders = await fsp.readdir(from).catch(() => []);
  for (const f of folders) {
    const src = path.join(from, f);
    if (!fs.statSync(src).isDirectory()) continue;
    const dst = path.join(to, f);
    if (fs.existsSync(dst)) {
      await fsp.cp(src, dst, { recursive: true });
      await fsp.rm(src, { recursive: true, force: true });
    } else {
      await fsp.rename(src, dst);
    }
  }
}

// 过滤文件夹/文件名的非法字符（兼容 Windows：\/:*?"<>| 等）
export function sanitizeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, 80) || '未命名';
}

export function novelFolderPath(novel) {
  return path.join(getNovelsRoot(), sanitizeName(novel?.title || '未命名'));
}

export async function ensureNovelFolder(novel) {
  await ensureRoot();
  const folder = novelFolderPath(novel);
  await fsp.mkdir(folder, { recursive: true });
  return folder;
}

function chapterFileName(idx, title) {
  const t = sanitizeName(title);
  return `第${idx}章-${t || `第${idx}章`}.txt`;
}

function chapterText(title, content) {
  return `${title || ''}\n\n${content || ''}`.trimEnd() + '\n';
}

// 把一章写入「小说名/第N章-标题.txt」（同步副本，数据库仍为主存储）
export async function writeChapterTxt(novel, chapter) {
  if (!chapter || !chapter.content) return null;
  const folder = await ensureNovelFolder(novel);
  // 先清理同章节的旧文件（章节标题变化后文件名也会变化，避免残留）
  const prefix = `第${chapter.chapter_index}章-`;
  const files = await fsp.readdir(folder).catch(() => []);
  for (const f of files) {
    if (f.startsWith(prefix)) {
      await fsp.rm(path.join(folder, f), { force: true });
    }
  }
  const file = path.join(folder, chapterFileName(chapter.chapter_index, chapter.title));
  await fsp.writeFile(file, chapterText(chapter.title, chapter.content), 'utf8');
  return file;
}

export async function deleteChapterTxt(novel, idx) {
  const folder = novelFolderPath(novel);
  const prefix = `第${idx}章-`;
  const files = await fsp.readdir(folder).catch(() => []);
  for (const f of files) {
    if (f.startsWith(prefix)) {
      await fsp.rm(path.join(folder, f), { force: true });
    }
  }
}

export async function renameNovelFolder(novel, newTitle) {
  const old = novelFolderPath(novel);
  const folder = path.dirname(old);
  const fresh = path.join(folder, sanitizeName(newTitle || '未命名'));
  if (path.resolve(old) === path.resolve(fresh)) return;
  if (fs.existsSync(fresh)) return;
  await fsp.rename(old, fresh).catch(() => {});
}

export async function deleteNovelFolder(novel) {
  const folder = novelFolderPath(novel);
  await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
}

// ---------- 长效记忆文件：小说文件夹下的「记忆.txt」 ----------
export function memoryFilePath(novel) {
  return path.join(novelFolderPath(novel), '记忆.txt');
}

export function readMemoryFile(novel) {
  const p = memoryFilePath(novel);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

export function writeMemoryFile(novel, text) {
  const folder = novelFolderPath(novel);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '记忆.txt'), String(text || ''), 'utf8');
  return true;
}
