@echo off
cd /d "%~dp0"
title Sender-Number Admin (Server)
echo ==========================================
echo  Starting server: http://localhost:3000
echo  Keep this window OPEN. Close it to stop.
echo ==========================================
taskkill /F /IM node.exe >nul 2>&1
set NHN_SUBMIT=1
node server.js
echo.
echo Server stopped. You can close this window.
pause
