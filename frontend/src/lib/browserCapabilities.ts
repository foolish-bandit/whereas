/**
 * Browser capability detection for the PWA-first work the architecture
 * is moving toward. This module ONLY inspects feature presence —
 * it never requests a permission, never opens a file picker, and never
 * reads any user data. It is safe to call at any time (e.g. on the
 * Settings page) without surprising the user.
 *
 * The shape is intentionally conservative: a `boolean` per capability
 * with no per-API quirks exposed. Callers that need richer behavior
 * (e.g. estimating storage quota) should add their own helpers next
 * to the call site.
 */

export interface BrowserCapabilities {
  /** Service worker registration is available (required for PWA install). */
  serviceWorker: boolean;
  /**
   * `navigator.storage.persist()` is callable. Persisted storage
   * survives normal eviction; needed for offline-first work later.
   */
  storagePersistence: boolean;
  /**
   * File System Access API (`showOpenFilePicker`,
   * `showSaveFilePicker`). Used only for opt-in import/export and
   * "open original in Word" workflows; normal preview never needs it.
   */
  fileSystemAccess: boolean;
  /** Origin Private File System: an opaque, sandboxed, per-origin store. */
  opfs: boolean;
}

const FALSE_CAPS: BrowserCapabilities = {
  serviceWorker: false,
  storagePersistence: false,
  fileSystemAccess: false,
  opfs: false,
};

/**
 * Detect what the current browser supports. Returns an all-`false`
 * result when called in a non-browser environment (SSR, tests without
 * a DOM, etc.) instead of throwing.
 */
export function detectBrowserCapabilities(): BrowserCapabilities {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { ...FALSE_CAPS };
  }

  const hasServiceWorker = "serviceWorker" in navigator;

  const storage =
    typeof navigator.storage === "object" && navigator.storage !== null
      ? navigator.storage
      : undefined;
  const hasStoragePersistence =
    !!storage && typeof storage.persist === "function";

  const hasFileSystemAccess =
    typeof (window as Window & { showOpenFilePicker?: unknown })
      .showOpenFilePicker === "function";

  // OPFS: storage.getDirectory() is the canonical entrypoint.
  const hasOpfs =
    !!storage &&
    typeof (storage as StorageManager & { getDirectory?: unknown })
      .getDirectory === "function";

  return {
    serviceWorker: hasServiceWorker,
    storagePersistence: hasStoragePersistence,
    fileSystemAccess: hasFileSystemAccess,
    opfs: hasOpfs,
  };
}

export function describeCapability(
  key: keyof BrowserCapabilities,
): { label: string; description: string } {
  switch (key) {
    case "serviceWorker":
      return {
        label: "Service worker",
        description: "Required to install Whereas as a PWA and cache app shell.",
      };
    case "storagePersistence":
      return {
        label: "Persistent storage",
        description:
          "Lets Whereas ask the browser not to evict its working data.",
      };
    case "fileSystemAccess":
      return {
        label: "File picker access",
        description:
          "Used only for explicit import, export, and open-original workflows.",
      };
    case "opfs":
      return {
        label: "Origin Private File System",
        description:
          "Sandboxed per-origin storage; reserved for future local-first sync.",
      };
  }
}
