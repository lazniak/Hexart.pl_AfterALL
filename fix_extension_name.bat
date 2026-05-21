@echo off
chcp 65001 >nul
echo ============================================================
echo  HEXART.PL/AfterALL — Naprawa nazwy wtyczki w After Effects
echo ============================================================
echo.
echo Ten skrypt:
echo  1. Zamyka stary symlink/folder com.aisist.agent.ae
echo  2. Utworzy nowy symlink pl.hexart.afterall wskazujacy na ten sam
echo     katalog zrodlowy (D:\code\aisistAE) — dalej developujesz tu samo
echo  3. Czysci cache rozszerzen Adobe CEP (jezeli istnieje)
echo.
echo WAZNE: Upewnij sie, ze Adobe After Effects jest CALKOWICIE ZAMKNIETY!
echo.
pause

set "OLD_NAME=com.aisist.agent.ae"
set "NEW_NAME=pl.hexart.afterall"
set "EXT_DIR=%APPDATA%\Adobe\CEP\extensions"
set "OLD_PATH=%EXT_DIR%\%OLD_NAME%"
set "NEW_PATH=%EXT_DIR%\%NEW_NAME%"
set "SRC_DIR=%~dp0"
set "SRC_DIR=%SRC_DIR:~0,-1%"

echo [1/4] Sprawdzam zrodlo: %SRC_DIR%
if not exist "%SRC_DIR%\CSXS\manifest.xml" (
    echo BLAD: Nie znaleziono CSXS\manifest.xml w %SRC_DIR%
    echo Uruchom ten skrypt z folderu wtyczki!
    pause
    exit /b 1
)
echo -- OK
echo.

echo [2/4] Wykrywam stara instalacje...
if exist "%OLD_PATH%" (
    echo -- Znaleziono stara wtyczke pod: %OLD_PATH%
    rem Sprawdz czy to symlink (linkowanie reparse point)
    dir "%EXT_DIR%" | findstr /C:"%OLD_NAME%" | findstr /C:"<SYMLINKD>" >nul
    if not errorlevel 1 (
        echo -- Stary wpis to SYMLINK — usuwam tylko link, zrodlo D:\... zostaje nietkniete
        rmdir "%OLD_PATH%" 2>nul
    ) else (
        echo -- Stary wpis to zwykly folder — usuwam zawartosc
        rmdir /S /Q "%OLD_PATH%" 2>nul
    )
    if exist "%OLD_PATH%" (
        echo OSTRZEZENIE: Nie udalo sie usunac %OLD_PATH%
        echo Sprawdz uprawnienia lub usun recznie.
    ) else (
        echo -- Usunieto.
    )
) else (
    echo -- Stara wersja nie istnieje. Pomijam.
)
echo.

echo [3/4] Tworze nowy symlink: %NEW_PATH%  -^>  %SRC_DIR%
if exist "%NEW_PATH%" (
    echo -- Istnieje juz wpis pod nowa nazwa. Usuwam go najpierw.
    rmdir "%NEW_PATH%" 2>nul
    if exist "%NEW_PATH%" rmdir /S /Q "%NEW_PATH%" 2>nul
)
mklink /D "%NEW_PATH%" "%SRC_DIR%" >nul
if errorlevel 1 (
    echo.
    echo BLAD: Nie udalo sie utworzyc symlinka. Mozliwe przyczyny:
    echo  - Brak uprawnien administratora (uruchom skrypt jako Administrator)
    echo  - Wlaczona ochrona ContrastedWindows ktora blokuje symlinki
    echo.
    echo ROZWIAZANIE ALTERNATYWNE: skopiuj caly folder z %SRC_DIR%
    echo                          do %NEW_PATH% recznie.
    echo Lub: uruchom ten skrypt klikajac PPM ^> "Uruchom jako administrator".
    pause
    exit /b 1
)
echo -- Symlink utworzony pomyslnie.
echo.

echo [4/4] Czyszcze cache rozszerzen Adobe CEP...
if exist "%APPDATA%\Adobe\CEP\Cache" (
    rmdir /S /Q "%APPDATA%\Adobe\CEP\Cache" 2>nul
    echo -- Wyczyszczono: %APPDATA%\Adobe\CEP\Cache
)
if exist "%APPDATA%\Adobe\CEP\extensions\xman" (
    del /F /Q "%APPDATA%\Adobe\CEP\extensions\xman\*.xml" 2>nul
    echo -- Wyczyszczono cache xman.
)
rem AE-specific extension cache (Adobe CEP CSXS preferences)
for /D %%G in ("%APPDATA%\Adobe\After Effects*") do (
    if exist "%%G\extensions-cache" (
        rmdir /S /Q "%%G\extensions-cache" 2>nul
        echo -- Wyczyszczono cache w: %%G
    )
)
echo.

echo ============================================================
echo Gotowe! Nazwa zmieniona na: HEXART.PL/AfterALL
echo Lokalizacja: %NEW_PATH%
echo Zrodlo: %SRC_DIR%
echo ============================================================
echo.
echo NASTEPNE KROKI:
echo  1. Uruchom Adobe After Effects.
echo  2. Window ^> Extensions — powinno pojawic sie "HEXART.PL/AfterALL"
echo  3. Jesli nadal widzisz stara nazwe, calkowicie zamknij AE
echo     (sprawdz w Menedzerze Zadan czy nie zostal proces AfterFX.exe)
echo     i otworz ponownie.
echo.
pause
