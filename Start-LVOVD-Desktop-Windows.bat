@echo off
setlocal
cd /d "%~dp0"
title LVOVD Desktop Preview

where node >nul 2>nul
if errorlevel 1 (
  echo This development preview needs Node.js and the Rust build tools.
  echo See docs\desktop-foundation.md for setup.
  pause
  exit /b 1
)

echo Building the desktop preview. The app will open in its own window.
node scripts\desktop.cjs launch
set "LVOVD_EXIT=%ERRORLEVEL%"
if not "%LVOVD_EXIT%"=="0" (
  echo.
  echo The desktop preview could not start. See the error above and docs\desktop-foundation.md.
  pause
)
exit /b %LVOVD_EXIT%
