@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo   CHECK THE OUTLOOK CHANNEL (read only, sends nothing)
echo ================================================================
echo   Reports: Outlook account, inbox size, a few recent messages.
echo   Run this first whenever something looks broken.
echo ================================================================
echo.
if not exist logs mkdir logs
call "%~dp0run-node.cmd" "%~dp0main-outlook.mjs" --check
echo.
echo ----------------------------------------------------------------
echo   Exit code: %ERRORLEVEL%   (0 = channel OK, 2 = Outlook unusable)
echo ----------------------------------------------------------------
pause >nul