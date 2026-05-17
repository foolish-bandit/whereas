/**
 * Thin wrapper around the Nango Connect UI.
 *
 * Encapsulates the lazy import of ``@nangohq/frontend`` (so the bundle
 * cost only applies on the Integrations page, and so tests can stub
 * the loader) and normalizes the SDK's event-callback shape into a
 * single awaitable promise that resolves with the OAuth-returned
 * ``connectionId`` or a ``cancelled`` outcome.
 *
 * Demo-mode short-circuit: when ``VITE_WHEREAS_DEMO_MODE`` is set, no
 * real Nango call is made; we resolve immediately with a synthetic
 * connection id so the rest of the upsert flow can be exercised
 * against the mock backend.
 */
import { isDemoMode } from "./env";

export interface OpenNangoConnectOptions {
  sessionToken: string;
}

export type OpenNangoConnectResult =
  | { kind: "connected"; connectionId: string }
  | { kind: "cancelled" };

interface NangoModule {
  default: NangoConstructor;
}

interface NangoConstructor {
  new (opts?: { host?: string }): NangoInstance;
}

interface NangoInstance {
  openConnectUI(opts: {
    sessionToken: string;
    onEvent: (event: NangoEvent) => void;
  }): { close?: () => void } | void;
}

interface NangoEvent {
  type: string;
  payload?: {
    connectionId?: string;
  } & Record<string, unknown>;
}

/**
 * Loader hook for the Nango SDK. Replaceable in tests so a vitest
 * spec doesn't have to actually import or stub ``@nangohq/frontend``.
 */
export type NangoModuleLoader = () => Promise<NangoModule>;

let loaderOverride: NangoModuleLoader | null = null;

/**
 * Test seam — replaces the dynamic import so a test can hand the
 * helper a fake Nango. Pass ``null`` to restore the real loader.
 */
export function __setNangoLoaderForTests(
  loader: NangoModuleLoader | null,
): void {
  loaderOverride = loader;
}

function defaultLoader(): Promise<NangoModule> {
  return import("@nangohq/frontend") as Promise<unknown> as Promise<NangoModule>;
}

function nangoHost(): string | undefined {
  const env = (import.meta.env.VITE_NANGO_PUBLIC_URL ?? "").trim();
  return env || undefined;
}

export async function openNangoConnect(
  opts: OpenNangoConnectOptions,
): Promise<OpenNangoConnectResult> {
  if (isDemoMode()) {
    // Demo mode — pretend the user just completed the OAuth dance with
    // a deterministic-but-fake connection id.
    return {
      kind: "connected",
      connectionId: `demo-connection-${Math.random().toString(36).slice(2, 10)}`,
    };
  }
  const loader = loaderOverride ?? defaultLoader;
  let mod: NangoModule;
  try {
    mod = await loader();
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? `Could not load Nango Connect UI: ${err.message}`
        : "Could not load Nango Connect UI.",
    );
  }
  const NangoCtor = mod.default;
  const nango = new NangoCtor({ host: nangoHost() });

  return new Promise<OpenNangoConnectResult>((resolve, reject) => {
    let settled = false;
    const settle = (result: OpenNangoConnectResult | Error) => {
      if (settled) return;
      settled = true;
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    try {
      nango.openConnectUI({
        sessionToken: opts.sessionToken,
        onEvent: (event) => {
          if (event.type === "connect") {
            const connectionId = event.payload?.connectionId;
            if (typeof connectionId === "string" && connectionId) {
              settle({ kind: "connected", connectionId });
              return;
            }
            settle(new Error("Nango returned no connection id."));
            return;
          }
          if (event.type === "close" || event.type === "cancel") {
            settle({ kind: "cancelled" });
            return;
          }
          if (event.type === "error") {
            const message =
              typeof event.payload?.message === "string"
                ? event.payload.message
                : "Nango reported an error during connect.";
            settle(new Error(message));
          }
        },
      });
    } catch (err) {
      settle(
        err instanceof Error
          ? err
          : new Error("Nango Connect UI failed to open."),
      );
    }
  });
}
