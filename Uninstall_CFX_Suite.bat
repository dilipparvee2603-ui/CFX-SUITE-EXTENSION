@echo off
setlocal EnableDelayedExpansion
title Uninstall CFX Suite
color 0C

echo =====================================================================
echo                 UNINSTALLING CFX SUITE EXTENSION
echo =====================================================================
echo.

set "TARGET_DIR=%APPDATA%\Adobe\CEP\extensions\com.cfx.suite"

if exist "%TARGET_DIR%" (
    echo [*] Removing CFX Suite from "%TARGET_DIR%"...
    rmdir /s /q "%TARGET_DIR%" 2>NUL
    if not exist "%TARGET_DIR%" (
        color 0A
        echo [SUCCESS] CFX Suite extension has been completely uninstalled.
    ) else (
        echo [ERROR] Could not remove directory. Please ensure After Effects is closed.
    )
) else (
    echo [INFO] CFX Suite is not currently installed in %APPDATA%\Adobe\CEP\extensions.
)

echo.
pause
