@echo off
chcp 65001 >nul
title AI Novel Studio - Build Diagnose
python "%~dp0check_build.py"
