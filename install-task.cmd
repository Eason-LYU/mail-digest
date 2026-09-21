@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo   Register the daily scheduled task (default 20:00)
echo ================================================================
echo   Change the time like this:
echo     install-task.cmd -Time 07:30
echo   Remove it like this:
echo     install-task.cmd -Uninstall
echo ================================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-task.ps1" %*
echo.
pause >nul