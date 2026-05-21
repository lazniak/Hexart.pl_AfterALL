@echo off
chcp 65001 >nul
echo ============================================================
echo      Instalator Wtyczki: HEXART.PL/AfterALL (AE) v2.0
echo ============================================================
echo.

set "EXTENSION_NAME=pl.hexart.afterall"
set "LEGACY_NAME=com.aisist.agent.ae"
set "EXT_DIR=%APPDATA%\Adobe\CEP\extensions"
set "DEST_DIR=%EXT_DIR%\%EXTENSION_NAME%"
set "LEGACY_DIR=%EXT_DIR%\%LEGACY_NAME%"
set "SRC_DIR=%~dp0"
set "SRC_DIR=%SRC_DIR:~0,-1%"

echo Zrodlo wtyczki: %SRC_DIR%
echo Docelowo:       %DEST_DIR%
echo.

echo [1/5] Aktywacja trybu developerskiego (PlayerDebugMode)...
FOR /L %%G IN (9,1,18) DO (
    reg add "HKCU\Software\Adobe\CSXS.%%G" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
)
echo -- Gotowe.
echo.

echo [2/5] Sprawdzam czy istnieje stara wersja...
if exist "%LEGACY_DIR%" (
    echo -- Znaleziono: %LEGACY_DIR%
    rem Detect symlink vs regular folder
    dir "%EXT_DIR%" 2>nul | findstr /C:"%LEGACY_NAME%" | findstr /C:"<SYMLINKD>" >nul
    if not errorlevel 1 (
        echo -- To symlink — usuwam tylko link (zrodlo zachowane)
        rmdir "%LEGACY_DIR%" 2>nul
    ) else (
        echo -- To zwykly folder — usuwam
        rmdir /S /Q "%LEGACY_DIR%" 2>nul
    )
    if exist "%LEGACY_DIR%" echo OSTRZEZENIE: Nie usunieto starego wpisu. Sprobuj recznie.
) else (
    echo -- Brak starej wersji.
)
echo.

echo [3/5] Sprawdzam czy istnieje juz nowa instalacja...
if exist "%DEST_DIR%" (
    dir "%EXT_DIR%" 2>nul | findstr /C:"%EXTENSION_NAME%" | findstr /C:"<SYMLINKD>" >nul
    if not errorlevel 1 (
        echo -- Istnieje symlink. Pomijam reinstalacje, tylko czyszcze cache.
        goto :cleanup_cache
    ) else (
        echo -- Istnieje zwykly folder. Usuwam aby zainstalowac swieza wersje.
        rmdir /S /Q "%DEST_DIR%" 2>nul
    )
)

echo [4/5] Instaluje wtyczke...
rem If source dir != dest dir, copy files. Otherwise (rare edge) just create symlink.
if /I "%SRC_DIR%"=="%DEST_DIR%" (
    echo -- Zrodlo i cel sa identyczne. Nic do skopiowania.
) else (
    rem Try symlink first (preserves dev workflow). Falls back to copy if no admin rights.
    mklink /D "%DEST_DIR%" "%SRC_DIR%" >nul 2>&1
    if errorlevel 1 (
        echo -- Symlink nieudany (brak praw admina?). Kopiuje pliki...
        if not exist "%DEST_DIR%" mkdir "%DEST_DIR%"
        robocopy "%SRC_DIR%" "%DEST_DIR%" /E /XC /XN /XO /XD ".git" ".vscode" "node_modules" "python_envs" /XF "install.bat" "fix_extension_name.bat" "INSTRUKCJA_INSTALACJI.md" >nul 2>&1
        echo -- Skopiowano pliki do %DEST_DIR%
    ) else (
        echo -- Utworzono symlink: %DEST_DIR% -^> %SRC_DIR%
        echo    (zmiany w zrodle beda widoczne natychmiast w AE)
    )
)
echo.

:cleanup_cache
echo [5/5] Czyszcze cache rozszerzen Adobe CEP...
if exist "%APPDATA%\Adobe\CEP\Cache" (
    rmdir /S /Q "%APPDATA%\Adobe\CEP\Cache" 2>nul
)
if exist "%APPDATA%\Adobe\CEP\extensions\xman" (
    del /F /Q "%APPDATA%\Adobe\CEP\extensions\xman\*.xml" 2>nul
)
for /D %%G in ("%APPDATA%\Adobe\After Effects*") do (
    if exist "%%G\extensions-cache" rmdir /S /Q "%%G\extensions-cache" 2>nul
)
echo -- Cache wyczyszczony.
echo.

echo ============================================================
echo Instalacja zakonczona.
echo ============================================================
echo Lokalizacja: %DEST_DIR%
echo.
echo NASTEPNE KROKI:
echo  1. CALKOWICIE zamknij Adobe After Effects (sprawdz Menedzer Zadan).
echo  2. Uruchom AE ponownie.
echo  3. Window ^> Extensions ^> HEXART.PL/AfterALL
echo.
pause
