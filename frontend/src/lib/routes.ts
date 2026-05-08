/**
 * Centralized internal-route helpers for the demo app.
 *
 * The demo lives under `/demo/*` so the marketing landing can own the
 * root path. Components that build links to demo pages should compose
 * paths through `demoPath()` instead of hard-coding the prefix, so a
 * future move (e.g. `/app/*`) is a one-line change.
 */
export const DEMO_BASE = "/demo";

export function demoPath(path: string): string {
  if (!path || path === "/") return DEMO_BASE;
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  return `${DEMO_BASE}${trimmed}`;
}
