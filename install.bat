@echo off
setlocal EnableExtensions EnableDelayedExpansion
title HEXART.PL/AfterALL - Installer / Manager

REM ==========================================================
REM   HEXART.PL/AfterALL  -  Interactive installer / manager
REM
REM   Menu-driven script with color output. Scenarios:
REM     1. Install (junction)        - dev workflow, edits live
REM     2. Install (file copy)       - production-safe snapshot
REM     3. Reinstall                 - remove + install junction
REM     4. Uninstall                 - remove plugin only
REM     5. Factory reset             - uninstall + WIPE config
REM     6. Clear cache only          - CEP / AE caches
REM     7. Diagnose                  - print full state
REM     0. Exit
REM ==========================================================

REM ---------- ANSI color setup --------------------------------
REM Enable VT100 in HKCU\Console (idempotent, harmless if already on)
reg add "HKCU\Console" /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>&1
REM Capture the ESC char (0x1B) via the classic prompt trick
for /F "delims=" %%E in ('echo prompt $E ^| cmd') do set "ESC=%%E"
set "C_RESET=%ESC%[0m"
set "C_BOLD=%ESC%[1m"
set "C_DIM=%ESC%[2m"
set "C_RED=%ESC%[91m"
set "C_GREEN=%ESC%[92m"
set "C_YELLOW=%ESC%[93m"
set "C_BLUE=%ESC%[94m"
set "C_MAGENTA=%ESC%[95m"
set "C_CYAN=%ESC%[96m"
set "C_GRAY=%ESC%[90m"

REM ---------- Constants ---------------------------------------
set "EXTENSION_NAME=pl.hexart.afterall"
set "LEGACY_NAME=com.aisist.agent.ae"
set "EXT_DIR=%APPDATA%\Adobe\CEP\extensions"
set "DEST_DIR=%EXT_DIR%\%EXTENSION_NAME%"
set "LEGACY_DIR=%EXT_DIR%\%LEGACY_NAME%"
set "DATA_FILE=%USERPROFILE%\.hexart_afterall_data.json"
set "LEGACY_DATA_FILE=%USERPROFILE%\.aisist_ae_data.json"
set "CEP_CACHE=%APPDATA%\Adobe\CEP\Cache"

set "SRC_DIR=%~dp0"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"

REM ===========================================================
REM                    MAIN MENU LOOP
REM ===========================================================
:menu_loop
call :show_banner
call :show_current_state
call :show_menu

set "CHOICE="
set /p "CHOICE=  %C_BOLD%Choose [0-7]:%C_RESET% "
echo.

if "%CHOICE%"=="1" call :action_install junction
if "%CHOICE%"=="2" call :action_install copy
if "%CHOICE%"=="3" call :action_reinstall
if "%CHOICE%"=="4" call :action_uninstall
if "%CHOICE%"=="5" call :action_factory_reset
if "%CHOICE%"=="6" call :action_clear_cache
if "%CHOICE%"=="7" call :action_diagnose
if "%CHOICE%"=="0" goto :exit_clean

if not "%CHOICE%"=="1" if not "%CHOICE%"=="2" if not "%CHOICE%"=="3" if not "%CHOICE%"=="4" if not "%CHOICE%"=="5" if not "%CHOICE%"=="6" if not "%CHOICE%"=="7" if not "%CHOICE%"=="0" (
    echo %C_RED%  Invalid choice: %CHOICE%%C_RESET%
)

echo.
echo %C_GRAY%  ----------------------------------------------------------%C_RESET%
pause
goto :menu_loop


:exit_clean
echo.
echo %C_GREEN%  Goodbye!%C_RESET%
echo.
endlocal
exit /b 0


REM ===========================================================
REM                    HEADER / BANNER
REM ===========================================================
:show_banner
cls
echo.
echo %C_CYAN%%C_BOLD%   ============================================================%C_RESET%
echo %C_CYAN%%C_BOLD%     HEXART.PL/AfterALL  -  AI Motion Designer for AE%C_RESET%
echo %C_CYAN%%C_BOLD%     Installer / Manager%C_RESET%
echo %C_CYAN%%C_BOLD%   ============================================================%C_RESET%
echo.
goto :eof


