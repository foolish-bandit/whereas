[CmdletBinding()]
param(
    [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

function Write-Status {
    param([string]$Message)
    Write-Host "[whereas] $Message"
}

function Test-PortListening {
    param([int]$Port)
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    return $null -ne $listener
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

function New-HexSecret {
    param([int]$Bytes = 32)
    $buffer = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
    return ($buffer | ForEach-Object { $_.ToString("x2") }) -join ""
}

function Get-CommandPathOrNull {
    param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    return $null
}

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Ensure-FileContainsLine {
    param(
        [string]$Path,
        [string]$Pattern,
        [string]$Line
    )

    $lines = @()
    if (Test-Path -LiteralPath $Path) {
        $lines = Get-Content -LiteralPath $Path
    }

    $replaced = $false
    $next = foreach ($existing in $lines) {
        if ($existing -match $Pattern) {
            $replaced = $true
            $Line
        }
        elseif ($Pattern -eq '^VITE_WHEREAS_DEMO_MODE=' -and $existing -match '^VITE_WHEREAS_DEMO_MODE=') {
            continue
        }
        else {
            $existing
        }
    }

    if (-not $replaced) {
        $next += $Line
    }

    Set-Content -LiteralPath $Path -Value $next
}

function Load-DotEnvIntoProcess {
    param([string]$Path)

    Get-Content -LiteralPath $Path | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -match '^\s*$') {
            return
        }
        if ($_ -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
}

function Invoke-CmdChecked {
    param(
        [string]$Command,
        [string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        cmd.exe /c $Command
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $Command"
        }
    }
    finally {
        Pop-Location
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
        $existingPid = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($existingPid) {
            $process = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
            if ($process) {
                Write-Status "$Name already running (PID $existingPid)"
                return $process.Id
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
    return $process.Id
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $repoRoot ".local"
$runRoot = Join-Path $localRoot "run"
$logRoot = Join-Path $localRoot "logs"
$backendRoot = Join-Path $repoRoot "backend"
$frontendRoot = Join-Path $repoRoot "frontend"
$envPath = Join-Path $repoRoot ".env"
$frontendEnvPath = Join-Path $frontendRoot ".env.local"
$localPgRoot = Join-Path $localRoot "pgsql17-local"
$localPgData = Join-Path $localRoot "pgdata"
$pgvectorRoot = Join-Path $localRoot "pgvector"
$uvPath = Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\Scripts\uv.exe"

Ensure-Directory $localRoot
Ensure-Directory $runRoot
Ensure-Directory $logRoot

if (-not (Test-Path -LiteralPath $envPath)) {
    Write-Status "Creating repo-local .env"
    @(
        "SECRET_KEY=$(New-HexSecret)"
        "WHEREAS_INSTANCE_KEY=$(New-HexSecret)"
        "DOCUSEAL_AUTH_BRIDGE_SECRET=$(New-HexSecret)"
        "DOCUSEAL_SECRET_KEY_BASE=$(New-HexSecret)"
        "POSTGRES_USER=whereas"
        "POSTGRES_PASSWORD=whereas"
        "MINIO_ROOT_USER=minioadmin"
        "MINIO_ROOT_PASSWORD=minioadmin"
        "DATABASE_URL=postgresql+asyncpg://whereas:whereas@localhost:5433/whereas"
        "S3_ENDPOINT=http://localhost:9000"
        "S3_ACCESS_KEY=minioadmin"
        "S3_SECRET_KEY=minioadmin"
        "S3_BUCKET=whereas-documents"
        "LITELLM_PROVIDER=ollama"
        "OLLAMA_BASE_URL=http://localhost:11434"
        "EMBEDDING_MODEL=bge-m3"
        "EXTRACTION_MODEL=llama3.1:8b"
        "DOCUSEAL_BASE_URL=http://localhost:8081"
        "ENVIRONMENT=development"
    ) | Set-Content -LiteralPath $envPath
}

Ensure-FileContainsLine -Path $frontendEnvPath -Pattern '^VITE_API_BASE_URL=' -Line 'VITE_API_BASE_URL=http://localhost:8000'

$postgresExe = Join-Path $localPgRoot "bin\postgres.exe"
if (-not (Test-Path -LiteralPath $postgresExe)) {
    $systemPgRoot = "C:\Program Files\PostgreSQL\17"
    if (-not (Test-Path -LiteralPath (Join-Path $systemPgRoot "bin\postgres.exe"))) {
        throw "System PostgreSQL 17 is not installed at $systemPgRoot"
    }

    Write-Status "Copying PostgreSQL runtime into .local"
    Ensure-Directory $localPgRoot
    Copy-Item -Path (Join-Path $systemPgRoot "bin") -Destination $localPgRoot -Recurse -Force
    Copy-Item -Path (Join-Path $systemPgRoot "lib") -Destination $localPgRoot -Recurse -Force
    Copy-Item -Path (Join-Path $systemPgRoot "share") -Destination $localPgRoot -Recurse -Force
    Copy-Item -Path (Join-Path $systemPgRoot "include") -Destination $localPgRoot -Recurse -Force
}

$vectorControl = Join-Path $localPgRoot "share\extension\vector.control"
if (-not (Test-Path -LiteralPath $vectorControl)) {
    if (-not (Test-Path -LiteralPath $pgvectorRoot)) {
        Write-Status "Cloning pgvector"
        Push-Location $localRoot
        try {
            git clone --branch v0.8.2 https://github.com/pgvector/pgvector.git $pgvectorRoot
            if ($LASTEXITCODE -ne 0) {
                throw "git clone failed"
            }
        }
        finally {
            Pop-Location
        }
    }

    $vcvarsPath = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    if (-not (Test-Path -LiteralPath $vcvarsPath)) {
        throw "Visual Studio Build Tools vcvars64.bat not found at $vcvarsPath"
    }

    Write-Status "Building pgvector into local PostgreSQL runtime"
    $buildCommand = @"
call "$vcvarsPath"
set "PGROOT=$localPgRoot"
cd /d "$pgvectorRoot"
nmake /F Makefile.win
if errorlevel 1 exit /b 1
nmake /F Makefile.win install
"@
    $buildScriptPath = Join-Path $localRoot "build-pgvector.cmd"
    Set-Content -LiteralPath $buildScriptPath -Value $buildCommand
    Invoke-CmdChecked -Command $buildScriptPath -WorkingDirectory $localRoot
}

$initDbExe = Join-Path $localPgRoot "bin\initdb.exe"
$pgCtlExe = Join-Path $localPgRoot "bin\pg_ctl.exe"
$createdbExe = Join-Path $localPgRoot "bin\createdb.exe"
$dropdbExe = Join-Path $localPgRoot "bin\dropdb.exe"
$psqlExe = Join-Path $localPgRoot "bin\psql.exe"

if (-not (Test-Path -LiteralPath $localPgData)) {
    Write-Status "Initializing local PostgreSQL cluster"
    $pwFile = Join-Path $localRoot "pgpass-init.txt"
    Set-Content -LiteralPath $pwFile -Value "whereas" -NoNewline
    try {
        & $initDbExe -D $localPgData -U whereas "--pwfile=$pwFile" --auth-host=scram-sha-256 --auth-local=trust
        if ($LASTEXITCODE -ne 0) {
            throw "initdb failed"
        }
    }
    finally {
        Remove-Item -LiteralPath $pwFile -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-PortListening -Port 5433)) {
    Write-Status "Starting local PostgreSQL on 5433"
    & $pgCtlExe start -D $localPgData -l (Join-Path $logRoot "postgres.log") -o "-p 5433"
    if ($LASTEXITCODE -ne 0) {
        throw "pg_ctl start failed"
    }
    Start-Sleep -Seconds 2
}

$env:PGPASSWORD = "whereas"
$dbExists = & $psqlExe -h 127.0.0.1 -p 5433 -U whereas -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'whereas';"
if ($dbExists.Trim() -ne "1") {
    Write-Status "Creating local whereas database"
    & $createdbExe -h 127.0.0.1 -p 5433 -U whereas -E UTF8 -T template0 whereas
    if ($LASTEXITCODE -ne 0) {
        throw "createdb failed"
    }
}

Write-Status "Ensuring pgvector extension"
& $psqlExe -h 127.0.0.1 -p 5433 -U whereas -d whereas -c "CREATE EXTENSION IF NOT EXISTS vector;"
if ($LASTEXITCODE -ne 0) {
    throw "CREATE EXTENSION vector failed"
}

$backendPython = Join-Path $backendRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $backendPython)) {
    throw "Backend virtualenv is missing at $backendPython"
}

Write-Status "Ensuring moto server extras are installed"
& $backendPython -c "import flask, moto"
if ($LASTEXITCODE -ne 0) {
    if (-not (Test-Path -LiteralPath $uvPath)) {
        throw "uv.exe not found at $uvPath"
    }
    & $uvPath pip install --python $backendPython "moto[server]"
    if ($LASTEXITCODE -ne 0) {
        throw "Installing moto[server] failed"
    }
}

if (-not (Test-PortListening -Port 9000)) {
    Start-ManagedProcess `
        -Name "moto" `
        -FilePath $backendPython `
        -ArgumentList @("-m", "moto.server", "-H", "127.0.0.1", "-p", "9000") `
        -WorkingDirectory $repoRoot `
        -PidFile (Join-Path $runRoot "moto.pid") `
        -StdoutLog (Join-Path $logRoot "moto.stdout.log") `
        -StderrLog (Join-Path $logRoot "moto.stderr.log") | Out-Null

    Start-Sleep -Seconds 2
}
else {
    $existingMotoPid = Get-ListeningProcessId -Port 9000
    if ($existingMotoPid) {
        Set-Content -LiteralPath (Join-Path $runRoot "moto.pid") -Value $existingMotoPid
        Write-Status "moto already running (PID $existingMotoPid)"
    }
}

Load-DotEnvIntoProcess -Path $envPath
$env:PYTHONPATH = $backendRoot

Write-Status "Running database migrations"
& (Join-Path $backendRoot ".venv\Scripts\alembic.exe") -c (Join-Path $backendRoot "alembic.ini") upgrade head
if ($LASTEXITCODE -ne 0) {
    throw "Alembic upgrade failed"
}

if (-not (Test-PortListening -Port 8000)) {
    Start-ManagedProcess `
        -Name "backend" `
        -FilePath $backendPython `
        -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000") `
        -WorkingDirectory $repoRoot `
        -PidFile (Join-Path $runRoot "backend.pid") `
        -StdoutLog (Join-Path $logRoot "backend.stdout.log") `
        -StderrLog (Join-Path $logRoot "backend.stderr.log") `
        -EnvironmentVariables @{
            PYTHONPATH = $backendRoot
            SECRET_KEY = [Environment]::GetEnvironmentVariable("SECRET_KEY", "Process")
            WHEREAS_INSTANCE_KEY = [Environment]::GetEnvironmentVariable("WHEREAS_INSTANCE_KEY", "Process")
            DOCUSEAL_AUTH_BRIDGE_SECRET = [Environment]::GetEnvironmentVariable("DOCUSEAL_AUTH_BRIDGE_SECRET", "Process")
            DOCUSEAL_SECRET_KEY_BASE = [Environment]::GetEnvironmentVariable("DOCUSEAL_SECRET_KEY_BASE", "Process")
            POSTGRES_USER = [Environment]::GetEnvironmentVariable("POSTGRES_USER", "Process")
            POSTGRES_PASSWORD = [Environment]::GetEnvironmentVariable("POSTGRES_PASSWORD", "Process")
            MINIO_ROOT_USER = [Environment]::GetEnvironmentVariable("MINIO_ROOT_USER", "Process")
            MINIO_ROOT_PASSWORD = [Environment]::GetEnvironmentVariable("MINIO_ROOT_PASSWORD", "Process")
            DATABASE_URL = [Environment]::GetEnvironmentVariable("DATABASE_URL", "Process")
            S3_ENDPOINT = [Environment]::GetEnvironmentVariable("S3_ENDPOINT", "Process")
            S3_ACCESS_KEY = [Environment]::GetEnvironmentVariable("S3_ACCESS_KEY", "Process")
            S3_SECRET_KEY = [Environment]::GetEnvironmentVariable("S3_SECRET_KEY", "Process")
            S3_BUCKET = [Environment]::GetEnvironmentVariable("S3_BUCKET", "Process")
            LITELLM_PROVIDER = [Environment]::GetEnvironmentVariable("LITELLM_PROVIDER", "Process")
            OLLAMA_BASE_URL = [Environment]::GetEnvironmentVariable("OLLAMA_BASE_URL", "Process")
            EMBEDDING_MODEL = [Environment]::GetEnvironmentVariable("EMBEDDING_MODEL", "Process")
            EXTRACTION_MODEL = [Environment]::GetEnvironmentVariable("EXTRACTION_MODEL", "Process")
            DOCUSEAL_BASE_URL = [Environment]::GetEnvironmentVariable("DOCUSEAL_BASE_URL", "Process")
            ENVIRONMENT = [Environment]::GetEnvironmentVariable("ENVIRONMENT", "Process")
        } | Out-Null

    Start-Sleep -Seconds 3
}
else {
    $existingBackendPid = Get-ListeningProcessId -Port 8000
    if ($existingBackendPid) {
        Set-Content -LiteralPath (Join-Path $runRoot "backend.pid") -Value $existingBackendPid
        Write-Status "backend already running (PID $existingBackendPid)"
    }
}

$nodeModulesVite = Join-Path $frontendRoot "node_modules\vite"
if (-not (Test-Path -LiteralPath $nodeModulesVite)) {
    Write-Status "Installing frontend dependencies"
    Push-Location $frontendRoot
    try {
        npm.cmd install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed"
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-PortListening -Port 5173)) {
    Start-ManagedProcess `
        -Name "frontend" `
        -FilePath "C:\Program Files\nodejs\npm.cmd" `
        -ArgumentList @("run", "dev", "--", "--host", "127.0.0.1") `
        -WorkingDirectory $frontendRoot `
        -PidFile (Join-Path $runRoot "frontend.pid") `
        -StdoutLog (Join-Path $logRoot "frontend.stdout.log") `
        -StderrLog (Join-Path $logRoot "frontend.stderr.log") `
        -EnvironmentVariables @{
            VITE_API_BASE_URL = "http://localhost:8000"
        } | Out-Null

    Start-Sleep -Seconds 3
}
else {
    $existingFrontendPid = Get-ListeningProcessId -Port 5173
    if ($existingFrontendPid) {
        Set-Content -LiteralPath (Join-Path $runRoot "frontend.pid") -Value $existingFrontendPid
        Write-Status "frontend already running (PID $existingFrontendPid)"
    }
}

$backendHealthUrl = "http://127.0.0.1:8000/api/health"
Wait-ForHttpOk -Url $backendHealthUrl -TimeoutSeconds 30
$backendHealth = Invoke-RestMethod -Uri $backendHealthUrl -TimeoutSec 10
if ($backendHealth.status -ne "ok") {
    throw "Backend health check failed"
}

Write-Status "Frontend: http://127.0.0.1:5173/"
Write-Status "App onboarding: http://127.0.0.1:5173/demo/welcome"
Write-Status "Backend:  http://127.0.0.1:8000/api/health"
Write-Status "Postgres: 127.0.0.1:5433"
Write-Status "S3 mock:  http://127.0.0.1:9000/"
Write-Status "Next step: use /demo/welcome for app onboarding; / stays on the marketing site"

if ($OpenBrowser) {
    Start-Process "http://127.0.0.1:5173/"
}
