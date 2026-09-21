@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo   Test the failure notification (takes about 10 seconds)
echo ================================================================
echo   1. create a warning file on the Desktop
echo   2. show a popup for 5 seconds (auto-closes, no click needed)
echo   3. delete the warning file again
echo ================================================================
echo.
pause >nul
set "TESTTXT=%~dp0logs\notify-selftest.txt"
if not exist "%~dp0logs" mkdir "%~dp0logs"
> "%TESTTXT%" echo This is a TEST warning from the failure-notification selftest.
echo Step 1+2: create the file and show the popup ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0notify.ps1" -Mode warn -TextFile "%TESTTXT%" -Seconds 5
echo Step 3: delete the file ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0notify.ps1" -Mode clear
del "%TESTTXT%" >nul 2>&1
echo.
echo   You should have seen a popup and a warning file (now removed).
pause >nul