@echo off
cd /d "%~dp0"
echo ==== %date% %time% ==== >> logs\agendamento_watcher.log
git pull --ff-only >> logs\agendamento_watcher.log 2>&1
".venv\Scripts\python.exe" -m robots.agendamento_watcher >> logs\agendamento_watcher.log 2>&1
echo. >> logs\agendamento_watcher.log
