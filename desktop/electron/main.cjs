const { app, BrowserWindow, shell, dialog } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');

// 兼容性检查：内置数据库依赖 Electron 运行时中的 node:sqlite
try {
  require('node:sqlite');
} catch (e) {
  dialog.showErrorBox(
    '无法启动',
    '当前 Electron 运行时不支持内置 SQLite（node:sqlite），请升级到 Electron 37 及以上版本。'
  );
  app.quit();
  process.exit(1);
}

const isDev = !!process.env.VITE_DEV_SERVER_URL;

let PORT = Number(process.env.PORT) || 3001;
let serverProc = null;
let mainWindow = null;

// 找一个空闲端口，避免与用户其他程序冲突
function isPortFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(p, '127.0.0.1');
  });
}

async function pickPort() {
  for (let p = PORT; p < PORT + 10; p++) {
    if (await isPortFree(p)) return p;
  }
  return PORT;
}

// 作品存放目录默认放到「文档/AI小说工坊/作品」，用户仍可在设置里自定义到任意盘
function defaultNovelsRoot() {
  try {
    return path.join(app.getPath('documents'), 'AI小说工坊', '作品');
  } catch {
    return '';
  }
}

// 后端入口：开发态为仓库内 server/index.js；打包态为 extraResources 中的 resources/server/index.js
function serverEntry() {
  if (isDev) return path.join(__dirname, '..', '..', 'server', 'index.js');
  return path.join(process.resourcesPath, 'server', 'index.js');
}

function startBackend() {
  return new Promise((resolve, reject) => {
    // 后端日志写入 userData/server.log，便于排查启动失败
    const logFile = path.join(app.getPath('userData'), 'server.log');
    let logFd = null;
    try {
      logFd = fs.openSync(logFile, 'a');
    } catch (e) {
      logFd = null;
    }
    let settled = false;
    let restarts = 0;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      reject(new Error(`${msg}\n\n后端日志文件：${logFile}`));
    };

    const spawn = () => {
      serverProc = fork(serverEntry(), [], {
        env: {
          ...process.env,
          PORT: String(PORT),
          NOVEL_DATA_DIR: app.getPath('userData'),
          NOVELS_ROOT_DEFAULT: defaultNovelsRoot()
        },
        // 自定义 stdio 时 Node 强制要求 fork 必须含 'ipc' 通道
        stdio: logFd ? ['ignore', logFd, logFd, 'ipc'] : 'inherit'
      });
      serverProc.on('error', (err) => {
        fail(`内置服务进程启动失败：${err.message}\n\n可能是安全软件拦截了内置服务，请把本应用加入白名单后重试。`);
      });
      serverProc.on('exit', (code) => {
        const wasSettled = settled;
        const proc = serverProc;
        serverProc = null;
        if (!wasSettled) {
          fail(`内置服务进程异常退出（code=${code ?? '未知'}）。\n\n请打开上面的日志文件，把内容发给我排查。`);
          return;
        }
        // 后端运行中崩溃：自动重启，最多尝试 3 次，避免反复崩溃刷屏
        if (proc && restarts < 3) {
          restarts += 1;
          console.log(`[main] 后端进程退出（code=${code}），${restarts}/3 次自动重启…`);
          try {
            fs.appendFileSync(logFile, `[main] backend exited code=${code}, auto restart ${restarts}/3\n`);
          } catch {}
          setTimeout(spawn, 500);
          // 通知渲染进程：接口暂不可用，马上自动恢复
          try {
            mainWindow && mainWindow.webContents.send('backend-restarting', { attempt: restarts });
          } catch {}
        } else {
          console.log(`[main] 后端进程退出（code=${code}），自动重启次数已用尽`);
          try {
            fs.appendFileSync(logFile, `[main] backend exited code=${code}, restart budget exhausted\n`);
          } catch {}
          try {
            mainWindow && mainWindow.webContents.send('backend-crashed', { code });
          } catch {}
        }
      });
      return serverProc;
    };

    spawn();

    // 轮询健康检查，后端就绪后继续
    const deadline = Date.now() + 20000;
    const poll = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 500 }, (res) => {
        res.resume();
        if (!settled) { settled = true; resolve(); }
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          fail('内置服务启动超时（20 秒未响应）。\n\n请检查 3001-3010 端口是否被占用，或安全软件是否拦截。');
          return;
        }
        setTimeout(poll, 300);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    poll();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'AI 小说工坊',
    backgroundColor: '#f4f5fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  }

  // 渲染诊断：页面加载失败时给出明确提示（避免静默白屏）
  const renderLog = path.join(app.getPath('userData'), 'render.log');
  mainWindow.webContents.on('console-message', (event) => {
    try { fs.appendFileSync(renderLog, `[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})\n`); } catch {}
  });
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    dialog.showErrorBox('页面进程异常', `渲染进程已退出（原因：${details.reason}）。\n\n请把日志文件发我排查：\n${renderLog}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const img = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(app.getPath('userData'), 'screen.png'), img.toPNG());
      } catch {}
    }, 3000);
  });
  mainWindow.webContents.on('did-fail-load', (e, code, desc, validatedURL) => {
    if (code === -3) return; // ERR_ABORTED：导航被新请求替代，属正常
    const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>加载失败</title></head>
<body style="font-family:system-ui;background:#f4f5fb;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:560px;padding:24px">
<h2 style="color:#303133;margin:0 0 8px">页面加载失败</h2>
<p style="color:#909399;line-height:1.7">${String(desc || '未知错误')}</p>
<p style="color:#c0c4cc;font-size:13px;word-break:break-all">${String(validatedURL || '')}</p>
<a href="${String(validatedURL || '')}" style="display:inline-block;margin-top:16px;padding:10px 24px;border-radius:6px;background:#409eff;color:#fff;text-decoration:none">重试</a>
</div></body></html>`;
    mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  PORT = await pickPort();
  try {
    await startBackend();
  } catch (err) {
    dialog.showErrorBox('启动失败', String(err.message || err));
    app.exit(1);
    return;
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
});