REM ===========================================================
REM     SHOW CURRENT STATE  (installed? junction? config?)
REM ===========================================================
:show_current_state
echo   %C_BOLD%Current state%C_RESET%
echo   %C_GRAY%----------------------------------------------------------%C_RESET%
set "STATE_NEW=none"
if exist "%DEST_DIR%" (
    set "IS_LINK=0"
    for /F "delims=" %%R in ('dir /AL /B "%EXT_DIR%" 2^>nul') do (
        if /I "%%~R"=="%EXTENSION_NAME%" set "IS_LINK=1"
    )
    if "!IS_LINK!"=="1" (
        set "STATE_NEW=junction"
    ) else (
        set "STATE_NEW=copy"
    )
)

if "%STATE_NEW%"=="none" (
    echo     %C_GRAY%* Plugin not installed.%C_RESET%
) else if "%STATE_NEW%"=="junction" (
    echo     %C_GREEN%* Installed via junction%C_RESET% %C_DIM%(dev mode - edits in source apply instantly)%C_RESET%
    echo       %C_GRAY%%DEST_DIR%%C_RESET%
) else (
    echo     %C_GREEN%* Installed as full copy%C_RESET% %C_DIM%(production mode)%C_RESET%
    echo       %C_GRAY%%DEST_DIR%%C_RESET%
)

REM Legacy install (old name)
if exist "%LEGACY_DIR%" (
    echo     %C_YELLOW%! Legacy install detected:%C_RESET% %C_GRAY%%LEGACY_DIR%%C_RESET%
)

REM Stored config / API keys
if exist "%DATA_FILE%" (
    echo     %C_BLUE%* Config file present%C_RESET% %C_DIM%(API keys, settings)%C_RESET%
    echo       %C_GRAY%%DATA_FILE%%C_RESET%
) else if exist "%LEGACY_DATA_FILE%" (
    echo     %C_YELLOW%! Legacy config file present%C_RESET%
    echo       %C_GRAY%%LEGACY_DATA_FILE%%C_RESET%
) else (
    echo     %C_GRAY%* No config file yet.%C_RESET%
)

echo.
echo   %C_BOLD%Source repo%C_RESET%
echo   %C_GRAY%----------------------------------------------------------%C_RESET%
echo     %C_GRAY%%SRC_DIR%%C_RESET%
echo.
goto :eof


REM ===========================================================
REM                    MENU
REM ===========================================================
:show_menu
echo   %C_BOLD%What would you like to do?%C_RESET%
echo   %C_GRAY%----------------------------------------------------------%C_RESET%
echo     %C_GREEN%1%C_RESET%  Install ^(junction^)         %C_DIM%recommended for dev workflow%C_RESET%
echo     %C_GREEN%2%C_RESET%  Install ^(file copy^)        %C_DIM%production: independent of source%C_RESET%
echo     %C_CYAN%3%C_RESET%  Reinstall                  %C_DIM%remove existing + install junction%C_RESET%
echo     %C_YELLOW%4%C_RESET%  Uninstall                  %C_DIM%remove plugin, KEEP config and keys%C_RESET%
echo     %C_RED%5%C_RESET%  Factory reset              %C_DIM%uninstall + WIPE config + WIPE keys%C_RESET%
echo     %C_BLUE%6%C_RESET%  Clear cache only           %C_DIM%CEP + AE extension caches%C_RESET%
echo     %C_MAGENTA%7%C_RESET%  Diagnose                   %C_DIM%print every path and state%C_RESET%
echo.
echo     %C_GRAY%0  Exit%C_RESET%
echo.
goto :eof


REM ===========================================================
REM   ACTION: install ^<mode^>      mode = "junction" | "copy"
REM ===========================================================
:action_install
set "MODE=%~1"
echo %C_BOLD%%C_CYAN%>>>  INSTALL ^(mode: %MODE%^)%C_RESET%
echo.

if exist "%DEST_DIR%" (
    echo   %C_YELLOW%An existing installation was detected:%C_RESET%
    echo     %C_GRAY%%DEST_DIR%%C_RESET%
    echo.
    echo   The installer will %C_BOLD%remove it first%C_RESET%, then install fresh.
    call :confirm "Continue?" || goto :eof
    call :do_remove_extension "%DEST_DIR%"
    echo.
)

call :ensure_dev_mode

if exist "%LEGACY_DIR%" (
    echo   %C_YELLOW%Removing legacy install %LEGACY_NAME% ...%C_RESET%
    call :do_remove_extension "%LEGACY_DIR%"
    echo.
)

if not exist "%EXT_DIR%" mkdir "%EXT_DIR%" >nul 2>&1

if /I "%MODE%"=="junction" (
    call :do_install_junction
) else (
    call :do_install_copy
)

