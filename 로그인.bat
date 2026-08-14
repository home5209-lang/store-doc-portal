@echo off
cd /d "%~dp0"
title Sender-Number Admin (NHN Login)
echo ==========================================
echo  Re-capture NHN login session
echo ==========================================
echo Stopping server...
taskkill /F /IM node.exe >nul 2>&1
echo.
echo A browser will open. Log in to NHN Cloud,
echo then come back here and press Enter.
echo.
node nhn/capture-session.js
echo.
echo Done. Now start the server (double-click the run file).
pause
