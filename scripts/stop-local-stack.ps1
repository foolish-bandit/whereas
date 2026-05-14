[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Write-Status {
    param([string]$Message)
    Write-Host "[whereas] $Message"
}

function Get-ListeningProcessId {
    param([int]$Port)
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        return [int]$listener.OwningProcess
    }
    return $null
}

function Stop-PidFileProcess {
    param(
        [string]$Name,
        [string]$PidFile,
        [int]$Port
    )

    $targetPid = $null
    if (Test-Path -LiteralPath $PidFile) {
        $pidValue = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($pidValue) {
            $targetPid = [int]$pidValue
        }
    }

    if (-not $targetPid -and $Port) {
        $targetPid = Get-ListeningProcessId -Port $Port
    }

    if ($targetPid) {
        $process = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -Id $process.Id -Force
            Write-Status "Stopped $Name (PID $($process.Id))"
        }
    }

    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$runRoot = Join-Path $repoRoot ".local\run"
$localPgRoot = Join-Path $repoRoot ".local\pgsql17-local"
$localPgData = Join-Path $repoRoot ".local\pgdata"
$pgCtlExe = Join-Path $localPgRoot "bin\pg_ctl.exe"

Stop-PidFileProcess -Name "pwa-preview" -PidFile (Join-Path $runRoot "pwa-preview.pid") -Port 4173
Stop-PidFileProcess -Name "frontend" -PidFile (Join-Path $runRoot "frontend.pid") -Port 5173
Stop-PidFileProcess -Name "backend" -PidFile (Join-Path $runRoot "backend.pid") -Port 8000
Stop-PidFileProcess -Name "moto" -PidFile (Join-Path $runRoot "moto.pid") -Port 9000

if ((Test-Path -LiteralPath $pgCtlExe) -and (Test-Path -LiteralPath $localPgData)) {
    & $pgCtlExe stop -D $localPgData -m fast
    if ($LASTEXITCODE -eq 0) {
        Write-Status "Stopped local PostgreSQL"
    }
    else {
        $postgresPid = Get-ListeningProcessId -Port 5433
        if ($postgresPid) {
            $process = Get-Process -Id $postgresPid -ErrorAction SilentlyContinue
            if ($process) {
                Stop-Process -Id $process.Id -Force
                Write-Status "Stopped local PostgreSQL (PID $postgresPid)"
            }
        }
    }
}
