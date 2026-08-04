@echo off
cd /d "%~dp0"
echo ==== %date% %time% ==== >> logs\d1_sync.log
git pull --ff-only >> logs\d1_sync.log 2>&1
".venv\Scripts\python.exe" -m robots.d1_sync >> logs\d1_sync.log 2>&1
echo. >> logs\d1_sync.log
