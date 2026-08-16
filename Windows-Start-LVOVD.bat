@echo off
setlocal
cd /d "%~dp0"
title LVOVD

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo LVOVD needs Node.js 22 or newer before it can start.
  echo Easiest Windows install:
  echo   winget install --id OpenJS.NodeJS.LTS -e
  echo.
  echo After Node finishes installing, close this window and double-click Windows-Start-LVOVD.bat again.
  echo.
  pause
  exit /b 1
)

node scripts\launch.js
set "LVOVD_EXIT=%ERRORLEVEL%"

if not "%LVOVD_EXIT%"=="0" (
  echo.
  echo LVOVD stopped because of an error. See the message above and README.md for setup help.
  echo.
  pause
)

exit /b %LVOVD_EXIT%
