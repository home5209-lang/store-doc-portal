# =============================================================
#  Sender-Number Admin - Portable distribution bundle builder (Windows only)
#
#  Makes a folder that teammates can just unzip and double-click to run.
#  It bundles: Node runtime, npm packages, and the automation browser.
#
#  Usage (run in the project folder):
#     powershell -ExecutionPolicy Bypass -File .\build-bundle.ps1
#     (this file's actual name may be Korean; run it by its real name)
#
#  Note: run this on a PC where the app already works (node_modules installed).
#  This script is ASCII-only on purpose (avoids Korean-encoding issues in PS 5.1).
# =============================================================

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

Write-Host "== Build portable bundle ==" -ForegroundColor Cyan

# 0) checks
if (-not (Test-Path ".\node_modules")) {
  Write-Host "node_modules not found. Run install first (npm install)." -ForegroundColor Red
  exit 1
}
# NOTE: .env (secrets) is intentionally NOT bundled. Deliver it to teammates separately.
#       The bundle ships .env.example only. See message at the end.

# 1) install automation browser INSIDE the project (so it is bundled)
Write-Host "`n[1/5] Installing automation browser into project..." -ForegroundColor Green
$env:PLAYWRIGHT_BROWSERS_PATH = "0"
npx playwright install chromium

# 2) download portable Node matching this PC's Node version
$nodeVer = (node -v).Trim()   # e.g. v20.11.1
Write-Host "`n[2/5] Downloading portable Node ($nodeVer)..." -ForegroundColor Green
$nodeZip = "$env:TEMP\node-$nodeVer-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/$nodeVer/node-$nodeVer-win-x64.zip"
Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip
$nodeTmp = "$env:TEMP\node-extract"
if (Test-Path $nodeTmp) { Remove-Item $nodeTmp -Recurse -Force }
Expand-Archive -Path $nodeZip -DestinationPath $nodeTmp -Force
$nodeExe = Get-ChildItem -Path $nodeTmp -Filter "node.exe" -Recurse | Select-Object -First 1

# 3) copy app into dist (exclude user data / git / profile ; keep node_modules)
Write-Host "`n[3/5] Copying files..." -ForegroundColor Green
$distRoot = Join-Path $root "dist"
$dist = Join-Path $distRoot "sender-admin"
if (Test-Path $distRoot) { Remove-Item $distRoot -Recurse -Force }
New-Item -ItemType Directory -Path $dist -Force | Out-Null

$exclDirs = @("dist", ".git", "db", "generated", "uploads", "nhn\nhn-profile", "nhn\shots")
$xd = @()
foreach ($d in $exclDirs) { $xd += "/XD"; $xd += (Join-Path $root $d) }
# Exclude secrets / machine-local files. .env is delivered to teammates separately.
$exclFiles = @(".env", "nhn-session.json", "*.sqlite", "*.db")
$xf = @()
foreach ($f in $exclFiles) { $xf += "/XF"; $xf += $f }
robocopy $root $dist /E /NFL /NDL /NJH /NJS /NP @xd @xf | Out-Null
Copy-Item $nodeExe.FullName -Destination (Join-Path $dist "node.exe") -Force

# Safety net: make sure no real .env slipped into the bundle.
$leaked = Join-Path $dist ".env"
if (Test-Path $leaked) { Remove-Item $leaked -Force }
Write-Host ("   .env in bundle? " + (Test-Path $leaked) + " (should be False)") -ForegroundColor Yellow

# 4) create teammate launchers (use bundled node) - English content to avoid cmd encoding issues
Write-Host "`n[4/5] Creating launchers..." -ForegroundColor Green
$startBat = @'
@echo off
cd /d "%~dp0"
title Sender-Number Admin (Server)
set PLAYWRIGHT_BROWSERS_PATH=0
set NHN_SUBMIT=1
if not exist "%~dp0.env" (
  echo ==========================================
  echo  .env file is missing.
  echo  Get the .env from your admin and put it
  echo  in THIS folder next to START.bat, then run again.
  echo ==========================================
  pause
  exit /b
)
echo ==========================================
echo  Sender-Number Admin : http://localhost:3000
echo  Keep this window OPEN. Close it to stop.
echo ==========================================
start "" http://localhost:3000
"%~dp0node.exe" server.js
echo.
echo Server stopped. You can close this window.
pause
'@
$loginBat = @'
@echo off
cd /d "%~dp0"
title Sender-Number Admin (NHN Login)
set PLAYWRIGHT_BROWSERS_PATH=0
echo ==========================================
echo  Create NHN login session
echo ==========================================
echo A browser will open. Log in with YOUR NHN account,
echo then come back here and press Enter.
echo.
"%~dp0node.exe" nhn\capture-session.js
echo.
echo Done. Now start the app with START.bat
pause
'@
[System.IO.File]::WriteAllText((Join-Path $dist "START.bat"), ($startBat -replace "`n","`r`n"))
[System.IO.File]::WriteAllText((Join-Path $dist "NHN-LOGIN.bat"), ($loginBat -replace "`n","`r`n"))

# 5) zip it
Write-Host "`n[5/5] Zipping..." -ForegroundColor Green
$stamp = Get-Date -Format "yyyyMMdd"
$zip = Join-Path $distRoot "sender-admin-dist-$stamp.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$dist\*" -DestinationPath $zip -Force

Write-Host "`n== Done ==" -ForegroundColor Cyan
Write-Host "Bundle zip: $zip" -ForegroundColor Green
Write-Host "This bundle does NOT contain .env (secrets)." -ForegroundColor Yellow
Write-Host "Deliver .env to teammates SEPARATELY (secure channel), and have them put it" -ForegroundColor Yellow
Write-Host "next to START.bat before first run." -ForegroundColor Yellow
Write-Host "Teammates: unzip -> put .env in the folder -> double-click START.bat" -ForegroundColor Green
Write-Host "           (NHN-LOGIN.bat before first NHN submit)." -ForegroundColor Green
