# CFX Suite - 1-Click PowerShell Installer
[Console]::Title = "CFX Suite - After Effects Extension Installer"
Write-Host "=====================================================================" -ForegroundColor Red
Write-Host "                    CFX SUITE FOR AFTER EFFECTS                      " -ForegroundColor White
Write-Host "                    Neon Elite Edition (v1.0.0)                      " -ForegroundColor Red
Write-Host "=====================================================================" -ForegroundColor Red
Write-Host ""

# Check if AfterFX is running
$aeProc = Get-Process -Name "AfterFX" -ErrorAction SilentlyContinue
if ($aeProc) {
    Write-Host "[!] WARNING: Adobe After Effects is currently running." -ForegroundColor Yellow
    Write-Host "    Please close After Effects before continuing." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to continue after closing After Effects"
}

$appData = [Environment]::GetFolderPath("ApplicationData")
$targetDir = Join-Path $appData "Adobe\CEP\extensions\com.cfx.suite"
$sourceDir = Join-Path $PSScriptRoot "com.cfx.suite"

Write-Host "[*] Target Directory: $targetDir" -ForegroundColor Cyan

# Remove old installation
if (Test-Path $targetDir) {
    Write-Host "[*] Removing previous version..." -ForegroundColor Gray
    Remove-Item -Path $targetDir -Recurse -Force
}

# Ensure parent directory exists
$parentDir = Split-Path $targetDir -Parent
if (-not (Test-Path $parentDir)) {
    New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
}

# Copy files
Write-Host "[*] Installing CFX Suite extension files..." -ForegroundColor Cyan
Copy-Item -Path $sourceDir -Destination $targetDir -Recurse -Force

if (-not (Test-Path (Join-Path $targetDir "CSXS\manifest.xml"))) {
    Write-Host "[ERROR] Installation failed! Unable to copy extension files." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Configure Registry for CSXS 7 through 17
Write-Host "[*] Enabling Adobe CEP security policies in Windows Registry..." -ForegroundColor Cyan
7..17 | ForEach-Object {
    $regPath = "HKCU:\Software\Adobe\CSXS.$_"
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    Set-ItemProperty -Path $regPath -Name "PlayerDebugMode" -Value "1" -Type String -Force
}

Write-Host ""
Write-Host "=====================================================================" -ForegroundColor Green
Write-Host "          [SUCCESS] CFX Suite was installed successfully!            " -ForegroundColor Green
Write-Host "=====================================================================" -ForegroundColor Green
Write-Host ""
Write-Host " How to launch in After Effects:" -ForegroundColor White
Write-Host "   1. Open Adobe After Effects (2020 through 2026+)" -ForegroundColor Gray
Write-Host "   2. Click top menu: Window -> Extensions -> CFX Suite" -ForegroundColor Yellow
Write-Host "   3. Done! All tools and presets are active." -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to finish"
