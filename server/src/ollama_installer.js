/**
 * Ollama 自动下载安装器 — 应用内一键安装，无需手动去 ollama.com
 * 支持平台：Windows / macOS / Linux
 * 流程：下载安装包 → 静默安装 → 启动服务 → 拉取模型
 */
import { exec, execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { getSetting, setSetting } from './db.js';

// 下载缓存目录
const DOWNLOAD_DIR = join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.ai-novel-studio', 'downloads');
const OLLAMA_INSTALL_LOG = join(DOWNLOAD_DIR, 'ollama-install.log');

// 各平台下载 URL
const OLLAMA_URLS = {
  win32: 'https://ollama.com/download/OllamaSetup.exe',
  darwin: 'https://ollama.com/download/Ollama-darwin.zip',
  linux: 'https://ollama.com/download/ollama-linux-amd64.tgz'
};

// 推荐模型（按大小排序）
const RECOMMENDED_MODELS = [
  { name: 'qwen2.5:3b', size: '~2GB', desc: '超轻量，低配电脑可用', minRam: '4GB' },
  { name: 'qwen2.5:7b', size: '~4.7GB', desc: '推荐入门，速度快中文好', minRam: '8GB' },
  { name: 'deepseek-r1:7b', size: '~4.7GB', desc: '推理强，适合悬疑推理类', minRam: '8GB' },
  { name: 'qwen2.5:14b', size: '~9GB', desc: '质量更高，适合正式创作', minRam: '16GB' },
  { name: 'qwen2.5:32b', size: '~20GB', desc: '最高质量，需强力硬件', minRam: '32GB' },
];

let _installProgress = null;

function getPlatform() {
  const platform = process.platform;
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

function getDownloadUrl() {
  return OLLAMA_URLS[getPlatform()] || OLLAMA_URLS.linux;
}

/**
 * 下载文件（带进度回调）
 */
async function downloadFile(url, destPath, onProgress) {
  const MAX_REDIRECTS = 10;

  async function doFetch(targetUrl, depth) {
    if (depth > MAX_REDIRECTS) {
      throw new Error('重定向次数过多');
    }

    // 使用全局 fetch（Node 18+，支持 HTTP/2 和自动重定向）
    const resp = await fetch(targetUrl, {
      redirect: 'manual', // 手动处理重定向以跟踪进度
      headers: { 'User-Agent': 'AI-Novel-Studio/1.0' },
    });

    // 处理所有重定向状态码：301/302/303/307/308
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get('location');
      if (!location) {
        throw new Error(`重定向但未提供目标地址，HTTP ${resp.status}`);
      }
      const nextUrl = location.startsWith('http') ? location : new URL(location, targetUrl).href;
      return doFetch(nextUrl, depth + 1);
    }

    if (resp.status !== 200) {
      throw new Error(`下载失败，HTTP ${resp.status}`);
    }

    const total = parseInt(resp.headers.get('content-length') || '0');
    let received = 0;
    let lastReport = 0;

    const reader = resp.body.getReader();
    const file = createWriteStream(destPath);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      file.write(value);
      received += value.length;

      const now = Date.now();
      if (now - lastReport > 500 || (total && received >= total)) {
        lastReport = now;
        if (onProgress) {
          onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 });
        }
      }
    }

    await new Promise((resolve, reject) => {
      file.end(resolve);
      file.on('error', reject);
    });

    return destPath;
  }

  return doFetch(url, 0);
}

/**
 * 执行命令并等待完成
 */
function runCmd(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: options.timeout || 60000, ...options }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/**
 * 检查 Ollama 是否已安装
 */
