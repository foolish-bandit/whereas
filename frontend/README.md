# Whereas Frontend

React + Vite + Tailwind. Pre-v0.1 contracts workspace UI.

A frontend-only preview is hosted at **https://whereas.pages.dev/**. It
runs in demo mode with sample data — no backend, no real contracts.

## Modes

The frontend has two modes, toggled at build time via env vars.

| Mode               | Env vars                                                          | Behavior                                                              |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Real backend**   | `VITE_API_BASE_URL=http://localhost:8000`                         | Calls the backend, sends `X-Whereas-Dev-User`, requires a dev user.   |
| **Demo / preview** | `VITE_WHEREAS_DEMO_MODE=true`                                     | Uses in-memory sample data. Never calls `fetch`. Banner shown.        |

Anything other than `true` for `VITE_WHEREAS_DEMO_MODE` (or omitted) keeps real-API mode.

## Local development — real backend

Requires Node 22.x and a running backend at `VITE_API_BASE_URL`.

```
cd frontend
npm install
cp .env.example .env.local   # adjust VITE_API_BASE_URL if needed
npm run dev
```

Open `http://localhost:5173`, then go to **Settings** and click
**Create local development workspace**. That bootstraps an organization, a
wrapped master key, and an active user, and stores the dev user UUID in
your browser. The endpoint backing this (`POST /api/setup/dev`) is
development-only and returns 403 when `ENVIRONMENT=production`. If you
already have a UUID from another source you can also paste it directly
into the Development user ID field. The backend allowlists this origin
in development (see `backend/app/main.py`); no CORS configuration is
needed.

## Local development — demo mode

Useful for working on UI without running Postgres / MinIO / Ollama.

```
cd frontend
npm install
echo 'VITE_WHEREAS_DEMO_MODE=true' > .env.local
npm run dev
```

A blue "Demo mode" banner appears, the contracts repository is populated
with three sample contracts, and uploads/downloads are simulated in
memory. No `fetch` call is made.

## Cloudflare Pages (hosted preview)

`https://whereas.pages.dev/` is wired to this repo. Project settings:

| Setting                  | Value                       |
| ------------------------ | --------------------------- |
| Root directory           | `frontend`                  |
| Build command            | `npm ci && npm run build`   |
| Build output directory   | `dist`                      |
| Node version             | `22`                        |

If `frontend/package-lock.json` is ever removed, change the build command
to `npm install && npm run build`.

### Environment variables

For the **frontend-only / demo preview** (default for `whereas.pages.dev`):

```
VITE_WHEREAS_DEMO_MODE=true
```

For an **optional real-backend preview** pointing at a deployed backend
(this is not what `whereas.pages.dev` is today):

```
VITE_API_BASE_URL=https://your-staging-api.example.com
VITE_WHEREAS_DEMO_MODE=false
```

`whereas.pages.dev` is **frontend-only / demo** unless `VITE_API_BASE_URL`
is set to a live backend. Sample contracts there are fictional; nothing
that you upload there is stored or sent anywhere.

### SPA routing

`frontend/public/_redirects` contains:

```
/* /index.html 200
```

so direct loads of `/contracts`, `/upload`, `/settings`, and
`/contracts/:id` are served by the SPA shell instead of 404'ing on
Cloudflare Pages.

## Other static hosts

The build artifact (`frontend/dist`) is a plain SPA bundle and can also be
served by GitHub Pages, Vercel, Netlify, or `nginx`. The same env vars and
SPA-fallback rule apply. The included `frontend/Dockerfile` builds an
nginx image with the SPA fallback baked in.

## Configuration

| Env var                    | Default                  | Description                                       |
| -------------------------- | ------------------------ | ------------------------------------------------- |
| `VITE_API_BASE_URL`        | `http://localhost:8000`  | Whereas backend base URL. Ignored in demo mode.   |
| `VITE_WHEREAS_DEMO_MODE`   | _unset_                  | Set to `true` to use mock data and skip the API.  |

## Scripts

| Command          | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `npm run dev`    | Vite dev server with HMR.                          |
| `npm run build`  | Type-check (`tsc -b`) + production bundle.         |
| `npm run lint`   | ESLint, treats warnings as errors.                 |
| `npm test`       | Vitest (utilities + API client + mock API).        |
| `npm run preview`| Serve the production bundle locally.               |

## What demo mode does and does not do

Demo mode **does**:

- Serve three sample contracts (`ready`, `extracting`, `failed`) from a
  short fictional NDA.
- Render extracted-metadata fields with valid `span_start`/`span_end`
  citations into the document text. Clicking a field highlights the cited
  span exactly as it would with a real backend.
- Surface heuristically segmented clauses for the NDA sample under the
  workspace's "Clauses" tab. Clicking a clause highlights its source span
  with the same machinery the metadata fields use.
- Simulate uploads in memory so the success-card flow works.
- Return a small `text/plain` placeholder when you click "Download
  original".

Demo mode **does not**:

- Call the backend, even if `VITE_API_BASE_URL` is set.
- Read or write `localStorage` for the dev user header.
- Persist anything across page refreshes.
- Run any extraction model.

The development user ID input on `/settings` is shown but ignored in demo
mode.

## A reminder

Whereas surfaces information about contracts. It does not provide legal
advice and does not replace human legal review. Extracted metadata and
clause segmentation, including the demo data shown here, are
machine-generated and must be reviewed.
