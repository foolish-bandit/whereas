import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import Pill from "./ui/Pill";

/**
 * Persistent compact demo-mode indicator that lives in the top bar.
 * Click opens a popover with the same content as the dismissable
 * full-width banner — copy in sync with <DemoModeBanner>.
 */
export default function DemoModePill() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Using sample data — nothing leaves this browser."
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="demo-mode-pill"
      >
        <Pill tone="info" variant="soft">
          <span aria-hidden>●</span> Demo mode
        </Pill>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Demo mode"
          className="absolute left-0 z-30 mt-1 w-72 rounded border border-rule bg-canvas p-3 text-sm shadow-md"
          data-testid="demo-mode-pill-popover"
        >
          <p className="text-ink">
            <span className="font-medium">Demo mode</span>: using sample
            data. No documents are uploaded.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <Link
              to="/demo/known-limitations"
              onClick={() => setOpen(false)}
              className="rounded border border-rule bg-canvas px-2 py-1 text-ink hover:border-rule-strong"
              data-testid="demo-mode-pill-known-limitations"
            >
              Known limitations
            </Link>
            <a
              href="https://github.com/foolish-bandit/whereas"
              target="_blank"
              rel="noreferrer noopener"
              className="rounded border border-rule bg-canvas px-2 py-1 text-ink hover:border-rule-strong"
              data-testid="demo-mode-pill-view-source"
            >
              View source
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
