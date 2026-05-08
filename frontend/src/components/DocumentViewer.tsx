import { useEffect, useRef } from "react";

import { splitTextWithHighlight } from "../lib/highlight";

interface DocumentViewerProps {
  fullText: string | null;
  selectedSpan: { start: number; end: number } | null;
  selectionToken?: string | number | null;
  /**
   * Optional content rendered on the right side of the viewer's
   * header. Used by the contract workspace to mount the
   * markdown/original toggle.
   */
  rightSlot?: React.ReactNode;
}

export default function DocumentViewer({
  fullText,
  selectedSpan,
  selectionToken,
  rightSlot,
}: DocumentViewerProps) {
  const highlightRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!selectedSpan) return;
    const el = highlightRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedSpan, selectionToken]);

  if (!fullText) {
    return (
      <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule bg-canvas-subtle px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-ink">Original document text</h2>
            <p className="mt-0.5 text-xs text-ink-subtle">
              Plain text extracted from the original file. Whitespace is
              preserved.
            </p>
          </div>
          {rightSlot && (
            <div className="flex items-center gap-2">{rightSlot}</div>
          )}
        </div>
        <div className="px-5 py-6 text-sm text-ink-muted">
          Document text is unavailable. The original file is still downloadable
          from the contract header.
        </div>
      </div>
    );
  }

  const split = selectedSpan
    ? splitTextWithHighlight(fullText, selectedSpan.start, selectedSpan.end)
    : { kind: "invalid" as const };

  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink">Original document text</h2>
          <p className="mt-0.5 text-xs text-ink-subtle">
            Plain text extracted from the original file. Whitespace is preserved.
          </p>
        </div>
        {rightSlot && (
          <div className="flex items-center gap-2">{rightSlot}</div>
        )}
      </div>
      <div className="max-h-mobile-viewer overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 lg:max-h-[calc(100vh-13rem)]">
        <pre className="whitespace-pre-wrap break-words font-serif text-[15px] leading-relaxed text-ink">
          {split.kind === "valid" ? (
            <>
              {split.before}
              <mark
                ref={highlightRef as React.RefObject<HTMLElement>}
                className="rounded-sm bg-warning-soft px-0.5 ring-1 ring-warning-ring"
              >
                {split.highlighted}
              </mark>
              {split.after}
            </>
          ) : (
            fullText
          )}
        </pre>
      </div>
    </div>
  );
}
