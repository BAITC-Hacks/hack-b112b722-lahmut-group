@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Python environment .venv is missing. See README.md.
  pause
  exit /b 1
)
echo Khattama: http://127.0.0.1:8000
echo Telegram uses the settings from .env. Keep this window open.
".venv\Scripts\python.exe" -m backend --port 8000
pause