export function isOllamaInstalled() {
  try {
    if (getPlatform() === 'win32') {
      // Windows: 检查安装目录
      const paths = [
        join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
        join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
        '/usr/local/bin/ollama',
        '/usr/bin/ollama',
      ];
      if (paths.some((p) => existsSync(p))) return true;
      try { execSync('ollama --version', { stdio: 'pipe' }); return true; } catch { /* not installed */ }
    } else if (getPlatform() === 'darwin') {
      if (existsSync('/usr/local/bin/ollama')) return true;
      try { execSync('ollama --version', { stdio: 'pipe' }); return true; } catch { /* not installed */ }
    } else {
      if (existsSync('/usr/local/bin/ollama') || existsSync('/usr/bin/ollama')) return true;
      try { execSync('ollama --version', { stdio: 'pipe' }); return true; } catch { /* not installed */ }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 安装 Ollama（一键）
 * 返回一个 EventEmitter-like 对象，通过回调通知进度
 */
export async function installOllama(onProgress) {
  if (_installProgress) {
    throw new Error('已有安装任务在进行中');
  }

  _installProgress = { stage: 'starting', percent: 0 };
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  try {
    const platform = getPlatform();
    const url = getDownloadUrl();
    const installerPath = join(DOWNLOAD_DIR, platform === 'win32' ? 'OllamaSetup.exe' : platform === 'darwin' ? 'Ollama-darwin.zip' : 'ollama-linux.tgz');

    // 阶段 1：下载
    _installProgress.stage = 'downloading';
    _installProgress.percent = 0;
    onProgress?.({ stage: 'downloading', percent: 0, message: '正在下载 Ollama 安装包…' });

    await downloadFile(url, installerPath, ({ received, total, percent }) => {
      _installProgress.percent = percent;
      onProgress?.({ stage: 'downloading', percent, received, total, message: `下载中 ${percent}%` });
    });

    // 阶段 2：安装
    _installProgress.stage = 'installing';
    _installProgress.percent = 0;
    onProgress?.({ stage: 'installing', percent: 0, message: '正在安装 Ollama…' });

    if (platform === 'win32') {
      // Windows: 静默安装
      await runCmd(`"${installerPath}" /S`, { timeout: 120000 });
    } else if (platform === 'darwin') {
      // macOS: 解压到 /Applications
      await runCmd(`unzip -o "${installerPath}" -d /Applications/`, { timeout: 60000 });
      // 创建软链接
      await runCmd('ln -sf /Applications/Ollama.app/Contents/Resources/ollama /usr/local/bin/ollama', { timeout: 10000 }).catch(() => {});
    } else {
      // Linux: 解压
      await runCmd(`tar -xzf "${installerPath}" -C /usr/local/`, { timeout: 60000 });
    }

    _installProgress.percent = 100;
    onProgress?.({ stage: 'installing', percent: 100, message: '安装完成' });

    // 阶段 3：启动服务
    _installProgress.stage = 'starting';
    onProgress?.({ stage: 'starting', percent: 0, message: '正在启动 Ollama 服务…' });
    await startOllamaService();
    onProgress?.({ stage: 'starting', percent: 100, message: 'Ollama 服务已启动' });

    // 阶段 4：验证
    _installProgress.stage = 'verifying';
    onProgress?.({ stage: 'verifying', percent: 0, message: '正在验证安装…' });
    await new Promise((r) => setTimeout(r, 3000));
    const version = await getOllamaVersion();
    if (!version) throw new Error('Ollama 安装后无法检测到版本，可能需要重启应用');
    onProgress?.({ stage: 'verifying', percent: 100, message: `验证成功，Ollama ${version}` });

    setSetting('ollama_installed', '1');
    setSetting('ollama_install_path', installerPath);

    _installProgress = null;
    return { success: true, version, installerPath };
  } catch (e) {
    _installProgress = null;
    throw e;
  }
}

/**
 * 启动 Ollama 服务
 */
export async function startOllamaService() {
  const platform = getPlatform();
  try {
    if (platform === 'win32') {
      // Windows: 通过 ollama app 或直接启动服务
      spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      // macOS: 启动应用
      spawn('open', ['/Applications/Ollama.app'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Linux: 启动服务
      spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref();
    }
    // 等待服务启动
    await new Promise((r) => setTimeout(r, 5000));
  } catch { /* ignore */ }
}

/**
 * 获取 Ollama 版本
 */
export async function getOllamaVersion() {
  try {
    const { stdout } = await runCmd('ollama --version', { timeout: 5000 });
    const m = stdout.match(/version\s+([\d.]+)/i);
    return m ? m[1] : stdout;
  } catch {
    return null;
  }
}

/**
 * 拉取模型（带进度）
 */
export async function pullModel(modelName, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ollama', ['pull', modelName], { stdio: ['ignore', 'pipe', 'pipe'] });

    let buffer = '';
    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (onProgress && obj.status) {
            const percent = obj.total ? Math.round((obj.completed / obj.total) * 100) : 0;
            onProgress({ status: obj.status, percent, completed: obj.completed, total: obj.total });
          }
        } catch { /* not JSON */ }
      }
    });

    proc.on('close', (code) => {
      if (code === 0) resolve({ success: true, model: modelName });
      else reject(new Error(`模型拉取失败，退出码 ${code}`));
    });

    proc.on('error', reject);
  });
}

/**
 * 获取安装状态
 */
export function getInstallStatus() {
  return _installProgress || { stage: 'idle', percent: 0 };
}

/**
 * 获取推荐模型列表
 */
export function getRecommendedModels() {
  return RECOMMENDED_MODELS;
}

export { RECOMMENDED_MODELS };
