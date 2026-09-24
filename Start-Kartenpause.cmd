@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Bitte zuerst Node.js 24 oder neuer installieren.
  pause
  exit /b 1
)
if not exist "node_modules\vite\bin\vite.js" (
  call npm.cmd ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Kartenpause startet im Browser. Dieses Fenster offen lassen.
echo Zum Beenden Strg+C druecken.
call npm.cmd run dev -- --host 127.0.0.1 --open
if errorlevel 1 pause
