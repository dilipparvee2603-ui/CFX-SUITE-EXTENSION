@echo off
setlocal EnableDelayedExpansion
title CFX Suite - After Effects Extension Installer
color 0C

echo =====================================================================
echo                     CFX SUITE FOR AFTER EFFECTS
echo                     Neon Elite Edition (v1.0.0)
echo =====================================================================
echo.

:: Check if After Effects is running
tasklist /fi "imagename eq AfterFX.exe" 2>NUL | find /i /n "AfterFX.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo [!] WARNING: Adobe After Effects is currently running.
    echo     Please save your projects and close After Effects, then continue.
    echo.
    pause
)

set "TARGET_DIR=%APPDATA%\Adobe\CEP\extensions\com.cfx.suite"
echo [*] Target Directory: "%TARGET_DIR%"

:: Ensure parent directory exists
if not exist "%APPDATA%\Adobe\CEP\extensions" (
    mkdir "%APPDATA%\Adobe\CEP\extensions" 2>NUL
)

:: Remove older version if present
if exist "%TARGET_DIR%" (
    echo [*] Removing existing installation...
    rmdir /s /q "%TARGET_DIR%" 2>NUL
)

:: Copy extension files
echo [*] Installing CFX Suite extension files...
set "SOURCE_DIR=%~dp0"

:: If running inside repo root
if exist "%SOURCE_DIR%CSXS\manifest.xml" (
    xcopy "%SOURCE_DIR%*" "%TARGET_DIR%\" /E /I /H /Y /Q /EXCLUDE:%SOURCE_DIR%.git >NUL 2>&1
) else if exist "%SOURCE_DIR%com.cfx.suite" (
    xcopy "%SOURCE_DIR%com.cfx.suite\*" "%TARGET_DIR%\" /E /I /H /Y /Q >NUL 2>&1
)

if not exist "%TARGET_DIR%\CSXS\manifest.xml" (
    color 04
    echo.
    echo [ERROR] Installation failed! Unable to copy files to:
    echo "%TARGET_DIR%"
    echo Please make sure you have permissions and try running as Administrator.
    echo.
    pause
    exit /b 1
)

:: Configure Adobe CEP Debug Mode for CSXS 7 through 17
echo [*] Enabling Adobe CEP security policies in Windows Registry...
for %%V in (7 8 9 10 11 12 13 14 15 16 17) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v "PlayerDebugMode" /t REG_SZ /d "1" /f >NUL 2>&1
)

color 0A
echo.
echo =====================================================================
echo           [SUCCESS] CFX Suite was installed successfully!
echo =====================================================================
echo.
echo  How to use in After Effects:
echo    1. Open Adobe After Effects (2020 through 2026+)
echo    2. In the top menu bar, click: Window -^> Extensions -^> CFX Suite
echo    3. Done! Enjoy Auto Captions, Auto Tracker, Presets, and Tools.
echo.
pause
exit /b 0
