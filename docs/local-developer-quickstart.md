# Local developer quickstart

A practical, step-by-step guide to running Whereas on your own machine
end-to-end. Pre-v0.1; production deployment is out of scope here.

The fastest workflow is **Docker for infrastructure, host for the app**:
Postgres / MinIO / Ollama run in containers; the Python backend and the
Vite frontend run on your machine so iteration is fast and stack traces
are immediate.

> Heads up: the docker-compose file also ships a `backend` service that
> runs the whole stack in containers (it now injects `WHEREAS_INSTANCE_KEY`
> and runs `alembic upgrade head` on startup). The host workflow below is
> still recommended for day-to-day development since it gives faster
> iteration and native stack traces. See "Docker unavailable" in
> [Troubleshooting](#troubleshooting) for a fully-host alternative.

## 1. Prerequisites

| Tool             | Version | Why                                                |
| ---------------- | ------- | -------------------------------------------------- |
| Git              | any     | Clone the repo.                                    |
| Docker + Compose | any     | Postgres, MinIO, optionally Ollama.                |
| Python           | 3.11+   | Backend runtime.                                   |
| `uv`             | latest  | Manages the Python venv and runs commands.         |
| Node.js          | 22.x    | Frontend dev server.                               |
| `npm`            | bundled | Frontend deps.                                     |

`uv` install: <https://docs.astral.sh/uv/>. Anything that gives you a
working Python 3.11 + pip will also work; commands below show the `uv`
path because that is what the backend's `pyproject.toml` is intended
for.

## 2. Clone the repo

```
git clone https://github.com/foolish-bandit/whereas.git
cd whereas
```

## 3. Environment variables

Whereas reads configuration from environment variables (loaded from
`.env` if present in the working directory). Create a `.env` at the
repo root with at least these values:

```
# 32-byte hex strings. Generate fresh values; do not copy these.
SECRET_KEY=<64 hex chars>
WHEREAS_INSTANCE_KEY=<64 hex chars>
DOCUSEAL_AUTH_BRIDGE_SECRET=<any random string>

# Match the values used by the local infra services below.
POSTGRES_USER=whereas
POSTGRES_PASSWORD=whereas
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin

# Tells the backend (when run on the host) how to reach the local
# infra services that are bound on 127.0.0.1 by docker compose.
DATABASE_URL=postgresql+asyncpg://whereas:whereas@localhost:5432/whereas
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin

# DocuSeal is optional for development. If you don't run it, this is
# unused; if you do, give it a random hex string.
DOCUSEAL_SECRET_KEY_BASE=<random>

ENVIRONMENT=development
```

Generate the hex secrets with:

```
python -c 'import secrets; print(secrets.token_hex(32))'
```

`WHEREAS_INSTANCE_KEY` must be exactly 64 hex characters (32 bytes).
The backend refuses to start if it is missing or the wrong length, by
design — encryption is configured or the app does not run.

The frontend reads its own env vars from `frontend/.env.local` (see
`frontend/.env.example`):

```
VITE_API_BASE_URL=http://localhost:8000
# VITE_WHEREAS_DEMO_MODE=true   # uncomment for the offline demo
```

`VITE_API_BASE_URL` defaults to `http://localhost:8000`, so the line
above is only needed if you point the frontend at a different backend.

## 4. Start infrastructure

Bring up just the data plane services:

```
docker compose up -d postgres minio
```

Add `ollama` if you want extraction to work end-to-end:

```
docker compose up -d postgres minio ollama
```

Pulling a model into Ollama is a one-time slow step:

```
docker exec -it whereas-ollama ollama pull llama3.1:8b
```

(The compose file defaults `EXTRACTION_MODEL` to `llama3.1:70b`, which
is large. Override `EXTRACTION_MODEL` in `.env` to a smaller model
like `llama3.1:8b` if you don't have the disk/RAM for 70b.)

Verify the services came up:

```
docker compose ps
curl -fsS http://localhost:9000/minio/health/live
```

## 5. Run migrations

`docker compose up` does **not** auto-migrate (intentional — see
`backend/alembic/README.md`). Run Alembic explicitly the first time and
after every pull that adds migration files:

```
cd backend
uv sync --extra dev
uv run alembic upgrade head
```

`uv sync` resolves and installs the backend dependencies into a local
virtualenv on first use. Subsequent runs are fast.

### Running backend tests

`uv sync --extra dev` (or `pip install -e ".[dev]"` if you prefer
plain pip) is what installs **pytest** and **pytest-asyncio**. The
backend's `pyproject.toml` sets `asyncio_mode = "auto"` and
`asyncio_default_fixture_loop_scope = "function"`; both options
require pytest-asyncio. Running `pytest` from a Python that does not
have pytest-asyncio installed prints "Unknown config option:
asyncio_mode" and silently skips async test discovery — fix by
installing the dev extras into the venv you actually run pytest from,
not by removing the config keys.

```
cd backend
uv run pytest
# or, with the venv activated:
pytest
```

The DOCX preview tests stub LibreOffice; you do not need a local
`libreoffice` / `soffice` binary to run the suite.

## 6. Start the backend

From `backend/`, with the same `.env` from step 3 picked up
automatically by pydantic-settings:

```
uv run uvicorn app.main:app --reload --port 8000
```

The first request after startup is a connectivity probe; you should
see "Database connectivity verified" and "Encryption instance key
validated" in the logs. The API is now at `http://localhost:8000`,
docs at `http://localhost:8000/api/docs`.

## 7. Start the frontend

In a second terminal:

```
cd frontend
npm install
npm run dev
```

The Vite dev server listens on `http://localhost:5173`. The backend
already allowlists this origin in development (see
`backend/app/main.py`), so no CORS configuration is needed.

## 8. Open Settings

Browse to `http://localhost:5173`. The contracts page shows a yellow
warning banner: "Set a development user ID to call the local API."
Click **Open settings** (or use the sidebar's **Settings** link).

## 9. Create the local development workspace

On the Settings page, the **First-run setup** card is at the top. The
optional fields are pre-filled with sensible defaults:

| Field             | Default              |
| ----------------- | -------------------- |
| Organization name | `Local Workspace`    |
| User email        | `dev@whereas.local`  |
| Display name      | `Local Developer`    |

Click **Create local development workspace**. Behind the scenes this
calls `POST /api/setup/dev`, which:

- creates an `Organization` row with a wrapped master key,
- creates an active `User` row,
- writes a `USER_CREATED` audit event,
- returns the user's UUID,

and the frontend stores that UUID in `localStorage` under
`whereas.devUserId`, then sends it as `X-Whereas-Dev-User` on every
subsequent API call. **This is not real authentication.** It is a
temporary bridge so a local developer has a working caller identity.
The endpoint returns 403 when `ENVIRONMENT=production`.

The card shows a green "Created new development workspace." panel with
a link to `/contracts`.

## 10. Upload a contract

On the Upload page, drop a PDF or DOCX (under 50 MB) into the dropzone
or click **browse files**. After upload:

- The contract appears in the repository list with status `extracting`
  while Ollama is running, then `ready`.
- The workspace view shows the document text and the extracted-metadata
  panel. Clicking a field highlights its citation span.
- "Download original" streams the encrypted blob back through the
  backend, decrypts it, and triggers a browser download.

If Ollama is not running or no model is pulled, the contract will land
with status `failed` and the upload page surfaces a "metadata
extraction failed" warning. The document is still stored and
downloadable; only the extraction step failed.

## 11. Troubleshooting

### Missing dev user

Symptom: yellow "Set a development user ID to call the local API."
banner; API calls return 401 with `Missing X-Whereas-Dev-User header`.

Fix: complete step 9. If you cleared `localStorage` or are on a fresh
browser, just click **Create local development workspace** again — the
endpoint is idempotent and returns the existing user.

### Backend not running

Symptom: red error state on the contracts page that says "Could not
reach the backend. Is the API running?"

Fix:

```
curl -fsS http://localhost:8000/api/health
```

If that fails, restart the backend (step 6) and check its logs. If
`curl` succeeds but the frontend still errors, check
`VITE_API_BASE_URL` in `frontend/.env.local` and restart `npm run
dev` — Vite reads env vars at startup, not per request.

### CORS / API base URL issue

Symptom: browser console shows a CORS error or the request hits the
wrong host.

Fix: the backend allowlists `http://localhost:5173` and
`http://localhost:8080` in `development` mode only (see
`backend/app/main.py`). Make sure:

- `ENVIRONMENT=development` is set in the backend env.
- The frontend is on `http://localhost:5173` (the Vite default), not
  `127.0.0.1:5173` or another port.
- `VITE_API_BASE_URL` matches the backend's actual host:port.

### Instance key missing or malformed

Symptom: backend startup fails with
`WHEREAS_INSTANCE_KEY is not set` or
`WHEREAS_INSTANCE_KEY must be 32 bytes`.

Fix: generate a fresh value and put it in `.env`:

```
python -c 'import secrets; print(secrets.token_hex(32))'
```

It must be exactly 64 hex chars. Whereas refuses to run without one
because every encryption operation requires it.

### Docker unavailable

If you can't run Docker, you can substitute managed equivalents and
keep the rest of the steps the same:

- Postgres 16 with the `pgvector` extension (the genesis migration
  runs `CREATE EXTENSION vector`).
- Any S3-compatible object store, with `S3_ENDPOINT`, `S3_ACCESS_KEY`,
  `S3_SECRET_KEY`, and `S3_BUCKET` pointed at it.
- Ollama or any OpenAI-compatible LLM endpoint, with `LITELLM_PROVIDER`
  and the relevant API key set.

Or skip the backend entirely and run the [demo mode](#12-demo-mode)
instead — useful for UI work that doesn't need a real backend.

### Parser / model startup slowness

The first upload after starting Ollama is slow because Ollama pulls
the model weights into RAM. Subsequent extractions are faster.

The first run of `uv sync --extra dev` is also slow on a fresh machine
because it pulls heavy parser deps (`docling`, `pdfplumber`,
`pdf2image`, `pytesseract`) and the LLM client (`litellm`). Expect a
few minutes the first time; the venv is cached afterward.

If extraction times out, lower the timeout in `EXTRACTION_MODEL` to a
smaller Ollama model (e.g. `llama3.1:8b`) or set
`LLM_REQUEST_TIMEOUT_SECONDS` higher.

## 12. Demo mode

The hosted preview at <https://whereas.pages.dev/> runs the frontend
in **demo mode** with sample data. There is no backend behind it. It
is useful for UI review and for getting a feel for the app without
running anything locally, but:

- Sample contracts are fictional and labeled as such by the persistent
  blue "Demo mode" banner.
- "Uploads" go to in-memory state in your browser tab and are wiped
  on refresh. **Real document uploads require a local backend** (steps
  4–10) **or a backend you have deployed yourself.**
- "Download original" returns a small placeholder text file, not a
  real document.

To run demo mode locally for UI work without standing up Postgres /
MinIO / Ollama, set the env var and start the frontend on its own:

```
cd frontend
echo 'VITE_WHEREAS_DEMO_MODE=true' > .env.local
npm install
npm run dev
```

See `frontend/README.md` for the full demo-mode reference.
