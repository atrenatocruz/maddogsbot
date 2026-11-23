@echo off
cd /d "%~dp0"
:loop
node src\index.js
echo Bot parou, a reiniciar em 5s...
timeout /t 5 >nul
goto loop
