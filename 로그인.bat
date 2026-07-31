@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 발신번호 등록 관리자 - NHN 로그인

echo ============================================
echo  NHN 로그인 세션을 새로 저장합니다.
echo  (봇이 "로그인 화면으로 튕길 때"만 실행하면 됩니다)
echo ============================================
echo.
echo  서버를 잠시 종료합니다...
taskkill /F /IM node.exe >nul 2>&1
echo.
echo  잠시 후 브라우저가 열립니다.
echo  1) 브라우저에서 NHN Cloud 에 로그인하세요.
echo  2) 프로젝트 화면이 보이면, 이 창으로 돌아와 Enter 를 누르세요.
echo.

node nhn/capture-session.js

echo.
echo  완료! 이제 "실행.bat" 을 더블클릭해 서버를 켜세요.
pause
