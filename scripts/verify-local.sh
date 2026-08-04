#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

section() {
  printf '\n==> %s\n' "$1"
}

section "Frontend dependencies"
cd "$ROOT_DIR/frontend"
if [[ ! -d node_modules ]]; then
  npm ci
fi

section "Frontend tests"
npx vitest run

section "Frontend TypeScript"
npx tsc -b

section "Frontend production build"
npm run build

test -f dist/sw.js
grep -F 'denylist:[/^\/api\//]' dist/sw.js >/dev/null

section "Frontend production dependency audit"
npm audit --omit=dev --audit-level=high

section "Backend environment"
cd "$ROOT_DIR/backend"
PYTHON_BIN="${PYTHON_BIN:-python3}"
if [[ ! -d .venv ]]; then
  "$PYTHON_BIN" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'

section "Backend tests"
pytest

section "Backend lint"
ruff check .

section "Backend dependency audit"
python -m pip install pip-audit
pip-audit --ignore-vuln PYSEC-2026-1325

section "Docker Compose validation"
cd "$ROOT_DIR"
POSTGRES_PASSWORD=dummy \
MINIO_ROOT_PASSWORD=dummy \
DOCUSEAL_AUTH_BRIDGE_SECRET=dummy \
DOCUSEAL_SECRET_KEY_BASE=dummy \
SECRET_KEY=dummy \
WHEREAS_INSTANCE_KEY=dummy \
NANGO_ENCRYPTION_KEY=dummy \
NANGO_SECRET_KEY=dummy \
NANGO_WEBHOOK_SECRET=dummy \
NANGO_DASHBOARD_PASSWORD=dummy \
docker compose config -q

section "Verification complete"
