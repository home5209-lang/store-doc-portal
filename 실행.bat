@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 발신번호 등록 관리자 - 서버

echo ============================================
echo  발신번호 등록 관리자 서버를 시작합니다.
echo ============================================
echo.

rem 이전에 켜져 있던 서버(node)를 정리 (프로필 잠금/포트 충돌 방지)
taskkill /F /IM node.exe >nul 2>&1

rem 실제 제출 모드 ON (버튼 클릭 시 NHN에 실제 심사요청까지 진행)
set NHN_SUBMIT=1

node server.js

echo.
echo (서버가 종료되었습니다. 이 창은 닫아도 됩니다.)
pause
