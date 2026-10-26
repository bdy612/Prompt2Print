@echo off
rem Prompt2Print print agent: runs on the PC next to the printers (needs Node.js 22+ from https://nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
if not exist config.json (
  echo config.json is missing. Copy config.example.json to config.json and paste your Supabase keys.
  pause
  exit /b 1
)
:loop
node --disable-warning=ExperimentalWarning index.js
echo The agent stopped. Restarting in 10 seconds (close this window to stop)...
timeout /t 10 /nobreak >nul
goto loop
