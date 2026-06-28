@echo off
echo DynamicMarket ビルドを開始します...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
if %ERRORLEVEL% neq 0 pause
