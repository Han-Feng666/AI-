#!/usr/bin/env node
// 一键构建+生成增量补丁
// 用法：node scripts/build-and-patch.cjs [--bump] [--no-build] [--out <path>] [--from <ref>]
//
// 完整流程：
//   1. (可选) 递增版本号 desktop/package.json + server/package.json
//   2. (可选) 构建前端 npm run build
//   3. 自动检测改动基准：有未提交改动用 HEAD，否则用 HEAD~1
//   4. 收集 server/ 变动文件 + web/dist 全量文件
//   5. 输出 .patch.json 到 desktop/release/
//
//   --bump       递增 patch 版本号（如 1.4.15 → 1.4.16）
//   --no-build   跳过前端构建（仅后端改动时用）
//   --out <path> 自定义输出路径
//   --from <ref> 手动指定 git 对比基准

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP_PKG = path.join(ROOT, 'desktop', 'package.json');
const SERVER_PKG = path.join(ROOT, 'server', 'package.json');
const WEB_DIST = path.join(ROOT, 'web', 'dist');

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function readPkgVer(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

function writePkgVer(file, ver) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = ver;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

function bumpPatch(ver) {
  const parts = ver.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join('.');
}

function walkDir(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDir(full));
    else out.push(full);
  }
  return out;
}

function readForPatch(abs, base) {
  const buf = fs.readFileSync(abs);
  const asStr = buf.toString('utf8');
  const isText = !/\0/.test(asStr) && Buffer.byteLength(asStr, 'utf8') === buf.length;
  return {
    path: path.relative(base, abs).replace(/\\/g, '/'),
    content: isText ? asStr : buf.toString('base64'),
    encoding: isText ? 'utf8' : 'base64'
  };
}

function collectChangedServer(fromRef) {
  const out = [];
  const diffNames = git(`diff --name-only ${fromRef} -- server/`);
  if (diffNames) out.push(...diffNames.split('\n').map(s => s.trim()).filter(Boolean));
  const status = git('status --porcelain -- server/');
  if (status) {
    for (const line of status.split('\n')) {
      if (!line.trim()) continue;
      if (line[0] === '?') {
        const file = line.slice(3).trim();
        if (file.startsWith('server/')) out.push(file);
      }
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const doBump = args.includes('--bump');
  const noBuild = args.includes('--no-build');
  const outIdx = args.indexOf('--out');
  const fromIdx = args.indexOf('--from');
  const outPath = outIdx > -1 ? args[outIdx + 1] : null;

  console.log('========================================');
  console.log('  增量补丁一键生成');
  console.log('========================================\n');

  // Step 1: 版本递增
  let version = readPkgVer(DESKTOP_PKG);
  if (doBump) {
    version = bumpPatch(version);
    writePkgVer(DESKTOP_PKG, version);
    writePkgVer(SERVER_PKG, version);
    console.log(`[1/4] 版本递增: ${readPkgVer(DESKTOP_PKG)} → ${version}`);
  } else {
    console.log(`[1/4] 当前版本: ${version}（未递增，加 --bump 递增）`);
  }

  // Step 2: 前端构建
  if (!noBuild) {
    console.log('\n[2/4] 构建前端…');
    execSync('npm --prefix web run build', { cwd: ROOT, stdio: 'inherit' });
    console.log('前端构建完成');
  } else {
    console.log('\n[2/4] 跳过前端构建（--no-build）');
  }

  // Step 3: 检测改动基准
  let fromRef = fromIdx > -1 ? args[fromIdx + 1] : null;
  if (!fromRef) {
    const hasUncommitted = git('status --porcelain -- server/ web/src/');
    if (hasUncommitted) {
      fromRef = 'HEAD';
      console.log(`\n[3/4] 基准: HEAD（有未提交改动）`);
    } else {
      fromRef = 'HEAD~1';
      console.log(`\n[3/4] 基准: HEAD~1（无未提交改动，对比上个 commit）`);
    }
  } else {
    console.log(`\n[3/4] 基准: ${fromRef}（手动指定）`);
  }

  // Step 4: 收集文件
  let rels = collectChangedServer(fromRef);
  if (fs.existsSync(WEB_DIST)) {
    const distFiles = walkDir(WEB_DIST).map(f => path.relative(ROOT, f).replace(/\\/g, '/'));
    rels.push(...distFiles);
    console.log(`       server/ 变动: ${rels.filter(r => r.startsWith('server/')).length} 个`);
    console.log(`       web/dist/ 全量: ${distFiles.length} 个`);
  }
  rels = [...new Set(rels)].filter(r => r.startsWith('server/') || r.startsWith('web/dist/'));

  if (!rels.length) {
    console.log('\n[4/4] 没有检测到改动，补丁为空。');
    process.exit(0);
  }

  const files = [];
  for (const rel of rels) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.warn(`跳过不存在: ${rel}`); continue; }
    files.push(readForPatch(abs, ROOT));
  }

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
  console.log(`\n[4/4] 补丁生成完成`);
  console.log(`  文件数: ${files.length}`);
  console.log(`  大小: ${sizeKB} KB`);
  console.log(`  版本: v${version}`);
  console.log(`  输出: ${outFile}`);
  console.log('\n用户操作：在「设置 → 软件增量更新」选择此文件应用，自动重启。');
}

main();
