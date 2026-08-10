#!/bin/bash
# AI 小说工坊 启动脚本
# 用法: ./start.sh [port]

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-3001}"

echo "启动后端服务 (端口 ${PORT})..."
(cd "$ROOT/server" && PORT=$PORT node --no-warnings=ExperimentalWarning index.js) &
SERVER_PID=$!

cleanup() {
  echo "正在停止服务..."
  kill $SERVER_PID 2>/dev/null || true
  exit 0
}
trap cleanup EXIT INT TERM

echo "后端已启动: http://localhost:${PORT}"
echo "启动前端 (http://localhost:5173)..."

(cd "$ROOT/web" && VITE_API_PROXY_TARGET="http://localhost:${PORT}" npm run dev) &
WEB_PID=$!

wait
