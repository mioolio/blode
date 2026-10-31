@echo off
setlocal
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 or newer for Windows x64.
  pause
  exit /b 1
)
node "%~dp0scripts\build-release.mjs" %*
set "BLODE_RELEASE_EXIT=%ERRORLEVEL%"
echo.
if "%~1"=="" pause
exit /b %BLODE_RELEASE_EXIT%
