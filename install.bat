@echo off
setlocal EnableExtensions EnableDelayedExpansion
title HEXART.PL/AfterALL - Installer

REM ==========================================================
REM   HEXART.PL/AfterALL
REM   Adobe After Effects CEP plugin installer
REM
REM   Idempotent: safe to run multiple times.
REM   Prefers junction (no admin needed) -> symlink -> file copy.
REM ==========================================================

set "EXTENSION_NAME=pl.hexart.afterall"
set "LEGACY_NAME=com.aisist.agent.ae"
set "EXT_DIR=%APPDATA%\Adobe\CEP\extensions"
set "DEST_DIR=%EXT_DIR%\%EXTENSION_NAME%"
set "LEGACY_DIR=%EXT_DIR%\%LEGACY_NAME%"

REM %~dp0 always ends with a backslash. Strip it for cleaner display.
set "SRC_DIR=%~dp0"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"

echo ============================================================
echo   HEXART.PL/AfterALL  -  Installer for Adobe After Effects
echo ============================================================
echo.
echo   Source:      %SRC_DIR%
echo   Destination: %DEST_DIR%
echo.

REM ----------------------------------------------------------
REM [1/5] Enable Adobe CEP developer mode (PlayerDebugMode=1)
REM ----------------------------------------------------------
echo [1/5] Enabling CEP developer mode (PlayerDebugMode)...
for /L %%G in (9,1,20) do (
    reg add "HKCU\Software\Adobe\CSXS.%%G" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
)
echo       Done.
echo.

REM ----------------------------------------------------------
REM [2/5] Remove legacy installation (old name)
REM ----------------------------------------------------------
echo [2/5] Checking for legacy installation (%LEGACY_NAME%) ...
if exist "%LEGACY_DIR%" (
    call :remove_extension "%LEGACY_DIR%"
) else (
    echo       None found.
)
echo.

REM ----------------------------------------------------------
REM [3/5] Remove previous instance of the new extension name
REM ----------------------------------------------------------
echo [3/5] Checking for existing installation ...
if exist "%DEST_DIR%" (
    call :remove_extension "%DEST_DIR%"
) else (
    echo       None found.
)
echo.

REM ----------------------------------------------------------
REM [4/5] Install (junction preferred, falls back to copy)
REM ----------------------------------------------------------
echo [4/5] Installing plugin ...
if /I "%SRC_DIR%"=="%DEST_DIR%" (
    echo       Source and destination are identical. Nothing to do.
    goto :cleanup
)

if not exist "%EXT_DIR%" mkdir "%EXT_DIR%" >nul 2>&1

REM Try junction first - works without admin rights on local NTFS volumes.
mklink /J "%DEST_DIR%" "%SRC_DIR%" >nul 2>&1
if not errorlevel 1 (
    echo       Junction created: %DEST_DIR%
    echo       (edits in source are reflected immediately in AE)
    goto :cleanup
)

echo       Junction creation failed. Trying symbolic link ...
mklink /D "%DEST_DIR%" "%SRC_DIR%" >nul 2>&1
if not errorlevel 1 (
    echo       Symbolic link created: %DEST_DIR%
    goto :cleanup
)

echo       Symbolic link also failed (no admin / disabled policy).
echo       Falling back to file copy ...
if not exist "%DEST_DIR%" mkdir "%DEST_DIR%" >nul 2>&1
robocopy "%SRC_DIR%" "%DEST_DIR%" /E /XC /XN /XO /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /NC /NS ^
    /XD ".git" ".vscode" "node_modules" "python_envs" "docs" "mcp-server\node_modules" ^
    /XF "install.bat" "uninstall.bat" "fix_extension_name.bat" "INSTRUKCJA_INSTALACJI.md" >nul
if errorlevel 8 (
    echo       ERROR: robocopy reported errors. Check the destination manually.
) else (
    echo       Files copied to %DEST_DIR%
)
echo.

REM ----------------------------------------------------------
REM [5/5] Clear CEP / AE extension caches
REM ----------------------------------------------------------
:cleanup
echo.
echo [5/5] Clearing Adobe CEP cache ...
if exist "%APPDATA%\Adobe\CEP\Cache" rmdir /S /Q "%APPDATA%\Adobe\CEP\Cache" >nul 2>&1
for /D %%G in ("%APPDATA%\Adobe\After Effects*") do (
    if exist "%%~G\extensions-cache" rmdir /S /Q "%%~G\extensions-cache" >nul 2>&1
)
echo       Cache cleared.
echo.

echo ============================================================
echo   Installation complete.
echo ============================================================
echo   Location: %DEST_DIR%
echo.
echo   NEXT STEPS:
echo     1. Close Adobe After Effects COMPLETELY (check Task Manager).
echo     2. Start AE again.
echo     3. Open: Window ^> Extensions ^> HEXART.PL/AfterALL
echo.
pause
endlocal
exit /b 0


REM ==========================================================
REM   :remove_extension  <full_path>
REM
REM   Detects whether the given path is a reparse point
REM   (junction / symlink -> rmdir removes only the link)
REM   or a real folder (rmdir /S /Q removes the contents).
REM   Safe with paths that contain spaces.
REM ==========================================================
:remove_extension
set "TARGET=%~1"
echo       Found: %TARGET%

REM `dir /AL /B` in the PARENT lists only reparse points (junctions, symlinks)
REM by basename. If our basename shows up, the entry is a link.
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
    echo                Close After Effects and any open shells in that folder.
)
exit /b 0
