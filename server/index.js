import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './src/routes.js';
import { ensureRoot } from './src/storage.js';
import { clearZombieJobs } from './src/jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 全局兜底：任何未捕获异常/拒绝都记录日志但保持进程存活，避免"点哪都没反应/Network Error"
const CRASH_LOG = path.join(__dirname, '..', 'server-crash.log');
process.on('uncaughtException', (err) => {
  const line = `[${new Date().toISOString()}] uncaughtException: ${(err && err.stack) || err}\n`;
  console.error(line);
  try { fs.appendFileSync(CRASH_LOG, line); } catch {}
});
process.on('unhandledRejection', (reason) => {
  const line = `[${new Date().toISOString()}] unhandledRejection: ${reason}\n`;
  console.error(line);
  try { fs.appendFileSync(CRASH_LOG, line); } catch {}
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '200mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'novel-studio-server' }));
app.use('/api', routes);

// 生产模式静态托管前端构建产物（Electron 桌面应用直接加载本机地址）
const distDir = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((req, res) => res.status(404).json({ error: '接口不存在' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体解析失败' });
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

ensureRoot().then(() => {
  const cleaned = clearZombieJobs();
  if (cleaned) console.log(`[startup] 清理 ${cleaned} 个残留任务`);
  app.listen(PORT, () => {
    console.log(`Novel Studio server running at http://localhost:${PORT}`);
  });
});
