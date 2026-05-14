/**
 * Centralized internal-route helpers for the demo app.
 *
 * The product app lives under `/demo/*` so the marketing landing can
 * keep the browser root path. Components that build links to app
 * pages should compose paths through `demoPath()` instead of hard-
 * coding the prefix, so a future move (e.g. `/app/*`) is a one-line
 * change.
 */
export const DEMO_BASE = "/demo";

export function demoPath(path: string): string {
  if (!path || path === "/") return DEMO_BASE;
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  return `${DEMO_BASE}${trimmed}`;
}

export function mountedPath(path: string, pathname: string): string {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  return pathname === DEMO_BASE || pathname.startsWith(`${DEMO_BASE}/`)
    ? demoPath(trimmed)
    : trimmed;
}

export const DEMO_HOME = demoPath("/welcome");
