@echo off
title Stop PocketPigeon Relay
powershell -NoProfile -Command "$conns = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue; if (-not $conns) { Write-Host 'The relay is not running.'; exit 0 }; foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host 'PocketPigeon relay stopped.'"
timeout /t 2 >nul
