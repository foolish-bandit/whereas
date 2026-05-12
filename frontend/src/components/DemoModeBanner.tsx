import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export const DEMO_BANNER_DISMISSED_KEY = "whereas:demo:bannerDismissed";

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DEMO_BANNER_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

function persistDismissed() {
  try {
    window.sessionStorage.setItem(DEMO_BANNER_DISMISSED_KEY, "true");
  } catch {
    /* swallow private-mode failures */
  }
}

/**
 * Full-width banner shown once per session on the first visit. The
 * dismiss button persists a sessionStorage flag so subsequent
 * navigation within the same session does not re-show it. The
 * compact <DemoModePill> in the top bar covers the persistent
 * surface.
 */
export default function DemoModeBanner() {
  // Hydrate from sessionStorage. If already dismissed, render
  // nothing — the pill in the top bar is the persistent surface.
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed());

  // Subscribe to dismissal events fired by the pill / button so all
  // banner instances react in sync within a tab.
  useEffect(() => {
    function onDismiss() {
      setDismissed(true);
    }
    window.addEventListener("whereas:demoBannerDismissed", onDismiss);
    return () =>
      window.removeEventListener("whereas:demoBannerDismissed", onDismiss);
  }, []);

  if (dismissed) return null;

  return (
    <div
      className="border-b border-info-ring bg-info-soft px-4 py-2.5 text-sm text-info sm:px-6"
      data-testid="demo-mode-banner"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-info"
            aria-hidden
          />
          <p className="min-w-0">
            <span className="font-medium">Demo mode</span>
            <span className="hidden sm:inline">
              : using sample data. No documents are uploaded.
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to="/demo/known-limitations"
            className="rounded border border-info-ring bg-canvas px-2.5 py-1 text-xs font-medium text-info hover:border-info"
            data-testid="demo-banner-known-limitations"
          >
            Known limitations
          </Link>
          <a
            href="https://github.com/foolish-bandit/whereas"
            target="_blank"
            rel="noreferrer noopener"
            className="rounded border border-info-ring bg-canvas px-2.5 py-1 text-xs font-medium text-info hover:border-info"
          >
            View source
          </a>
          <button
            type="button"
            onClick={() => {
              persistDismissed();
              window.dispatchEvent(new CustomEvent("whereas:demoBannerDismissed"));
              setDismissed(true);
            }}
            className="rounded border border-info-ring bg-canvas px-2.5 py-1 text-xs font-medium text-info hover:border-info"
            data-testid="demo-banner-dismiss"
            aria-label="Dismiss demo banner"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
