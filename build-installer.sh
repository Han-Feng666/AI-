#!/bin/bash
# ============================================================
# AI 小说工坊 - 一键打包安装包（Linux / macOS）
# 用法：双击运行，或执行 ./build-installer.sh
# 产物：desktop/release/ 下的安装包
# 日志：desktop/release/build-log.txt（失败时把最后部分发给我即可）
# ============================================================

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT/desktop/release"
LOG="$LOG_DIR/build-log.txt"
mkdir -p "$LOG_DIR"

echo "================ AI 小说工坊 一键打包 ================"
echo "项目目录：$ROOT"
echo "日志文件：$LOG"

OS="$(uname -s)"
case "$OS" in
  Linux*)  PLATFORM="linux" ;;
  Darwin*) PLATFORM="mac" ;;
  *)       PLATFORM="unknown" ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未检测到 Node.js，请先安装：https://nodejs.org"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "错误：未检测到 npm，请确认 Node.js 安装完整"
  exit 1
fi

echo "系统：$OS → 生成 $PLATFORM 安装包"
echo "Node：$(node -v)  npm：$(npm -v)"

# 步骤封装：实时显示 + 写日志 + 失败中止并提示复制结果
run_step() {
  local name="$1"; shift
  echo ""
  echo ">>> [$name]"
  "$@" 2>&1 | tee -a "$LOG"
  local rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then
    echo ""
    echo "!!! 步骤失败：$name" 
    echo "!!! 请把终端里的内容，或 $LOG 文件最后 50 行复制发给我排查"
    exit 1
  fi
}

run_step "准备后端依赖" npm --prefix "$ROOT/server" install --no-audit --no-fund
run_step "安装前端依赖" npm --prefix "$ROOT/web" install --no-audit --no-fund
run_step "构建前端产物" npm --prefix "$ROOT/web" run build
run_step "安装打包依赖" npm --prefix "$ROOT/desktop" install --no-audit --no-fund

echo ""
echo ">>> [生成 $PLATFORM 安装包]"
cd "$ROOT/desktop"
case "$PLATFORM" in
  linux) npm run prep:linux ;;
  mac)   npm run prep:mac ;;
  *)
    echo "无法识别当前系统类型，请手动执行：cd desktop && npm run prep:win"
    exit 1
    ;;
esac 2>&1 | tee -a "$LOG"
rc=${PIPESTATUS[0]}
if [ "$rc" -ne 0 ]; then
  echo ""
  echo "!!! 打包失败"
  echo "!!! 请把终端里的内容，或 $LOG 文件最后 50 行复制发给我排查"
  exit 1
fi

echo ""
echo "================ 打包完成 ================"
echo "安装包位置："
ls -lh "$ROOT/desktop"/release/*.AppImage "$ROOT/desktop"/release/*.dmg 2>/dev/null || true
ls -lh "$ROOT/desktop"/release/*.exe 2>/dev/null || true
echo ""
echo "可把安装包拷给别人安装使用。双击 .AppImage / .dmg 即可打开。"
