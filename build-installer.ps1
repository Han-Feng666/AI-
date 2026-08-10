# AI 小说工坊 - 一键打包安装包（Windows）
# 由 build-installer.bat 双击调用。产物在 desktop\release\，日志在 build-log.txt。
# 不能用 'Stop'：原生命令向 stderr 写警告（如 vite build）会被当成致命错误中断脚本。
$ErrorActionPreference = 'Continue'

$root = $PSScriptRoot
$logDir = Join-Path $root 'desktop\release'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'build-log.txt'
"===== 开始打包 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') =====" | Out-File $log -Encoding utf8

Write-Host "项目目录: $root"
Write-Host "日志文件: $log"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "错误：未检测到 Node.js，请先安装 https://nodejs.org" -ForegroundColor Red
  exit 1
}
Write-Host "Node: $(node -v)"

function Run-Step {
  param([string]$name, [string]$cmdline)
  Write-Host ""
  Write-Host ">>> [$name]"
  & cmd /c $cmdline 2>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) {
      Write-Host ("  [警告] " + $_.ToString()) -ForegroundColor DarkYellow
      ("  [stderr] " + $_.ToString()) | Out-File -FilePath $log -Append -Encoding utf8
    } else {
      Write-Host $_
      $_ | Out-File -FilePath $log -Append -Encoding utf8
    }
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "!!! 步骤失败: $name" -ForegroundColor Red
    Write-Host "!!! 请把本窗口内容，或 $log 最后 50 行复制发给我排查" -ForegroundColor Red
    exit 1
  }
}

Run-Step "准备后端依赖" "npm --prefix `"$root\server`" install --no-audit --no-fund"
Run-Step "安装前端依赖" "npm --prefix `"$root\web`" install --no-audit --no-fund"
Run-Step "构建前端产物" "npm --prefix `"$root\web`" run build"
Run-Step "安装打包依赖" "npm --prefix `"$root\desktop`" install --no-audit --no-fund"
Run-Step "生成 Windows 安装包" "cd /d `"$root\desktop`" && npm run prep:win"

Write-Host ""
Write-Host "================ 打包完成 ================" -ForegroundColor Green
$exe = Get-ChildItem (Join-Path $root 'desktop\release') -Filter '*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($exe) {
  Write-Host "安装包: $($exe.FullName)" -ForegroundColor Cyan
  Write-Host "大小: $([math]::Round($exe.Length / 1MB, 1)) MB"
} else {
  Write-Host "未找到 .exe 产物，请检查日志。" -ForegroundColor Yellow
}
