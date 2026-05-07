import { useEffect, useRef } from "react";

import { splitTextWithHighlight } from "../lib/highlight";

interface DocumentViewerProps {
  fullText: string | null;
  selectedSpan: { start: number; end: number } | null;
  selectionToken?: string | number | null;
}

export default function DocumentViewer({
  fullText,
  selectedSpan,
  selectionToken,
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
      <div className="rounded-lg border border-rule bg-canvas px-5 py-6 text-sm text-ink-muted">
        Document text is unavailable. The original file is still downloadable
        from the contract header.
      </div>
    );
  }

  const split = selectedSpan
    ? splitTextWithHighlight(fullText, selectedSpan.start, selectedSpan.end)
    : { kind: "invalid" as const };

  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      <div className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">Document text</h2>
        <p className="mt-0.5 text-xs text-ink-subtle">
          Plain text extracted from the original file. Whitespace is preserved.
        </p>
      </div>
      <div className="max-h-[calc(100vh-13rem)] overflow-y-auto px-6 py-6">
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
