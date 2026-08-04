$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RootDir = Split-Path -Parent $PSScriptRoot

function Write-Section([string]$Name) {
    Write-Host "`n==> $Name"
}

Write-Section "Frontend dependencies"
Push-Location (Join-Path $RootDir "frontend")
try {
    if (-not (Test-Path "node_modules")) {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    }

    Write-Section "Frontend tests"
    npx vitest run
    if ($LASTEXITCODE -ne 0) { throw "Frontend tests failed" }

    Write-Section "Frontend TypeScript"
    npx tsc -b
    if ($LASTEXITCODE -ne 0) { throw "TypeScript check failed" }

    Write-Section "Frontend production build"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }

    $ServiceWorker = Join-Path (Get-Location) "dist/sw.js"
    if (-not (Test-Path $ServiceWorker)) {
        throw "dist/sw.js was not created"
    }
    $ServiceWorkerText = Get-Content $ServiceWorker -Raw
    if (-not $ServiceWorkerText.Contains('denylist:[/^\/api\//]')) {
        throw "Service worker is missing the /api/* denylist"
    }

    Write-Section "Frontend production dependency audit"
    npm audit --omit=dev --audit-level=high
    if ($LASTEXITCODE -ne 0) { throw "Frontend dependency audit failed" }
}
finally {
    Pop-Location
}

Write-Section "Backend environment"
Push-Location (Join-Path $RootDir "backend")
try {
    $Python = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { "python" }
    if (-not (Test-Path ".venv")) {
        & $Python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw "Could not create backend virtual environment" }
    }

    $VenvPython = Join-Path (Get-Location) ".venv/Scripts/python.exe"
    & $VenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }
    & $VenvPython -m pip install -e ".[dev]"
    if ($LASTEXITCODE -ne 0) { throw "Backend dependency installation failed" }

    Write-Section "Backend tests"
    & $VenvPython -m pytest
    if ($LASTEXITCODE -ne 0) { throw "Backend tests failed" }

    Write-Section "Backend lint"
    & $VenvPython -m ruff check .
    if ($LASTEXITCODE -ne 0) { throw "Backend lint failed" }

    Write-Section "Backend dependency audit"
    & $VenvPython -m pip install pip-audit
    if ($LASTEXITCODE -ne 0) { throw "pip-audit installation failed" }
    & $VenvPython -m pip_audit --ignore-vuln PYSEC-2026-1325
    if ($LASTEXITCODE -ne 0) { throw "Backend dependency audit failed" }
}
finally {
    Pop-Location
}

Write-Section "Docker Compose validation"
$ComposeEnvironment = @{
    POSTGRES_PASSWORD = "dummy"
    MINIO_ROOT_PASSWORD = "dummy"
    DOCUSEAL_AUTH_BRIDGE_SECRET = "dummy"
    DOCUSEAL_SECRET_KEY_BASE = "dummy"
    SECRET_KEY = "dummy"
    WHEREAS_INSTANCE_KEY = "dummy"
    NANGO_ENCRYPTION_KEY = "dummy"
    NANGO_SECRET_KEY = "dummy"
    NANGO_WEBHOOK_SECRET = "dummy"
    NANGO_DASHBOARD_PASSWORD = "dummy"
}

$PreviousEnvironment = @{}
try {
    foreach ($Entry in $ComposeEnvironment.GetEnumerator()) {
        $PreviousEnvironment[$Entry.Key] = [Environment]::GetEnvironmentVariable(
            $Entry.Key,
            "Process"
        )
        [Environment]::SetEnvironmentVariable(
            $Entry.Key,
            $Entry.Value,
            "Process"
        )
    }

    Push-Location $RootDir
    try {
        docker compose config -q
        if ($LASTEXITCODE -ne 0) { throw "Docker Compose validation failed" }
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($Entry in $PreviousEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable(
            $Entry.Key,
            $Entry.Value,
            "Process"
        )
    }
}

Write-Section "Verification complete"
