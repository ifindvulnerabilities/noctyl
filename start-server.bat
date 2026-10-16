@echo off
rem Noctyl server, quick start for Windows.
rem   Keeps the server's data (accounts, encrypted chats and keys) in your Noctyl folder:
rem   %USERPROFILE%\Noctyl\NoctylServerData, or the Noctyl folder you chose in the desktop app.
rem   Asks who can sign in (one account or several), the port, which address to answer on (every address, only this
rem   computer, or one address such as your Tailscale IP), and where Ollama runs (here, or another device: optional).
rem   Skip the questions with NOCTYL_MODE (single, open or admin), NOCTYL_PORT, NOCTYL_HOST (an IP, or 0.0.0.0) and
rem   NOCTYL_OLLAMA (an address, or local); NOCTYL_NO_BROWSER=1 skips opening the browser.
rem   (NOCTYL_ACCESS=local or network from earlier versions still works.)
setlocal EnableExtensions
title Noctyl server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
rem the server's database is the SQLite built into Node 22.13 and newer
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto oldnode

set "DATA="
for /f "usebackq delims=" %%P in (`node server\paths.js`) do set "DATA=%%P"
if defined NOCTYL_SERVER_DATA set "DATA=%NOCTYL_SERVER_DATA%"
if not defined DATA set "DATA=%USERPROFILE%\Noctyl\NoctylServerData"

echo Noctyl server
echo Data folder: %DATA%
echo Press Ctrl+C at any question to cancel.

rem The questions are asked by server\ask.js (the same as start-server.sh). Ctrl+C at any of them answers CANCEL:
rem then nothing is started.

rem ---------- who can sign in ----------
set "MODE="
for /f "usebackq delims=" %%M in (`node server\ask.js mode "%DATA%"`) do set "MODE=%%M"
if "%MODE%"=="CANCEL" goto cancelled
if not defined MODE goto cancelled

rem ---------- port ----------
set "PORT="
for /f "usebackq delims=" %%P in (`node server\ask.js port`) do set "PORT=%%P"
if "%PORT%"=="CANCEL" goto cancelled
if not defined PORT goto cancelled

rem ---------- which address to answer on ----------
set "HOST=%NOCTYL_HOST%"
if /i "%NOCTYL_ACCESS%"=="local" if not defined HOST set "HOST=127.0.0.1"
if /i "%NOCTYL_ACCESS%"=="network" if not defined HOST set "HOST=0.0.0.0"
if defined HOST goto ollama
for /f "usebackq delims=" %%H in (`node server\ask.js host`) do set "HOST=%%H"
if "%HOST%"=="CANCEL" goto cancelled
if not defined HOST goto cancelled

rem ---------- where Ollama runs (optional) ----------
:ollama
set "OLLAMA="
for /f "usebackq delims=" %%O in (`node server\ask.js ollama "%DATA%"`) do set "OLLAMA=%%O"
if "%OLLAMA%"=="CANCEL" goto cancelled
if not defined OLLAMA goto cancelled

:start
set "OPEN="
for /f "usebackq delims=" %%U in (`node server\ask.js open %HOST% %PORT%`) do set "OPEN=%%U"
echo.
if not "%HOST%"=="127.0.0.1" echo   Before you open it to the internet, put it behind HTTPS (on Tailscale: tailscale serve).
echo   Opening %OPEN%/login in your browser. Keep this window open; press Ctrl+C to stop the server.
echo.
if not defined NOCTYL_NO_BROWSER start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%OPEN%/login'"
node server\index.js --data "%DATA%" --port %PORT% --host %HOST% --mode %MODE% --ollama "%OLLAMA%"
echo.
echo   The server stopped.
pause
exit /b 0

:cancelled
rem Ctrl+C at a question (ask.js already said "Cancelled. Nothing was started.")
exit /b 130

:oldnode
echo.
echo   The Noctyl server needs Node.js 22.13 or newer. Install the current LTS from https://nodejs.org, then run this again.
echo.
pause
exit /b 1

:nonode
echo.
echo   Noctyl needs Node.js. Install the LTS version from https://nodejs.org, then run this again.
echo.
pause
exit /b 1
