@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo   Run the scheduled task right now (the real production path)
echo ================================================================
echo   Task Scheduler -^> wscript -^> node -^> Outlook -^> DeepSeek -^> send
echo   Exactly what happens every day at the scheduled time.
echo ================================================================
echo.
pause
schtasks /Run /TN "MailDigest-Daily"
if errorlevel 1 (
  echo.
  echo   [X] Could not start the task. Run install-task.cmd first.
  pause
  exit /b 1
)
echo.
echo   Started. Waiting 60 seconds, then showing the tail of logs\task.log ...
timeout /t 60 /nobreak >nul
echo.
schtasks /Query /TN "MailDigest-Daily" /FO LIST /V 2>nul | findstr /C:"Last Run Time" /C:"Last Result" /C:"Next Run Time"
echo.
echo ================================================================
echo   logs\task.log (last 25 lines)
echo ================================================================
powershell -NoProfile -Command "if (Test-Path 'logs\task.log') { Get-Content 'logs\task.log' -Tail 25 -Encoding UTF8 } else { 'no log yet' }"
echo.
pause >nul