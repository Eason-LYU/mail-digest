@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo   To-do ledger manager
echo ================================================================
echo   Lists every unfinished to-do collected from your mail (including
echo   ones from days ago) and lets you mark them done.
echo.
echo   Type a number and press Enter to mark that to-do done.
echo   Type a to add one yourself. Press Enter alone to quit.
echo ================================================================
echo.
call "%~dp0run-node.cmd" "%~dp0tools\todos.mjs"
echo.
pause >nul