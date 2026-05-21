@echo off
setlocal EnableExtensions EnableDelayedExpansion
title HEXART.PL/AfterALL - Installer / Manager

REM ==========================================================
REM   HEXART.PL/AfterALL  -  Interactive installer / manager
REM
REM   Menu-driven script with plain ASCII output. Works on every
REM   cmd.exe (Windows 7 through 11) without depending on ANSI /
REM   VT100 support. Status uses [OK] / [!!] / [--] markers.
REM
REM   Scenarios:
REM     1. Install (junction)        - dev workflow, edits live
REM     2. Install (file copy)       - production-safe snapshot
REM     3. Reinstall                 - remove + install junction
REM     4. Uninstall                 - remove plugin only
REM     5. Factory reset             - uninstall + WIPE config
REM     6. Clear cache only          - CEP / AE caches
REM     7. Diagnose                  - print full state
REM     0. Exit
REM ==========================================================

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
set /p "CHOICE=  Choose [0-7]: "
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
    echo   [!!] Invalid choice: %CHOICE%
)

echo.
echo   ----------------------------------------------------------
pause
goto :menu_loop


:exit_clean
echo.
echo   Goodbye!
echo.
endlocal
exit /b 0


REM ===========================================================
REM                    HEADER / BANNER
REM ===========================================================
:show_banner
cls
echo.
echo   ============================================================
echo     HEXART.PL/AfterALL  -  AI Motion Designer for AE
echo     Installer / Manager
echo   ============================================================
echo.
goto :eof


REM ===========================================================
REM     SHOW CURRENT STATE  (installed? junction? config?)
REM ===========================================================
:show_current_state
echo   Current state
echo   ----------------------------------------------------------

set "STATE_NEW=none"
if exist "%DEST_DIR%" call :detect_link_status "%EXT_DIR%" "%EXTENSION_NAME%" STATE_NEW

if "!STATE_NEW!"=="none" (
    echo     [--] Plugin not installed.
) else if "!STATE_NEW!"=="link" (
    echo     [OK] Installed via junction/symlink  ^(dev mode^)
    echo          %DEST_DIR%
) else (
    echo     [OK] Installed as full copy  ^(production mode^)
    echo          %DEST_DIR%
)

REM Legacy install (old name)
if exist "%LEGACY_DIR%" (
    echo     [!!] Legacy install detected: %LEGACY_NAME%
)

REM Stored config / API keys
if exist "%DATA_FILE%" (
    echo     [OK] Config file present  ^(API keys, settings^)
    echo          %DATA_FILE%
) else if exist "%LEGACY_DATA_FILE%" (
    echo     [!!] Legacy config file present
    echo          %LEGACY_DATA_FILE%
) else (
    echo     [--] No config file yet.
)

echo.
echo   Source repo
echo   ----------------------------------------------------------
echo     %SRC_DIR%
echo.
goto :eof


REM ===========================================================
REM     :detect_link_status <ext_dir> <basename> <out_var>
REM     Sets <out_var> to "link", "copy", or "none".
REM ===========================================================
:detect_link_status
set "_DLS_EXT=%~1"
set "_DLS_BASE=%~2"
set "_DLS_OUT=%~3"
set "_DLS_RESULT=copy"
for /F "delims=" %%R in ('dir /AL /B "%_DLS_EXT%" 2^>nul') do (
    if /I "%%~R"=="%_DLS_BASE%" set "_DLS_RESULT=link"
)
set "%_DLS_OUT%=%_DLS_RESULT%"
goto :eof


REM ===========================================================
REM                    MENU
REM ===========================================================
:show_menu
echo   What would you like to do?
echo   ----------------------------------------------------------
echo     1  Install ^(junction^)         recommended for dev workflow
echo     2  Install ^(file copy^)        production: independent of source
echo     3  Reinstall                   remove existing + install junction
echo     4  Uninstall                   remove plugin, KEEP config and keys
echo     5  Factory reset               uninstall + WIPE config + WIPE keys
echo     6  Clear cache only            CEP + AE extension caches
echo     7  Diagnose                    print every path and state
echo.
echo     0  Exit
echo.
goto :eof


REM ===========================================================
REM   ACTION: install <mode>      mode = "junction" | "copy"
REM ===========================================================
:action_install
set "MODE=%~1"
echo ^>^>^>  INSTALL  ^(mode: %MODE%^)
echo.

if exist "%DEST_DIR%" (
    echo   [!!] An existing installation was detected:
    echo        %DEST_DIR%
    echo.
    echo   The installer will remove it first, then install fresh.
    call :confirm "Continue?" || goto :eof
    call :do_remove_extension "%DEST_DIR%"
    echo.
)

call :ensure_dev_mode

