@echo off
title Runway Studio
cd /d "%~dp0"

if not exist node_modules (
  echo Dang cai dat dependencies lan dau...
  call npm install --no-fund --no-audit
)

echo.
echo   Dang khoi dong Runway Studio...
echo.

start "" http://localhost:3000
node server.mjs

echo.
echo   Server da dung. Nhan phim bat ky de dong.
pause >nul
