@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo   DRY RUN - read mail, build the digest, but DO NOT send anything
echo ================================================================
echo   This is the safest first test: it touches Outlook read-only and
echo   writes the digest to digests\ so you can open it in a browser.
echo   No mail is sent and no state is changed.
echo ================================================================
echo.
if not exist logs mkdir logs
call "%~dp0run-node.cmd" "%~dp0main-outlook.mjs" --dry-run --hours 24
echo.
echo ----------------------------------------------------------------
echo   Exit code: %ERRORLEVEL%   (0 = fine)
echo   Look in the digests\ folder for today's .html file.
echo ----------------------------------------------------------------
pause >nul