import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// resources 根目录：server 的上级（打包后 resources/server/.. = resources/；开发态 workspace/server/.. = workspace/）
const RESOURCES_ROOT = path.resolve(__dirname, '..', '..');

// 允许更新的目标子目录（相对 resources root）——只动 server 源码与前端 dist，禁止碰其他
const ALLOWED_TARGETS = ['server', 'web/dist'];

// 路径安全校验：解析后必须在某个 ALLOWED_TARGETS 下，防路径穿越（../ 等）
function resolveSafe(relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  // 规范化：去掉前导斜杠、禁止空字节
  const cleaned = relPath.replace(/^[/\\]+/, '').replace(/\0/g, '');
  const resolved = path.resolve(RESOURCES_ROOT, cleaned);
  const ok = ALLOWED_TARGETS.some((t) => {
    const abs = path.resolve(RESOURCES_ROOT, t);
    const rel = path.relative(abs, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  return ok ? resolved : null;
}

// 备份目录：userData/patch-backups/<timestamp>/（由调用方传 userData 路径）
// 这里只负责在同目录写 .bak，避免跨盘移动
function backupFile(filePath, backupRoot, relPath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const bakDir = path.join(backupRoot, path.dirname(relPath));
    fs.mkdirSync(bakDir, { recursive: true });
    const bakPath = path.join(bakDir, path.basename(relPath) + '.' + Date.now() + '.bak');
    fs.copyFileSync(filePath, bakPath);
    return bakPath;
  } catch {
    return null;
  }
}

// 应用补丁：patch = { version, files: [{ path, content, encoding }] }
// opts.backupRoot: 备份目录（userData 下）
// 返回 { applied, skipped, errors, version, needRestart }
export function applyPatch(patch, opts = {}) {
  const result = { applied: 0, skipped: 0, errors: [], version: patch?.version || '未知', backups: [], needRestart: false };
  if (!patch || !Array.isArray(patch.files)) {
    result.errors.push('补丁格式无效：缺少 files 数组');
    return result;
  }
  const backupRoot = opts.backupRoot || path.join(RESOURCES_ROOT, '.patch-backups');
  for (const f of patch.files) {
    const target = resolveSafe(f.path);
    if (!target) {
      result.errors.push(`路径不安全被拒：${f.path}`);
      result.skipped++;
      continue;
    }
    try {
      // 备份
      const bak = backupFile(target, backupRoot, f.path);
      if (bak) result.backups.push(bak);
      // 写入
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (f.encoding === 'base64') {
        fs.writeFileSync(target, Buffer.from(f.content, 'base64'));
      } else {
        fs.writeFileSync(target, String(f.content), 'utf8');
      }
      result.applied++;
      // server 文件变动需要重启后端；web/dist 变动只需前端刷新（但保险起见也重启）
      result.needRestart = true;
    } catch (e) {
      result.errors.push(`写入失败 ${f.path}: ${e.message}`);
      result.skipped++;
    }
  }
  return result;
}

// 读取当前版本
export function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(RESOURCES_ROOT, 'server', 'package.json'), 'utf8'));
    return pkg.version || '未知';
  } catch {
    return '未知';
  }
}

// 生成补丁的辅助（开发环境用）：给定文件相对路径列表，生成 patch 对象
// 文本文件用 utf8，二进制（含非 UTF-8 安全字符）用 base64
export function buildPatchFromFileList(fileRels, version, fromVersion) {
  const files = [];
  for (const rel of fileRels) {
    const abs = path.resolve(RESOURCES_ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.warn(`[patch] 跳过不存在的文件: ${rel}`);
      continue;
    }
    const buf = fs.readFileSync(abs);
    // 简单判定：可安全转 utf8 字符串则用明文，否则 base64
    const asStr = buf.toString('utf8');
    const isText = !/\0/.test(asStr) && Buffer.byteLength(asStr, 'utf8') === buf.length;
    files.push({
      path: rel.replace(/\\/g, '/'),
      content: isText ? asStr : buf.toString('base64'),
      encoding: isText ? 'utf8' : 'base64'
    });
  }
  return {
    version,
    fromVersion,
    created: new Date().toISOString(),
    filesCount: files.length,
    files
  };
}

export { RESOURCES_ROOT };
