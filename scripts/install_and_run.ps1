<#
install_and_run.ps1
Automates installing Python (via winget if available), creating a venv,
installing requirements, and starting the Flask app.

Usage (run as Administrator if you want winget to install system-wide):
  PowerShell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install_and_run.ps1

Notes:
- If your system uses the Microsoft Store python shim (WindowsApps) this
  script will attempt a winget install. If the shim remains active you must
  disable the App Execution Alias manually: Settings → Apps → Advanced app settings → App execution aliases → turn OFF python.exe / python3.exe
#>
[CmdletBinding()]
param()

function Write-ErrExit($msg) {
  Write-Error $msg
  exit 1
}

Write-Output "Starting environment setup for MultiChartIndicator"

function Find-LocalPython {
  $paths = @(
    "C:\Users\$env:USERNAME\AppData\Local\Programs\Python",
    'C:\Program Files\Python*',
    'C:\Program Files (x86)\Python*'
  )
  $candidates = @()
  foreach ($path in $paths) {
    $candidates += Get-ChildItem -Path $path -Recurse -Filter python.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
  }
  return $candidates | Sort-Object -Unique
}

function Get-PythonInfo {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if (-not $cmd) { return @{ Found = $false } }
  $src = $cmd.Source
  $isShim = ($src -like '*WindowsApps*')
  if ($isShim) {
    $fallback = Find-LocalPython | Sort-Object -Descending | Select-Object -First 1
    if ($fallback) {
      return @{ Found = $true; Source = $fallback; IsWindowsApps = $false; Fallback = $true }
    }
  }
  return @{ Found = $true; Source = $src; IsWindowsApps = $isShim; Fallback = $false }
}

function Wait-For-Port {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 20
  )
  $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([datetime]::UtcNow -lt $deadline) {
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
      return $true
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Invoke-WebRequestSafe {
  param(
    [string]$Uri,
    [int]$TimeoutSec = 5
  )
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    return Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
  }
  return Invoke-WebRequest -Uri $Uri -TimeoutSec $TimeoutSec
}

$py = Get-PythonInfo
if (-not $py.Found -or $py.IsWindowsApps) {
  Write-Output "A usable 'python' was not found (or WindowsApps shim detected)."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Output "winget found — attempting to install Python 3.12 (this may prompt for consent)."
    try {
      winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements | Write-Output
    } catch {
      Write-Warning "winget install failed: $_"
    }
    Start-Sleep -Seconds 3
    $py = Get-PythonInfo
    if ($py.Found -and -not $py.IsWindowsApps) { Write-Output "Python installed: $($py.Source)" }
  } else {
    Write-Warning "winget not found. Install Python 3 from https://python.org and ensure 'Add Python to PATH' is checked, or disable the Microsoft Store python alias."
  }
}

$py = Get-PythonInfo
if (-not $py.Found) {
  Write-ErrExit "No usable python detected. Install Python 3 and re-run this script."
}
if ($py.IsWindowsApps) {
  Write-Warning "Detected Microsoft Store python shim at: $($py.Source)"
  Write-Warning "Please disable the App Execution Alias:`n  Settings → Apps → Advanced app settings → App execution aliases → turn OFF python.exe and python3.exe"
  Write-ErrExit "WindowsApps python shim prevents using pip/venv. Disable the alias and re-run."
}

$pythonExe = $py.Source
Write-Output "Using python: $pythonExe"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projRoot = Split-Path -Parent $scriptDir
Set-Location $projRoot
Write-Output "Project root: $projRoot"

$venvDir = Join-Path $projRoot 'venv'
if (-not (Test-Path $venvDir)) {
  Write-Output "Creating virtual environment..."
  & $pythonExe -m venv $venvDir
} else {
  Write-Output "Virtual environment already exists."
}

$venvPy = Join-Path $venvDir 'Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  Write-Warning "venv python not found, will use system python"
  $venvPy = $pythonExe
}

try {
  & $venvPy -m pip --version | Out-Null
} catch {
  Write-Output "Bootstrapping ensurepip/pip..."
  & $venvPy -m ensurepip --upgrade
  & $venvPy -m pip install --upgrade pip setuptools
}

if (Test-Path 'requirements.txt') {
  Write-Output "Installing requirements from requirements.txt..."
  & $venvPy -m pip install -r requirements.txt
} else {
  Write-Warning "requirements.txt not found; skipping pip install."
}

function Get-Port5000Pid {
  return netstat -ano | findstr :5000 | ForEach-Object {
    if ($_ -match '\s+(\d+)\s*$') { [int]$matches[1] }
  } | Where-Object { $_ -gt 0 } | Select-Object -First 1
}

$p = Get-Port5000Pid
if ($p) {
  Write-Output "Stopping existing process on port 5000 (PID $p)"
  taskkill /PID $p /F | Out-Null
}

Write-Output "Starting application (Flask) using: $venvPy"
$proc = Start-Process -NoNewWindow -FilePath $venvPy -ArgumentList 'app.py' -WorkingDirectory $projRoot -PassThru
Write-Output "Waiting for the Flask server on port 5000..."
if (Wait-For-Port -Port 5000 -TimeoutSeconds 20) {
  Write-Output "Port 5000 is listening."
  try {
    $response = Invoke-WebRequestSafe -Uri 'http://127.0.0.1:5000' -TimeoutSec 5
    Write-Output "Server responded with HTTP $($response.StatusCode)."
    Write-Output "Application started successfully (PID $($proc.Id)). Visit http://localhost:5000"
  } catch {
    Write-Warning "Port is listening, but HTTP request failed: $($_.Exception.Message)"
    Write-Output "Application process started (PID $($proc.Id)), but the first HTTP check failed. Visit http://localhost:5000 or inspect app output."
  }
} else {
  Write-Warning "Server did not start within 20 seconds. Check the app output and ensure port 5000 is free."
}
