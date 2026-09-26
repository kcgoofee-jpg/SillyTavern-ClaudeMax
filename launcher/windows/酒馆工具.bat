@echo off
rem CCST toolbox (Windows): launcher shell. The menu itself is launcher\menu.mjs, shared with macOS and Termux.
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node "%~dp0..\menu.mjs"
