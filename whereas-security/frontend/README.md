# Whereas Frontend

React + Vite + Tailwind. Not yet implemented.

For early Cloudflare Pages deployment, this directory will hold a static landing page until the React app is ready. Drop an `index.html` here and configure Cloudflare Pages to serve from `frontend/`.

## Planned stack

- Vite + React 18
- Tailwind CSS
- TanStack Query for server state
- React Router
- Zustand for local state where it earns its keep (not by default)

Reasoning: same stack as the Sonomos account portal, so contributors who work on both projects don't context-switch on tooling.