if exist "%LEGACY_DIR%" (
    echo   [!!] Removing legacy install %LEGACY_NAME% ...
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
echo ^>^>^>  REINSTALL
echo.
if not exist "%DEST_DIR%" if not exist "%LEGACY_DIR%" (
    echo   [!!] Nothing to reinstall - no existing installation found.
    echo        Use option [1] Install ^(junction^) instead.
    goto :eof
)
echo   This will remove the existing install and create a fresh junction.
echo   Your config and API keys are preserved.
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
echo ^>^>^>  UNINSTALL
echo.
if not exist "%DEST_DIR%" if not exist "%LEGACY_DIR%" (
    echo   [--] Nothing to uninstall - the plugin is not installed.
    goto :eof
)
echo   This will remove the plugin from Adobe CEP.
echo   Your config and API keys WILL BE KEPT in:
echo     %DATA_FILE%
echo.
echo   Source folder is never deleted ^(only the link/copy is removed^).
call :confirm "Continue?" || goto :eof

if exist "%DEST_DIR%"   call :do_remove_extension "%DEST_DIR%"
if exist "%LEGACY_DIR%" call :do_remove_extension "%LEGACY_DIR%"
call :do_clear_cep_cache
echo.
echo   [OK] Uninstalled. Config file untouched.
goto :eof


REM ===========================================================
REM   ACTION: factory reset  (uninstall + WIPE config)
REM ===========================================================
:action_factory_reset
echo ^>^>^>  FACTORY RESET
echo.
echo   WARNING: This will:
echo     - Remove the plugin from Adobe CEP
echo     - DELETE the config file ^(all settings + API keys^)
echo     - DELETE the legacy config file ^(if any^)
echo     - Clear the CEP / AE extension caches
echo.
echo   Source folder is never deleted.
echo   You will need to re-enter all API keys after the next install.
echo.
call :confirm "Are you SURE? Type YES to confirm:" YES || goto :eof

if exist "%DEST_DIR%"   call :do_remove_extension "%DEST_DIR%"
if exist "%LEGACY_DIR%" call :do_remove_extension "%LEGACY_DIR%"

if exist "%DATA_FILE%" (
    del /F /Q "%DATA_FILE%" >nul 2>&1
    if exist "%DATA_FILE%" (
        echo   [!!] Could not delete %DATA_FILE%
    ) else (
        echo   [OK] Deleted %DATA_FILE%
    )
)
if exist "%LEGACY_DATA_FILE%" (
    del /F /Q "%LEGACY_DATA_FILE%" >nul 2>&1
    if exist "%LEGACY_DATA_FILE%" (
        echo   [!!] Could not delete %LEGACY_DATA_FILE%
    ) else (
        echo   [OK] Deleted %LEGACY_DATA_FILE%
    )
)

call :do_clear_cep_cache
echo.
echo   [OK] Factory reset complete. Run option [1] to install again.
goto :eof


REM ===========================================================
REM   ACTION: clear cache only
REM ===========================================================
:action_clear_cache
echo ^>^>^>  CLEAR CACHE
echo.
echo   This clears the Adobe CEP cache and any After Effects
echo   extension-cache folders. Use this when the plugin behaves
echo   oddly after an update.
echo.
echo   Your installation and config are untouched.
call :confirm "Continue?" || goto :eof
call :do_clear_cep_cache
echo.
echo   [OK] Cache cleared. Restart After Effects.
goto :eof


REM ===========================================================
REM   ACTION: diagnose  (verbose info dump)
REM ===========================================================
:action_diagnose
echo ^>^>^>  DIAGNOSE
echo.
echo   Extension paths
echo     EXT_DIR     : %EXT_DIR%
echo     DEST_DIR    : %DEST_DIR%
echo     LEGACY_DIR  : %LEGACY_DIR%
echo     SRC_DIR     : %SRC_DIR%
echo.

echo   Existence
call :exist_report "%EXT_DIR%"          "CEP extensions dir"
call :exist_report "%DEST_DIR%"         "Plugin install"
call :exist_report "%LEGACY_DIR%"       "Legacy install"
call :exist_report "%SRC_DIR%"          "Source repo"
call :exist_report "%DATA_FILE%"        "Config file"
call :exist_report "%LEGACY_DATA_FILE%" "Legacy config"
call :exist_report "%CEP_CACHE%"        "CEP cache"
echo.

echo   PlayerDebugMode registry values
for /L %%G in (9,1,20) do (
    reg query "HKCU\Software\Adobe\CSXS.%%G" /v PlayerDebugMode >nul 2>&1
    if not errorlevel 1 (
        for /F "tokens=3" %%V in ('reg query "HKCU\Software\Adobe\CSXS.%%G" /v PlayerDebugMode 2^>nul ^| findstr PlayerDebugMode') do (
            echo     CSXS.%%G  PlayerDebugMode = %%V
        )
    )
)
echo.

echo   After Effects support folders
for /D %%G in ("%APPDATA%\Adobe\After Effects*") do (
    echo     %%~nxG
    if exist "%%~G\extensions-cache" (
        echo       [!!] has extensions-cache
    )
)
goto :eof


REM ===========================================================
REM   HELPER: install_junction
REM ===========================================================
:do_install_junction
echo   Creating junction ...
mklink /J "%DEST_DIR%" "%SRC_DIR%" >nul 2>&1
if not errorlevel 1 (
    echo   [OK] Junction created: %DEST_DIR%
    echo        Edits in %SRC_DIR% will be visible in AE immediately.
    goto :eof
)
echo   [!!] Junction failed - trying symbolic link ...
mklink /D "%DEST_DIR%" "%SRC_DIR%" >nul 2>&1
if not errorlevel 1 (
    echo   [OK] Symbolic link created.
    goto :eof
)
echo   [!!] Both junction and symlink failed.
echo        Falling back to file copy ...
call :do_install_copy
goto :eof


REM ===========================================================
REM   HELPER: install_copy
REM ===========================================================
:do_install_copy
echo   Copying files ...
if not exist "%DEST_DIR%" mkdir "%DEST_DIR%" >nul 2>&1
robocopy "%SRC_DIR%" "%DEST_DIR%" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /NC /NS ^
    /XD ".git" ".vscode" "node_modules" "python_envs" "docs" "mcp-server\node_modules" ^
    /XF "install.bat" "uninstall.bat" "fix_extension_name.bat" "INSTRUKCJA_INSTALACJI.md" >nul
if errorlevel 8 (
    echo   [!!] robocopy reported errors. Verify destination manually.
) else (
    echo   [OK] Files copied to %DEST_DIR%
)
goto :eof


REM ===========================================================
REM   HELPER: ensure CEP developer mode (PlayerDebugMode=1)
REM ===========================================================
:ensure_dev_mode
echo   Enabling CEP developer mode ...
for /L %%G in (9,1,20) do (
    reg add "HKCU\Software\Adobe\CSXS.%%G" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
)
echo   [OK] PlayerDebugMode set for CSXS.9 through CSXS.20
goto :eof


REM ===========================================================
REM   HELPER: remove an extension entry (junction-aware)
REM ===========================================================
:do_remove_extension
set "TARGET=%~1"
echo   Removing %TARGET%

set "_RM_STATE=copy"
call :detect_link_status "%~dp1." "%~nx1" _RM_STATE

if "!_RM_STATE!"=="link" (
    echo     Detected: junction/symlink - removing link only.
    rmdir "%TARGET%" >nul 2>&1
) else (
    echo     Detected: regular folder - deleting contents.
    rmdir /S /Q "%TARGET%" >nul 2>&1
)

if exist "%TARGET%" (
    echo     [!!] Could not remove %TARGET%
    echo          Close After Effects and any shells in that folder, then retry.
) else (
    echo     [OK] Removed.
)
goto :eof


REM ===========================================================
REM   HELPER: clear CEP / AE extension caches
REM ===========================================================
:do_clear_cep_cache
echo   Clearing Adobe CEP cache ...
if exist "%CEP_CACHE%" rmdir /S /Q "%CEP_CACHE%" >nul 2>&1
for /D %%G in ("%APPDATA%\Adobe\After Effects*") do (
    if exist "%%~G\extensions-cache" rmdir /S /Q "%%~G\extensions-cache" >nul 2>&1
)
echo   [OK] Cache cleared.
goto :eof


REM ===========================================================
REM   HELPER: post-install note (next-steps banner)
REM ===========================================================
:show_post_install_note
echo.
echo   [OK] Installation complete!
echo.
echo   Next steps:
echo     1. Close Adobe After Effects completely ^(check Task Manager^).
echo     2. Start AE again.
echo     3. Open: Window ^> Extensions ^> HEXART.PL/AfterALL
echo.
goto :eof


REM ===========================================================
REM   HELPER: exist_report  <path>  <label>
REM ===========================================================
:exist_report
if exist "%~1" (
    echo     [OK] %~2  ^[ %~1 ^]
) else (
    echo     [--] %~2  ^[ %~1 ^] ^(missing^)
)
goto :eof


REM ===========================================================
REM   HELPER: confirm  <prompt>  [expected_word]
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
    set /p "_ANS=  %_PROMPT% [y/N]: "
    if /I "!_ANS!"=="Y"   exit /b 0
    if /I "!_ANS!"=="YES" exit /b 0
    echo   Cancelled.
    exit /b 1
) else (
    set "_ANS="
    set /p "_ANS=  %_PROMPT% "
    if /I "!_ANS!"=="%_EXPECT%" exit /b 0
    echo   Cancelled.
    exit /b 1
)
