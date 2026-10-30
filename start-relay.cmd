@echo off
title PocketPigeon Relay
cd /d "%~dp0server"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing relay dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo PocketPigeon relay is starting.
echo Keep this window open while you use the extension.
echo.
node server.js

echo.
echo The relay has stopped.
pause
