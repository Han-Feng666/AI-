#!/usr/bin/env node
// 增量补丁生成器（开发环境用）
// 用法：
//   node scripts/make-patch.cjs [--build] [--out <path>] [--from <ref>] [--files a,b]
//
// 默认对比 git 工作区相对 HEAD 的改动，把 server/ 下变动的文件
// 以及 web/dist/ 下所有文件（gitignored，无法 diff，故全量打包）
// 组合成一个 .patch.json 补丁，供「软件增量更新」功能在本机应用。
//
//   --build       生成前先跑前端构建（web 有改动时必须，否则 dist 里没有新代码）
//   --out <path>  输出文件路径，默认 desktop/release/update-<version>.patch.json
//   --from <ref>  git 对比基准，默认 HEAD
//   --files a,b   手动指定要打包的文件（逗号分隔），跳过自动检测
//   --full-dist   强制打包整个 web/dist（默认即如此，此选项保留兼容）
//
// 补丁里的文件路径是相对「resources」目录的（打包后 server 在 resources/server，
// web/dist 在 resources/web/dist），与本机应用目录结构一致。

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const RESOURCES = ROOT;

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function productVersion() {
  try { return require(path.join(ROOT, 'desktop', 'package.json')).version; }
  catch { return '0.0.0'; }
}

function readForPatch(abs) {
  const buf = fs.readFileSync(abs);
  const asStr = buf.toString('utf8');
  const isText = !/\0/.test(asStr) && Buffer.byteLength(asStr, 'utf8') === buf.length;
  return {
    path: path.relative(RESOURCES, abs).replace(/\\/g, '/'),
    content: isText ? asStr : buf.toString('base64'),
    encoding: isText ? 'utf8' : 'base64'
  };
}

// 递归收集目录下所有文件
function walkDir(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkDir(full, base));
    } else {
      out.push(full);
    }
  }
  return out;
}

// 用 git status --porcelain 收集变动文件（含未跟踪文件）
function collectChangedServer(fromRef) {
  const out = [];
  // 已跟踪但修改的文件
  const diffNames = git(`diff --name-only ${fromRef} -- server/`);
  if (diffNames) out.push(...diffNames.split('\n').map((s) => s.trim()).filter(Boolean));
  // 未跟踪的文件（git status --porcelain 第一个字符为 ?）
  const status = git('status --porcelain -- server/');
  if (status) {
    for (const line of status.split('\n')) {
      if (!line.trim()) continue;
      const flag = line[0];
      const file = line.slice(3).trim();
      if (flag === '?' && file.startsWith('server/')) out.push(file);
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const doBuild = args.includes('--build');
  const outIdx = args.indexOf('--out');
  const fromIdx = args.indexOf('--from');
  const filesIdx = args.indexOf('--files');
  const outPath = outIdx > -1 ? args[outIdx + 1] : null;
  const fromRef = fromIdx > -1 ? args[fromIdx + 1] : 'HEAD';
  const manualFiles = filesIdx > -1 ? (args[filesIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null;

  if (doBuild) {
    console.log('[patch] 构建前端…');
    execSync('npm --prefix web run build', { cwd: ROOT, stdio: 'inherit' });
  }

  let rels;
  if (manualFiles) {
    rels = manualFiles.slice();
  } else {
    // server/ 下变动的文件
    rels = collectChangedServer(fromRef);
  }

  // web/dist 是 gitignored，无法用 git diff 检测，全量打包
  if (fs.existsSync(WEB_DIST)) {
    const distFiles = walkDir(WEB_DIST).map((f) => path.relative(RESOURCES, f).replace(/\\/g, '/'));
    rels.push(...distFiles);
    console.log(`[patch] web/dist: ${distFiles.length} 个文件（全量打包，gitignored）`);
  }

  // 去重 + 过滤
  rels = [...new Set(rels)].filter((r) => r.startsWith('server/') || r.startsWith('web/dist/'));

  if (!rels.length) {
    console.log('[patch] 没有检测到改动。');
    console.log('[patch] 若刚改动前端源码（web/src），请加 --build 先构建。');
    process.exit(0);
  }

  const files = [];
  let missing = 0;
  for (const rel of rels) {
    const abs = path.join(RESOURCES, rel);
    if (!fs.existsSync(abs)) { console.warn(`[patch] 跳过不存在的文件: ${rel}`); missing++; continue; }
    files.push(readForPatch(abs));
  }

  const version = productVersion();
  const patch = {
    version,
    fromVersion: git('rev-parse --short HEAD') || version,
    created: new Date().toISOString(),
    filesCount: files.length,
    files
  };

  const outFile = outPath || path.join(ROOT, 'desktop', 'release', `update-${version}.patch.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(patch, null, 2));

  const sizeKB = Math.round(fs.statSync(outFile).size / 1024);
  console.log(`[patch] 完成：${files.length} 个文件，${sizeKB} KB`);
  console.log(`[patch] 输出：${outFile}`);
  console.log('[patch] 使用：在本机软件「设置 → 软件增量更新」选择此文件应用，应用后自动重启。');
}

main();
