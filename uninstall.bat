@echo off
setlocal EnableExtensions EnableDelayedExpansion
title HEXART.PL/AfterALL - Uninstaller

REM ==========================================================
REM   HEXART.PL/AfterALL - Adobe After Effects CEP plugin
REM   Uninstaller (idempotent, source folder is NEVER touched)
REM ==========================================================

set "EXTENSION_NAME=pl.hexart.afterall"
set "LEGACY_NAME=com.aisist.agent.ae"
set "EXT_DIR=%APPDATA%\Adobe\CEP\extensions"
set "DEST_DIR=%EXT_DIR%\%EXTENSION_NAME%"
set "LEGACY_DIR=%EXT_DIR%\%LEGACY_NAME%"

echo ============================================================
echo   HEXART.PL/AfterALL  -  Uninstaller
echo ============================================================
echo.
echo   This will remove the plugin entry from:
echo     %EXT_DIR%
echo.
echo   Your source folder is NEVER deleted - even if it is
echo   currently exposed to AE as a junction or symlink, only
echo   the link is removed.
echo.
choice /C YN /N /M "Continue? (Y/N): "
if errorlevel 2 (
    echo Aborted.
    exit /b 1
)
echo.

echo [1/2] Removing extension entries ...
if exist "%DEST_DIR%"   call :remove_extension "%DEST_DIR%"
if exist "%LEGACY_DIR%" call :remove_extension "%LEGACY_DIR%"
echo.

echo [2/2] Clearing Adobe CEP cache ...
if exist "%APPDATA%\Adobe\CEP\Cache" rmdir /S /Q "%APPDATA%\Adobe\CEP\Cache" >nul 2>&1
for /D %%G in ("%APPDATA%\Adobe\After Effects*") do (
    if exist "%%~G\extensions-cache" rmdir /S /Q "%%~G\extensions-cache" >nul 2>&1
)
echo       Cache cleared.
echo.

echo ============================================================
echo   Uninstall complete.
echo ============================================================
echo.
pause
endlocal
exit /b 0


REM ==========================================================
REM   :remove_extension <full_path>
REM   Detects junction / symlink vs regular folder.
REM ==========================================================
:remove_extension
set "TARGET=%~1"
echo       Found: %TARGET%

set "IS_LINK=0"
for /F "delims=" %%R in ('dir /AL /B "%~dp1" 2^>nul') do (
    if /I "%%~R"=="%~nx1" set "IS_LINK=1"
)

if "!IS_LINK!"=="1" (
    echo       Detected: junction/symlink. Removing link only - source preserved.
    rmdir "%TARGET%" >nul 2>&1
) else (
    echo       Detected: regular folder. Deleting contents ...
    rmdir /S /Q "%TARGET%" >nul 2>&1
)

if exist "%TARGET%" (
    echo       WARNING: could not remove %TARGET%
    echo                Close After Effects and try again.
)
exit /b 0
