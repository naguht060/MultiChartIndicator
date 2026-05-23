<#
starts the Flask app for MultiChartIndicator.
Usage: .\scripts\start.ps1
#>
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
Set-Location $root
Write-Output "Working directory: $root"

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

function Get-SystemPython {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -notlike '*WindowsApps*') { return $cmd.Source }
  return $null
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

$pythonPath = Get-SystemPython
if (-not $pythonPath) {
  $pythonPath = Find-LocalPython | Sort-Object -Descending | Select-Object -First 1
  if ($pythonPath) { Write-Output "Using local installed Python: $pythonPath" }
}

if (-not $pythonPath) {
  Write-Error "No usable Python interpreter found. Install Python 3 and disable the Microsoft Store python alias."
  exit 1
}

$venvDir = Join-Path $root 'venv'
if (-not (Test-Path $venvDir)) {
  Write-Output "Creating virtualenv..."
  & $pythonPath -m venv $venvDir
}

$venvPy = Join-Path $venvDir 'Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  Write-Output "venv python not found; using system python instead."
  $venvPy = $pythonPath
}

try {
  & $venvPy -m pip --version | Out-Null
} catch {
  Write-Output "Bootstrapping pip in virtual environment..."
  & $venvPy -m ensurepip --upgrade
  & $venvPy -m pip install --upgrade pip
}

if (Test-Path 'requirements.txt') {
  Write-Output "Installing requirements..."
  & $venvPy -m pip install -r requirements.txt
}

function Get-Port5000Pid {
  return netstat -ano | findstr :5000 | ForEach-Object {
    if ($_ -match '\s+(\d+)\s*$') { [int]$matches[1] }
  } | Where-Object { $_ -gt 0 } | Select-Object -First 1
}

$p = Get-Port5000Pid
if ($p) {
  Write-Output "Killing existing process on port 5000 (PID $p)"
  taskkill /PID $p /F | Out-Null
}

Write-Output "Starting app.py using: $venvPy"
$proc = Start-Process -NoNewWindow -FilePath $venvPy -ArgumentList 'app.py' -WorkingDirectory $root -PassThru
Write-Output "Waiting for the Flask server on port 5000..."
if (Wait-For-Port -Port 5000 -TimeoutSeconds 20) {
  Write-Output "Port 5000 is listening."
  try {
    $response = Invoke-WebRequestSafe -Uri 'http://127.0.0.1:5000' -TimeoutSec 5
    Write-Output "Server responded with HTTP $($response.StatusCode)."
    Write-Output "Server started successfully (PID $($proc.Id)). Visit http://localhost:5000"
  } catch {
    Write-Warning "Port is listening, but HTTP request failed: $($_.Exception.Message)"
    Write-Output "Server process started (PID $($proc.Id)), but the first HTTP check failed. Visit http://localhost:5000 or inspect app output."
  }
} else {
  Write-Warning "Server did not start within 20 seconds. Check the app output, ensure port 5000 is free, and rerun .\scripts\start.ps1."
}
