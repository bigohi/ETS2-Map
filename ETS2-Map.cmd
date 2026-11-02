@echo off
rem Double-click to start the ETS2-Map server. Keep this window open while you drive.
cd /d "%~dp0"
if not exist node_modules\qrcode-terminal call npm install --no-audit --no-fund
node server\server.js %*
pause
