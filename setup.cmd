@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ================================================================
echo   SETUP WIZARD
echo ================================================================
echo   A few questions (asked in Chinese + English) and config.json
echo   is written for you:
echo.
echo     1. primary mailbox   - the mailbox to READ
echo     2. delivery mailbox  - where the digest is SENT
echo     3. whitelist         - who may send to-do commands
echo     4. translation channel + DeepSeek API key (optional)
echo     5. daily run time
echo.
echo   The API key goes into .state\secrets.json - never into
echo   config.json, and never into git.
echo.
echo   Safe to re-run any time to change your settings.
echo ================================================================
echo.

call "%~dp0run-node.cmd" "%~dp0tools\setup.mjs" %*
if errorlevel 1 (
  echo.
  echo   [X] Setup did not finish - nothing was changed.
)

echo.
echo Press any key to close this window.
pause >nul
