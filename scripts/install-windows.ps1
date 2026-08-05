# ProjectMind Agent - Windows Installer
# One-command installation script for Windows
#
# Usage: irm https://projectm.dev/install.ps1 | iex
#

$ErrorActionPreference = "Stop"

$AgentVersion = "latest"
$DownloadBaseUrl = "https://projectm.dev/downloads/agent"
$InstallDir = "$env:USERPROFILE\.projectmind"
$BinaryName = "projectmind-agent.exe"

function Write-Header {
    Write-Host ""
    Write-Host "╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Blue
    Write-Host "║       ProjectMind Agent - Windows Installer              ║" -ForegroundColor Blue
    Write-Host "╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Blue
    Write-Host ""
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-ErrorMsg {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
}

function Write-InfoMsg {
    param([string]$Message)
    Write-Host "→ $Message" -ForegroundColor Cyan
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Get-Architecture {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq "AMD64" -or $arch -eq "x86_64") {
        return "windows-x64"
    }
    else {
        Write-ErrorMsg "Unsupported architecture: $arch"
        exit 1
    }
}

function Download-Agent {
    param([string]$Arch)
    
    $zipName = "projectmind-agent-$Arch.zip"
    $downloadUrl = "$DownloadBaseUrl/$zipName"
    $tempZip = "$env:TEMP\$zipName"
    
    Write-InfoMsg "Downloading ProjectMind Agent for $Arch..."
    
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -UseBasicParsing
        Write-Success "Downloaded agent"
        return $tempZip
    }
    catch {
        Write-ErrorMsg "Failed to download: $_"
        exit 1
    }
}

function Install-Agent {
    param([string]$ZipFile)
    
    Write-InfoMsg "Installing to $InstallDir..."
    
    # Create install directory
    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    
    # Extract zip
    try {
        Expand-Archive -Path $ZipFile -DestinationPath $InstallDir -Force
        Write-Success "Extracted files"
    }
    catch {
        Write-ErrorMsg "Failed to extract: $_"
        exit 1
    }
    
    # Unblock executable
    $exePath = Join-Path $InstallDir $BinaryName
    if (Test-Path $exePath) {
        Unblock-File -Path $exePath
        Write-Success "Unblocked executable"
    }
    
    # Rename .env if present
    $envFile = Join-Path $InstallDir ".env"
    if (Test-Path $envFile) {
        Move-Item -Path $envFile -Destination "$InstallDir\.env.example" -Force
    }
    
    # Clean up
    Remove-Item -Path $ZipFile -Force
    
    Write-Success "Installed to $InstallDir"
}

function Add-ToPath {
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    
    if ($currentPath -notlike "*$InstallDir*") {
        $newPath = "$InstallDir;$currentPath"
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        
        # Also add to current session
        $env:Path = "$InstallDir;$env:Path"
        
        Write-Success "Added to PATH"
        Write-Warning "You may need to restart your terminal for PATH changes to take effect"
    }
    else {
        Write-InfoMsg "PATH already configured"
    }
}

function Invoke-Setup {
    Write-InfoMsg "Running setup wizard..."
    Write-Host ""
    
    Push-Location $InstallDir
    try {
        & ".\$BinaryName" setup
    }
    finally {
        Pop-Location
    }
}

function Install-ScheduledTask {
    Write-Host ""
    $response = Read-Host "Would you like to start the agent automatically at login? [y/N]"
    
    if ($response -match "^[Yy]$") {
        $taskName = "ProjectMindAgent"
        $exePath = Join-Path $InstallDir $BinaryName
        
        # Remove existing task if present
        try {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        }
        catch {
            # Ignore errors if task doesn't exist
        }
        
        # Create new task
        $action = New-ScheduledTaskAction -Execute $exePath -WorkingDirectory $InstallDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
        
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "ProjectMind Agent" | Out-Null
        
        Write-Success "Configured to start at login"
        Write-InfoMsg "View in Task Scheduler: taskschd.msc"
        Write-InfoMsg "To disable: schtasks /delete /tn ProjectMindAgent"
    }
}

function Write-Finish {
    Write-Host ""
    Write-Host "╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "║       Installation Complete!                              ║" -ForegroundColor Green
    Write-Host "╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Green
    Write-Host ""
    Write-Success "ProjectMind Agent installed to: $InstallDir"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  $BinaryName          # Start the agent"
    Write-Host "  $BinaryName doctor   # Check configuration"
    Write-Host "  $BinaryName help     # Show help"
    Write-Host ""
    Write-Host "To start now (if not using auto-start):"
    Write-Host "  cd $InstallDir"
    Write-Host "  .\$BinaryName"
    Write-Host ""
    Write-InfoMsg "Visit https://projectm.dev/docs for more information"
    Write-Host ""
}

function Main {
    Write-Header
    
    # Check if running on Windows
    if (-not ($PSVersionTable.Platform -eq "Win32NT" -or [System.Environment]::OSVersion.Platform -eq "Win32NT" -or $null -eq $PSVersionTable.Platform)) {
        Write-ErrorMsg "This installer is for Windows only."
        Write-InfoMsg "For other platforms, visit: https://projectm.dev/downloads"
        exit 1
    }
    
    # Check if running as administrator
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Warning "Running without administrator privileges. Some features may not work."
        Write-InfoMsg "For best results, run: Right-click PowerShell → Run as Administrator"
    }
    
    # Detect architecture
    $arch = Get-Architecture
    Write-InfoMsg "Detected architecture: $arch"
    
    # Download
    $zipFile = Download-Agent $arch
    
    # Install
    Install-Agent $zipFile
    
    # Add to PATH
    Add-ToPath
    
    # Run setup wizard
    Invoke-Setup
    
    # Optional: setup auto-start
    if ($isAdmin) {
        Install-ScheduledTask
    }
    else {
        Write-Warning "Skipping auto-start setup (requires administrator)"
    }
    
    # Show completion message
    Write-Finish
}

Main
