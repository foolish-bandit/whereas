import { useEffect, useState } from "react";

import {
  type BrowserCapabilities,
  describeCapability,
  detectBrowserCapabilities,
} from "../lib/browserCapabilities";

/**
 * Settings-page surface that lists what the current browser supports
 * for the PWA-first work Whereas is moving toward.
 *
 * Detection is purely passive — no permission prompts, no file
 * pickers. The body copy is intentionally short and tells the user
 * that normal contract previews do NOT require repeated filesystem
 * permission prompts.
 */
export default function BrowserCapabilitiesCard() {
  const [caps, setCaps] = useState<BrowserCapabilities | null>(null);

  useEffect(() => {
    setCaps(detectBrowserCapabilities());
  }, []);

  const keys: (keyof BrowserCapabilities)[] = [
    "serviceWorker",
    "storagePersistence",
    "fileSystemAccess",
    "opfs",
  ];

  return (
    <div className="mt-6 max-w-2xl rounded-lg border border-rule bg-canvas p-5">
      <h2 className="text-sm font-medium text-ink">
        PWA &amp; local browser capabilities
      </h2>
      <p className="mt-1 text-xs text-ink-muted">
        Whereas uses browser storage for normal app functionality. File picker
        access is only needed for import, export, and open-original workflows.
        Previewing a contract does not require repeated file permission
        prompts.
      </p>
      <ul className="mt-4 divide-y divide-rule" aria-label="Browser capabilities">
        {keys.map((key) => {
          const { label, description } = describeCapability(key);
          const supported = caps ? caps[key] : null;
          return (
            <li
              key={key}
              className="flex items-start justify-between gap-4 py-2.5"
            >
              <div>
                <p className="text-sm text-ink">{label}</p>
                <p className="text-xs text-ink-muted">{description}</p>
              </div>
              <CapabilityPill supported={supported} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CapabilityPill({ supported }: { supported: boolean | null }) {
  if (supported === null) {
    return (
      <span className="shrink-0 rounded-full border border-rule bg-canvas-subtle px-2 py-0.5 text-[11px] text-ink-muted">
        Detecting…
      </span>
    );
  }
  if (supported) {
    return (
      <span className="shrink-0 rounded-full border border-success-ring bg-success-soft px-2 py-0.5 text-[11px] text-success">
        Supported
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full border border-rule bg-canvas-subtle px-2 py-0.5 text-[11px] text-ink-muted">
      Unavailable
    </span>
  );
}