call :do_clear_cep_cache
call :show_post_install_note
goto :eof


REM ===========================================================
REM   ACTION: reinstall
REM ===========================================================
:action_reinstall
echo %C_BOLD%%C_CYAN%>>>  REINSTALL%C_RESET%
echo.
if not exist "%DEST_DIR%" if not exist "%LEGACY_DIR%" (
    echo   %C_YELLOW%Nothing to reinstall - no existing installation found.%C_RESET%
    echo   Use %C_GREEN%[1]%C_RESET% Install ^(junction^) instead.
    goto :eof
)
echo   This will %C_BOLD%remove%C_RESET% the existing install and create a fresh junction.
echo   Your %C_GREEN%config and API keys are preserved%C_RESET% ^(only the extension entry is rebuilt^).
call :confirm "Continue?" || goto :eof

if exist "%DEST_DIR%"   call :do_remove_extension "%DEST_DIR%"
if exist "%LEGACY_DIR%" call :do_remove_extension "%LEGACY_DIR%"

call :ensure_dev_mode
if not exist "%EXT_DIR%" mkdir "%EXT_DIR%" >nul 2>&1
call :do_install_junction
call :do_clear_cep_cache
call :show_post_install_note
goto :eof


REM ===========================================================
REM   ACTION: uninstall  (config preserved)
REM ===========================================================
:action_uninstall
echo %C_BOLD%%C_YELLOW%>>>  UNINSTALL%C_RESET%
echo.
if not exist "%DEST_DIR%" if not exist "%LEGACY_DIR%" (
    echo   %C_GRAY%Nothing to uninstall - the plugin is not installed.%C_RESET%
    goto :eof
)
echo   This will remove the plugin from Adobe CEP.
echo   %C_GREEN%Your config and API keys WILL BE KEPT%C_RESET% in:
echo     %C_GRAY%%DATA_FILE%%C_RESET%
echo.
echo   Source folder is %C_GREEN%never deleted%C_RESET% ^(only the link/copy is removed^).
call :confirm "Continue?" || goto :eof

if exist "%DEST_DIR%"   call :do_remove_extension "%DEST_DIR%"
if exist "%LEGACY_DIR%" call :do_remove_extension "%LEGACY_DIR%"
call :do_clear_cep_cache
echo.
echo %C_GREEN%   Uninstalled.%C_RESET% Config file untouched.
goto :eof


REM ===========================================================
REM   ACTION: factory reset  (uninstall + WIPE config)
REM ===========================================================
:action_factory_reset
echo %C_BOLD%%C_RED%>>>  FACTORY RESET%C_RESET%
echo.
echo   %C_RED%%C_BOLD%WARNING:%C_RESET% This will:
echo     %C_RED%-%C_RESET% Remove the plugin from Adobe CEP
echo     %C_RED%-%C_RESET% DELETE the config file ^(all settings + API keys^)
echo     %C_RED%-%C_RESET% DELETE the legacy config file ^(if any^)
echo     %C_RED%-%C_RESET% Clear the CEP / AE extension caches
echo.
echo   Source folder is %C_GREEN%never deleted%C_RESET%.
echo   You will need to re-enter all API keys after the next install.
echo.
call :confirm "Are you SURE? Type YES to confirm:" YES || goto :eof

if exist "%DEST_DIR%"   call :do_remove_extension "%DEST_DIR%"
if exist "%LEGACY_DIR%" call :do_remove_extension "%LEGACY_DIR%"

if exist "%DATA_FILE%" (
    del /F /Q "%DATA_FILE%" >nul 2>&1
    if exist "%DATA_FILE%" (
        echo   %C_RED%! Could not delete %DATA_FILE%%C_RESET%
    ) else (
        echo   %C_GREEN%* Deleted %DATA_FILE%%C_RESET%
    )
)
if exist "%LEGACY_DATA_FILE%" (
    del /F /Q "%LEGACY_DATA_FILE%" >nul 2>&1
    if exist "%LEGACY_DATA_FILE%" (
        echo   %C_RED%! Could not delete %LEGACY_DATA_FILE%%C_RESET%
    ) else (
        echo   %C_GREEN%* Deleted %LEGACY_DATA_FILE%%C_RESET%
    )
)

call :do_clear_cep_cache
echo.
echo %C_GREEN%   Factory reset complete.%C_RESET% Run option %C_GREEN%[1]%C_RESET% to install again.
goto :eof


