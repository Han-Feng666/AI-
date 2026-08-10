@echo off
setlocal
chcp 65001 >nul
title AI Novel Studio - One-Click Packager
echo ================================================
echo   AI Novel Studio - One-Click Packager
echo ================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-installer.ps1"
if errorlevel 1 (
  echo.
  echo Build FAILED.
  echo Please copy the window contents, or the last 50 lines of the log file:
  echo   %~dp0desktop\release\build-log.txt
  echo Send that to me and I will fix it.
)
echo.
pause
