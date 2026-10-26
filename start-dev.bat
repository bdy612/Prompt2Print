@echo off
rem Runs Prompt2Print from this source folder (needs Node.js 22.13+ from https://nodejs.org).
rem Inside Program Files the folder is read-only, so the data goes to the same place the installed
rem app uses (%LOCALAPPDATA%\Prompt2Print\data): edits to the source show up with the same shop data.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
if "%P2P_DATA_DIR%"=="" (
  mkdir storage >nul 2>nul
  echo. > storage\.write-test 2>nul
  if exist storage\.write-test (
    del storage\.write-test >nul 2>nul
  ) else (
    set "P2P_DATA_DIR=%LOCALAPPDATA%\Prompt2Print\data"
  )
)
set "P2P_DESKTOP=1"
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:3939"
node --disable-warning=ExperimentalWarning server\index.js
pause