REM ===========================================================
REM   ACTION: clear cache only
REM ===========================================================
:action_clear_cache
echo %C_BOLD%%C_BLUE%>>>  CLEAR CACHE%C_RESET%
echo.
echo   This clears the Adobe CEP cache and any After Effects
echo   extension-cache folders. Use this when the plugin behaves
echo   oddly after an update.
echo.
echo   Your installation and config are %C_GREEN%untouched%C_RESET%.
call :confirm "Continue?" || goto :eof
call :do_clear_cep_cache
echo.
echo %C_GREEN%   Cache cleared.%C_RESET% Restart After Effects.
goto :eof


REM ===========================================================
REM   ACTION: diagnose  (verbose info dump)
REM ===========================================================
:action_diagnose
echo %C_BOLD%%C_MAGENTA%>>>  DIAGNOSE%C_RESET%
echo.
echo   %C_BOLD%Extension paths%C_RESET%
echo     %C_GRAY%EXT_DIR     :%C_RESET% %EXT_DIR%
echo     %C_GRAY%DEST_DIR    :%C_RESET% %DEST_DIR%
echo     %C_GRAY%LEGACY_DIR  :%C_RESET% %LEGACY_DIR%
echo     %C_GRAY%SRC_DIR     :%C_RESET% %SRC_DIR%
echo.

echo   %C_BOLD%Existence%C_RESET%
call :exist_report "%EXT_DIR%"          "CEP extensions dir"
call :exist_report "%DEST_DIR%"         "Plugin install"
call :exist_report "%LEGACY_DIR%"       "Legacy install"
call :exist_report "%SRC_DIR%"          "Source repo"
call :exist_report "%DATA_FILE%"        "Config file"
call :exist_report "%LEGACY_DATA_FILE%" "Legacy config"
call :exist_report "%CEP_CACHE%"        "CEP cache"
echo.

echo   %C_BOLD%PlayerDebugMode registry values%C_RESET%
for /L %%G in (9,1,20) do (
    reg query "HKCU\Software\Adobe\CSXS.%%G" /v PlayerDebugMode >nul 2>&1
    if not errorlevel 1 (
        for /F "tokens=3" %%V in ('reg query "HKCU\Software\Adobe\CSXS.%%G" /v PlayerDebugMode 2^>nul ^| findstr PlayerDebugMode') do (
            echo     %C_GRAY%CSXS.%%G%C_RESET% PlayerDebugMode = %%V
        )
    )
)
echo.

echo   %C_BOLD%After Effects support folders%C_RESET%
for /D %%G in ("%APPDATA%\Adobe\After Effects*") do (
    echo     %C_GRAY%%%~nxG%C_RESET%
    if exist "%%~G\extensions-cache" (
        echo       %C_YELLOW%! has extensions-cache%C_RESET%
    )
)
goto :eof


REM ===========================================================
REM   HELPER: install_junction
REM ===========================================================
:do_install_junction
echo   %C_BOLD%Creating junction ...%C_RESET%
mklink /J "%DEST_DIR%" "%SRC_DIR%" >nul 2>&1
if errorlevel 1 (
    echo   %C_YELLOW%! Junction failed - trying symbolic link ...%C_RESET%
    mklink /D "%DEST_DIR%" "%SRC_DIR%" >nul 2>&1
    if errorlevel 1 (
        echo   %C_RED%! Both junction and symlink failed.%C_RESET%
        echo   %C_YELLOW%  Falling back to file copy ...%C_RESET%
        call :do_install_copy
        goto :eof
    ) else (
        echo   %C_GREEN%* Symbolic link created.%C_RESET%
    )
) else (
    echo   %C_GREEN%* Junction created:%C_RESET% %DEST_DIR%
    echo   %C_GRAY%   Edits in %SRC_DIR% will be visible in AE immediately.%C_RESET%
)
goto :eof


REM ===========================================================
REM   HELPER: install_copy
REM ===========================================================
:do_install_copy
echo   %C_BOLD%Copying files ...%C_RESET%
if not exist "%DEST_DIR%" mkdir "%DEST_DIR%" >nul 2>&1
robocopy "%SRC_DIR%" "%DEST_DIR%" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /NC /NS ^
    /XD ".git" ".vscode" "node_modules" "python_envs" "docs" "mcp-server\node_modules" ^
    /XF "install.bat" "uninstall.bat" "fix_extension_name.bat" "INSTRUKCJA_INSTALACJI.md" >nul
if errorlevel 8 (
    echo   %C_RED%! robocopy reported errors. Verify destination manually.%C_RESET%
) else (
    echo   %C_GREEN%* Files copied to%C_RESET% %DEST_DIR%
)
goto :eof


