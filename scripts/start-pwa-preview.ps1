[CmdletBinding()]
param(
    [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

function Write-Status {
    param([string]$Message)
    Write-Host "[whereas-pwa] $Message"
}

function Get-ListeningProcessId {
    param([int]$Port)
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        return [int]$listener.OwningProcess
    }
    return $null
}

function Wait-ForHttpOk {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
            if ($response.StatusCode -eq 200) {
                return
            }
        }
        catch {
            Start-Sleep -Milliseconds 500
            continue
        }
        Start-Sleep -Milliseconds 500
    }

    throw "Timed out waiting for $Url"
}

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Start-ManagedProcess {
    param(
        [string]$Name,
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$WorkingDirectory,
        [string]$PidFile,
        [string]$StdoutLog,
        [string]$StderrLog,
        [hashtable]$EnvironmentVariables = @{}
    )

    if (Test-Path -LiteralPath $PidFile) {
        $existingPid = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($existingPid) {
            $existingProcess = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
            if ($existingProcess) {
                Write-Status "$Name already running (PID $existingPid)"
                return
            }
        }
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }

    $commandParts = @()
    foreach ($pair in $EnvironmentVariables.GetEnumerator()) {
        $escapedValue = $pair.Value.Replace("'", "''")
        $commandParts += "`$env:$($pair.Key)='$escapedValue'"
    }

    $quotedFilePath = $FilePath.Replace("'", "''")
    $renderedArgs = $ArgumentList | ForEach-Object {
        "'" + $_.Replace("'", "''") + "'"
    }
    $commandParts += "& '$quotedFilePath' $($renderedArgs -join ' ')"
    $wrappedCommand = $commandParts -join "; "

    $process = Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @("-NoLogo", "-NoProfile", "-Command", $wrappedCommand) `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StdoutLog `
        -RedirectStandardError $StderrLog `
        -PassThru

    Set-Content -LiteralPath $PidFile -Value $process.Id
    Write-Status "Started $Name (PID $($process.Id))"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$runRoot = Join-Path $repoRoot ".local\run"
$logRoot = Join-Path $repoRoot ".local\logs"
$frontendRoot = Join-Path $repoRoot "frontend"
$startLocalStackScript = Join-Path $repoRoot "scripts\start-local-stack.ps1"
$frontendPidFile = Join-Path $runRoot "pwa-preview.pid"
$frontendStdoutLog = Join-Path $logRoot "pwa-preview.stdout.log"
$frontendStderrLog = Join-Path $logRoot "pwa-preview.stderr.log"
$frontendUrl = "http://127.0.0.1:4173/"

Ensure-Directory $runRoot
Ensure-Directory $logRoot

Write-Status "Ensuring local backend stack is running"
& $startLocalStackScript
if ($LASTEXITCODE -ne 0) {
    throw "start-local-stack.ps1 failed"
}

Write-Status "Building production frontend for PWA preview"
$env:VITE_API_BASE_URL = "http://localhost:8000"
$env:VITE_WHEREAS_DEMO_MODE = "false"
Push-Location $frontendRoot
try {
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed"
    }
}
finally {
    Pop-Location
}

$existingPreviewPid = Get-ListeningProcessId -Port 4173
if ($existingPreviewPid) {
    Set-Content -LiteralPath $frontendPidFile -Value $existingPreviewPid
    Write-Status "PWA preview already running (PID $existingPreviewPid)"
}
else {
    Start-ManagedProcess `
        -Name "pwa-preview" `
        -FilePath "C:\Program Files\nodejs\npm.cmd" `
        -ArgumentList @("run", "preview", "--", "--host", "127.0.0.1", "--port", "4173") `
        -WorkingDirectory $frontendRoot `
        -PidFile $frontendPidFile `
        -StdoutLog $frontendStdoutLog `
        -StderrLog $frontendStderrLog `
        -EnvironmentVariables @{
            VITE_API_BASE_URL = "http://localhost:8000"
            VITE_WHEREAS_DEMO_MODE = "false"
        }
}

Wait-ForHttpOk -Url $frontendUrl -TimeoutSeconds 30

Write-Status "PWA preview: $frontendUrl"
Write-Status "App onboarding: ${frontendUrl}demo/welcome"
Write-Status "Backend API:  http://127.0.0.1:8000/api/health"
Write-Status "Browser preview keeps the marketing site at /"
Write-Status "Install test: open the site in Chrome/Edge, use Install App, then the installed PWA will start at /demo/welcome"

if ($OpenBrowser) {
    Start-Process $frontendUrl
}
