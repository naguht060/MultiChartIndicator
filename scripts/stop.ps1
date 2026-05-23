<#
Stops the Flask app by killing any process listening on port 5000.
Usage: .\scripts\stop.ps1
#>
$ErrorActionPreference = 'Stop'

function Get-Port5000Pid {
  return netstat -ano | findstr :5000 | ForEach-Object {
    if ($_ -match '\s+(\d+)\s*$') { [int]$matches[1] }
  } | Where-Object { $_ -gt 0 } | Select-Object -First 1
}

$p = Get-Port5000Pid
if ($p) {
  Write-Output "Killing PID $p on port 5000"
  taskkill /PID $p /F
} else {
  Write-Output "No process listening on port 5000"
}
