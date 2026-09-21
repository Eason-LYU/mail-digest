@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo   Restore the ledger from a backup
echo ================================================================
echo   A backup is written automatically before every save, so a
echo   mistake (file deleted, bad overwrite) is recoverable.
echo   Backups live in: .state\backups\
echo.
echo   This lists them and lets you pick one to bring back.
echo ================================================================
echo.
call "%~dp0run-node.cmd" "%~dp0tools\restore-state.mjs"
echo.
pause >nul