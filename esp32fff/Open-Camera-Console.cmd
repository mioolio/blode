@echo off
cd /d "%~dp0"
if exist "..\tools\python\Scripts\python.exe" (
  "..\tools\python\Scripts\python.exe" "%~dp0launch_console.py"
) else (
  python "%~dp0launch_console.py"
)
if errorlevel 1 pause
