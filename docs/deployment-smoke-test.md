# Deployment / self-host smoke test

## 1. Purpose

This is a **post-install / post-deploy smoke test** for Whereas.

- It helps an evaluator answer: **"Did I deploy Whereas correctly?"**
- It is **not** a full production hardening guide.
- It covers:
  - frontend demo mode (no backend dependency)
  - self-host backend mode
  - full-stack local verification

Related docs:

- [local-developer-quickstart.md](local-developer-quickstart.md)
- [optional-dependencies.md](optional-dependencies.md)
- [mvp-smoke-checklist.md](mvp-smoke-checklist.md)
- [security-notes.md](security-notes.md)

## 2. Prerequisites

Before running this checklist, confirm:

Frontend:

- Node + npm installed
- frontend dependencies installed
- frontend build runs (`npm run build`)

Backend:

- Python environment available
- editable backend dev install works (`pip install -e ".[dev]"`)
- database configured
- migrations run (`alembic upgrade head`)
- encryption/storage config available (`WHEREAS_INSTANCE_KEY` and S3-compatible settings)

Optional integrations:

- LibreOffice (`libreoffice` / `soffice`) for DOCX -> PDF preview
- MarkItDown for richer Text preview conversion
- DocuSeal for signing flows
- Ollama is optional for extraction paths and is not required for core MVP routing/surfaces

## 3. Frontend-only demo smoke test

Use this when validating UI behavior without a live backend.

Commands:

```sh
cd frontend
npm install
npm test -- --run
npm run build
npm run dev
# or:
# npm run preview
```

Checklist:

- [ ] app loads in browser
- [ ] `/demo/dashboard` loads
- [ ] `/demo/repository` loads
- [ ] Repository search works
- [ ] Quick Views and Advanced filters work
- [ ] `/demo/requests` loads and at least one request detail route loads (`/demo/requests/:id`)
- [ ] `/demo/requests/templates` loads and at least one template detail route loads (`/demo/requests/templates/:id`)
- [ ] `/demo/approvals` loads, and tasks/workflow detail routes load
- [ ] no unexpected runtime errors in console
- [ ] no unexpected API/service-worker cache surprises during reloads (demo mode should not depend on live `/api/*` responses)
- [ ] demo mode does not require live backend storage or DocuSeal

Notes:

- Demo mode uses frontend mock data.
- Backend APIs, object storage, and DocuSeal are not required for this section.

## 4. Backend smoke test

Run against a real backend install.

Commands (from `backend/`):

```sh
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
ruff check .
pytest
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

If you follow the `uv` workflow from [local-developer-quickstart.md](local-developer-quickstart.md), use:

```sh
cd backend
uv sync --extra dev
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000
```

Checklist:

- [ ] `GET /api/setup/status` responds (200)
- [ ] unauthenticated protected route returns a safe error shape (for example `GET /api/contracts` without `X-Whereas-Dev-User` returns 401 in dev flows)
- [ ] dev bootstrap assumptions behave as documented (`POST /api/setup/dev` is development-only)
- [ ] Repository list endpoint responds (`GET /api/contracts`)
- [ ] Agreement Templates list endpoint responds (`GET /api/agreement-templates`)
- [ ] Requests list endpoint responds (`GET /api/requests`)
- [ ] Dashboard summary endpoint responds (`GET /api/dashboard/summary`)

Example endpoint checks:

```sh
curl -i http://localhost:8000/api/setup/status
curl -i http://localhost:8000/api/contracts
```

With a dev user header:

```sh
curl -i -H "X-Whereas-Dev-User: <DEV_USER_UUID>" http://localhost:8000/api/contracts
curl -i -H "X-Whereas-Dev-User: <DEV_USER_UUID>" http://localhost:8000/api/agreement-templates
curl -i -H "X-Whereas-Dev-User: <DEV_USER_UUID>" http://localhost:8000/api/requests
curl -i -H "X-Whereas-Dev-User: <DEV_USER_UUID>" http://localhost:8000/api/dashboard/summary
```

## 5. Full-stack smoke test

Run this with frontend + backend up together.

Core checklist:

- [ ] create/upload a Repository record (if backend storage configured)
- [ ] Repository list/detail load
- [ ] Text preview appears when conversion output is available
- [ ] Document History appears for records with artifacts
- [ ] per-artifact download works
- [ ] compare/redline workflow works
- [ ] Request can convert into a Repository record
- [ ] template generation produces a Repository draft artifact
- [ ] approval tasks/workflow detail can be viewed and acted on
- [ ] activity export works
- [ ] duplicate merge workflow works

Optional checklist items:

- [ ] DOCX preview works (requires LibreOffice)
- [ ] signing flow works end-to-end (requires DocuSeal + webhook secret configuration)
- [ ] Text preview structure quality is acceptable for your deployment (improves with MarkItDown availability)

## 6. Security sanity checks

- [ ] built service worker still excludes `/api/*`
- [ ] no presigned/private storage URLs are exposed in UI/API payloads
- [ ] no storage internals (`storage_key`, `wrapped_dek`, raw object keys) appear in API responses
- [ ] `DOCUSEAL_WEBHOOK_SECRET` is set in production when DocuSeal is enabled
- [ ] `WHEREAS_INSTANCE_KEY` is set correctly for encrypted storage
- [ ] dev bootstrap/setup flow is not exposed in production operation unless intentionally documented

Service worker denylist check:

```sh
cd frontend
npm run build
grep -F "denylist:[/^\\/api\\//]" dist/sw.js
```

## 7. Troubleshooting

| Symptom | Likely cause | What to check | Fix |
| --- | --- | --- | --- |
| Frontend builds but API calls fail | backend not running, wrong `VITE_API_BASE_URL`, or missing dev user header | browser network tab, backend health/setup endpoints | start backend, verify frontend env, set/create dev user |
| Backend tests fail with async config errors | backend dev extras not installed in active Python | `pip show pytest-asyncio` in active venv | run `pip install -e ".[dev]"` |
| DOCX preview unavailable | LibreOffice not installed/on PATH | backend logs and `which libreoffice` / `which soffice` | install LibreOffice and restart backend |
| Text preview missing/low fidelity | converter unavailable or conversion fallback path used | template/contract markdown endpoint behavior and logs | install MarkItDown for higher fidelity; fallback plain text is expected when unavailable |
| DocuSeal webhook rejected | webhook secret mismatch or missing | backend env and webhook signature headers | set matching `DOCUSEAL_WEBHOOK_SECRET` on both sides |
| Downloads fail | storage endpoint/credentials/encryption key misconfigured | backend storage env vars and `WHEREAS_INSTANCE_KEY` | correct storage and key config, restart backend |
| App looks stale after deploy | old service worker/client cache | browser Application/Service Worker state and built `dist/sw.js` | hard refresh / unregister old SW, redeploy current build |

## 8. Minimal "green enough" criteria

Treat deployment as green enough when all are true:

- [ ] frontend build passes
- [ ] backend tests pass (or a targeted backend smoke set passes when full suite is intentionally deferred)
- [ ] `/api/*` is not cached by service worker
- [ ] core demo routes load (`/demo/dashboard`, `/demo/repository`, `/demo/requests`, `/demo/approvals`)
- [ ] key backend endpoints respond (`/api/setup/status`, contracts/templates/requests lists, dashboard summary)
- [ ] optional dependencies are explicitly documented when not installed
