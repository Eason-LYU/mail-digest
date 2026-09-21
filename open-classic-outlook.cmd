@echo off
chcp 65001 >nul
echo ================================================================
echo   Launch CLASSIC Outlook (OUTLOOK.EXE, not the new web app)
echo ================================================================
echo   This tool needs classic Outlook for Windows to be installed
echo   and signed in to the mailbox you want digested.
echo ================================================================
echo.
start "" "C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE"
echo   If nothing happened, classic Outlook is not installed at the
echo   usual path - open it from the Start menu instead.
echo.
pause >nul