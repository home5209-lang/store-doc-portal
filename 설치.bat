@echo off
cd /d "%~dp0"
title Sender-Number Admin (Setup)
echo ==========================================
echo  First-time setup (run once)
echo ==========================================
echo.
echo [1/3] Installing packages... (may take a few minutes)
call npm install
echo.
echo [2/3] Installing browser for NHN automation...
call npx playwright install chromium
echo.
echo [3/3] Checking .env ...
if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo Created .env from .env.example - ask admin to fill values or replace this file.
  ) else (
    echo WARNING: .env not found. Get the .env file from admin and put it here.
  )
) else (
    echo .env found.
)
echo.
echo Setup done. Next: make sure .env is filled, then run the login file and the run file.
pause
