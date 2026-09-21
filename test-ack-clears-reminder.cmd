@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo   TEST: does an acknowledgement reply clear a key reminder?
echo ================================================================
echo   Step 1  add ONE fake "important reminder" to the pending list
echo   Step 2  send a real digest now (last 2 hours) to your mailbox
echo.
echo   Then, by email:
echo     - Reply to that digest with ONLY the acknowledgement word
echo       (the Chinese word meaning "received"/"noted"),
echo       or send a fresh mail whose subject contains a todo marker
echo     - Then run run-now.cmd again
echo.
echo   Expected next time: the reminder is listed under
echo   "read / no action needed" and gone from the action section,
echo   while every to-do in the ledger is still there.
echo ================================================================
echo.
call "%~dp0run-node.cmd" "%~dp0tools\test-pending.mjs" --add
echo.
echo Sending a digest now (this really sends mail) ...
echo.
call "%~dp0run-node.cmd" "%~dp0main-outlook.mjs" --hours 2
echo.
echo ----------------------------------------------------------------
echo   Now reply to the digest you just received with the single
echo   acknowledgement word, then run run-now.cmd
echo ----------------------------------------------------------------
pause >nul