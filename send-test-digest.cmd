@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo   SEND A REAL DIGEST NOW - reads the last 24 hours and sends it
echo ================================================================
echo   Use this to confirm the whole chain works end to end.
echo   If a dialog asks whether a program may send mail, click Allow.
echo ================================================================
echo.
if not exist logs mkdir logs
call "%~dp0run-node.cmd" "%~dp0main-outlook.mjs" --hours 24 >> "logs\send-test.log" 2>&1
set CODE=%ERRORLEVEL%
type "logs\send-test.log"
echo.
echo ----------------------------------------------------------------
echo   Exit code: %CODE%   (0 = sent)
echo   Now check the digest mailbox (and the spam folder).
echo ----------------------------------------------------------------
pause >nul