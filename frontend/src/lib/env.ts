/**
 * Demo mode is toggled via the `VITE_WHEREAS_DEMO_MODE` env var. When set to
 * `"true"` at build time (or in the local dev env), the API client routes
 * every call through `mockApi` instead of contacting the backend.
 *
 * Read at call time, not module load, so tests can stub it via
 * `vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true")`.
 */
export function isDemoMode(): boolean {
  return import.meta.env.VITE_WHEREAS_DEMO_MODE === "true";
}