REM ===========================================================
REM   HELPER: ensure CEP developer mode (PlayerDebugMode=1)
REM ===========================================================
:ensure_dev_mode
echo   %C_BOLD%Enabling CEP developer mode ...%C_RESET%
for /L %%G in (9,1,20) do (
    reg add "HKCU\Software\Adobe\CSXS.%%G" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
)
echo   %C_GREEN%* PlayerDebugMode set for CSXS.9 through CSXS.20%C_RESET%
goto :eof


REM ===========================================================
REM   HELPER: remove an extension entry (junction-aware)
REM ===========================================================
:do_remove_extension
set "TARGET=%~1"
echo   %C_BOLD%Removing%C_RESET% %TARGET%

set "IS_LINK=0"
for /F "delims=" %%R in ('dir /AL /B "%~dp1" 2^>nul') do (
    if /I "%%~R"=="%~nx1" set "IS_LINK=1"
)

if "!IS_LINK!"=="1" (
    echo     %C_GRAY%Detected: junction/symlink - removing link only.%C_RESET%
    rmdir "%TARGET%" >nul 2>&1
) else (
    echo     %C_GRAY%Detected: regular folder - deleting contents.%C_RESET%
    rmdir /S /Q "%TARGET%" >nul 2>&1
)

if exist "%TARGET%" (
    echo     %C_RED%! Could not remove %TARGET%%C_RESET%
    echo     %C_YELLOW%  Close After Effects ^(and any shells in that folder^) and retry.%C_RESET%
) else (
    echo     %C_GREEN%* Removed.%C_RESET%
)
goto :eof


REM ===========================================================
REM   HELPER: clear CEP / AE extension caches
REM ===========================================================
:do_clear_cep_cache
echo   %C_BOLD%Clearing Adobe CEP cache ...%C_RESET%
if exist "%CEP_CACHE%" rmdir /S /Q "%CEP_CACHE%" >nul 2>&1
for /D %%G in ("%APPDATA%\Adobe\After Effects*") do (
    if exist "%%~G\extensions-cache" rmdir /S /Q "%%~G\extensions-cache" >nul 2>&1
)
echo   %C_GREEN%* Cache cleared.%C_RESET%
goto :eof


REM ===========================================================
REM   HELPER: post-install note (next-steps banner)
REM ===========================================================
:show_post_install_note
echo.
echo %C_BOLD%%C_GREEN%   Installation complete!%C_RESET%
echo.
echo   %C_BOLD%Next steps:%C_RESET%
echo     %C_GRAY%1.%C_RESET% Close Adobe After Effects %C_BOLD%completely%C_RESET% ^(check Task Manager^).
echo     %C_GRAY%2.%C_RESET% Start AE again.
echo     %C_GRAY%3.%C_RESET% Open %C_CYAN%Window ^> Extensions ^> HEXART.PL/AfterALL%C_RESET%
echo.
goto :eof


REM ===========================================================
REM   HELPER: exist_report  ^<path^>  ^<label^>
REM ===========================================================
:exist_report
if exist "%~1" (
    echo     %C_GREEN%*%C_RESET% %~2  %C_GRAY%[ %~1 ]%C_RESET%
) else (
    echo     %C_GRAY%-%C_RESET% %~2  %C_GRAY%[ %~1 ] (missing)%C_RESET%
)
goto :eof


REM ===========================================================
REM   HELPER: confirm  ^<prompt^>  [expected_word]
REM
REM   When expected_word is omitted: Y/N (default N).
REM   When expected_word is given (e.g. "YES"): user must type
REM   exactly that word for the action to proceed.
REM ===========================================================
:confirm
set "_PROMPT=%~1"
set "_EXPECT=%~2"
if "%_EXPECT%"=="" (
    set "_ANS="
    set /p "_ANS=  %C_YELLOW%%_PROMPT%%C_RESET% [y/N]: "
    if /I "!_ANS!"=="Y"   exit /b 0
    if /I "!_ANS!"=="YES" exit /b 0
    echo   %C_GRAY%Cancelled.%C_RESET%
    exit /b 1
) else (
    set "_ANS="
    set /p "_ANS=  %C_RED%%C_BOLD%%_PROMPT%%C_RESET% "
    if /I "!_ANS!"=="%_EXPECT%" exit /b 0
    echo   %C_GRAY%Cancelled.%C_RESET%
    exit /b 1
)
