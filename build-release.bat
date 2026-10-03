@echo off
setlocal
set "REPO=%~dp0"
set "DEPLOY=C:\Utilities\stewrd\plugins\stewrd-terminal"

cd /d "%REPO%"
if not exist node_modules call npm install || exit /b 1
call npm run build || exit /b 1
rem /MIR does not purge files excluded from the copy, so drop the stale sourcemap deployed earlier.
if exist "%DEPLOY%\dist\index.js.map" del "%DEPLOY%\dist\index.js.map"

rem storage.json and data\ hold the plugin's runtime state in the deploy folder, so /MIR must not delete them.
robocopy "%REPO%." "%DEPLOY%" /MIR /NFL /NDL /NJH /NP ^
  /XD .git .remember .serena node_modules data ^
  /XF storage.json package.json package-lock.json build-release.bat CLAUDE.md ARCHITECTURE.md *.zip
if %ERRORLEVEL% GEQ 8 exit /b 1
echo Deployed to %DEPLOY%
exit /b 0
