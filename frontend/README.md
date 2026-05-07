# Whereas Frontend

React + Vite + Tailwind. Pre-v0.1 contracts workspace UI.

## Local development

Requires Node 22.x.

```
cd frontend
npm install
cp .env.example .env.local   # adjust VITE_API_BASE_URL if needed
npm run dev
```

The dev server listens on `http://localhost:5173`. The Whereas backend
allowlists this origin in development (see `backend/app/main.py`), so no
CORS configuration is required.

## Configuration

| Env var              | Default                  | Description                  |
| -------------------- | ------------------------ | ---------------------------- |
| `VITE_API_BASE_URL`  | `http://localhost:8000`  | Whereas backend base URL.    |

## Development user ID

Whereas does not have real authentication yet. The backend identifies
callers via the `X-Whereas-Dev-User` header. Set that user ID once in the
app:

1. Start the backend.
2. Open the frontend at `http://localhost:5173`.
3. Open **Settings** in the sidebar.
4. Paste the UUID of an existing row in the backend's `users` table and save.

The value is stored in `localStorage` only. Clear it from the same screen.

## Scripts

| Command          | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `npm run dev`    | Vite dev server with HMR.                          |
| `npm run build`  | Type-check (`tsc -b`) + production bundle.         |
| `npm run lint`   | ESLint, treats warnings as errors.                 |
| `npm test`       | Vitest (utilities + API client).                   |
| `npm run preview`| Serve the production bundle locally.               |

## Production build

```
docker build -t whereas-frontend frontend/
```

The image runs `nginx` and serves `dist/` with a SPA fallback to
`index.html`. The Whereas Docker Compose file references this image as
the `frontend` service.
