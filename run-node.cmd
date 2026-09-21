@echo off
rem Internal helper: run a Node script with either the bundled runtime or the
rem node.exe found on PATH. Every other launcher calls this, so you only have
rem to get Node working in one place.
rem
rem   run-node.cmd <script.js> [args...]
setlocal
set "EXE=%~dp0runtime\node.exe"
if not exist "%EXE%" set "EXE=node"
"%EXE%" %*
exit /b %ERRORLEVEL%