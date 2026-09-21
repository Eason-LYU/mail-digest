@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal EnableExtensions
echo ================================================================
echo   DeepSeek API key setup
echo ================================================================
echo   Paste your key below (it looks like sk-xxxxxxxx).
echo   Get one at https://platform.deepseek.com/api_keys
echo   Right-click in this window to paste.
echo.
echo   Skip this if you are happy with the free Google translation
echo   channel - but the action summary needs DeepSeek.
echo ================================================================
echo.
set "KEY="
set /p "KEY=DeepSeek API key: "
if "%KEY%"=="" (
  echo.
  echo   [X] Nothing entered - nothing changed.
  pause
  exit /b 1
)
set "DEEPSEEK_KEY=%KEY%"
call "%~dp0run-node.cmd" "%~dp0tools\set-key.mjs"
if errorlevel 1 goto failed
echo.
echo   Verifying with a real API call ...
call "%~dp0run-node.cmd" "%~dp0tools\verify-key.mjs"
if errorlevel 1 goto failed
echo.
echo   SUCCESS - digests will now use DeepSeek.
pause >nul
exit /b 0
:failed
echo.
echo   FAILED - see the message above, then run this file again.
pause >nul
exit /b 1