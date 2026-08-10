// 打包前准备：把 server/node_modules 复制到不含 "node_modules" 字样的暂存目录。
// 目的：绕开 electron-builder 对 extraResources 中 node_modules 目录的智能过滤，
// 确保后端依赖 100% 被打进安装包（否则安装后内置服务因缺依赖启动即退出）。
const fs = require('node:fs');
const path = require('node:path');

const src = path.resolve(__dirname, '..', '..', 'server', 'node_modules');
const dest = path.resolve(__dirname, '..', '.build', 'server-deps');

if (!fs.existsSync(src)) {
  console.error('[prepare-deps] 未找到 server/node_modules，请先执行：cd server && npm install');
  process.exit(1);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true, force: true });

// 清理 onnxruntime-node 中不需要的平台二进制（减小安装包体积）
// 保留 win32/x64，移除 darwin/linux
const ortBin = path.join(dest, 'onnxruntime-node', 'bin', 'napi-v6');
if (fs.existsSync(ortBin)) {
  for (const plat of ['darwin', 'linux']) {
    const platDir = path.join(ortBin, plat);
    if (fs.existsSync(platDir)) {
      fs.rmSync(platDir, { recursive: true, force: true });
      console.log(`[prepare-deps] 已清理 onnxruntime-node/${plat} 平台二进制`);
    }
  }
}

// 移除 onnxruntime-web（浏览器 WASM 版，Node 环境用 onnxruntime-node 即可）
const ortWebDir = path.join(dest, 'onnxruntime-web');
if (fs.existsSync(ortWebDir)) {
  fs.rmSync(ortWebDir, { recursive: true, force: true });
  console.log('[prepare-deps] 已清理 onnxruntime-web（Node 环境不需要）');
}

// 移除 sharp（可选的图像处理库，onnxruntime 的 transitive dep，非必需）
const sharpDir = path.join(dest, 'sharp');
if (fs.existsSync(sharpDir)) {
  fs.rmSync(sharpDir, { recursive: true, force: true });
  console.log('[prepare-deps] 已清理 sharp');
}

const count = fs.readdirSync(dest).length;
console.log(`[prepare-deps] server/node_modules（${count} 个包）已复制到 ${dest}`);
