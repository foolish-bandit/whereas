import { useEffect, useRef } from "react";

import {
  segmentTextWithCitations,
  splitTextWithHighlight,
  type CitationRange,
} from "../lib/highlight";

interface DocumentViewerProps {
  fullText: string | null;
  selectedSpan: { start: number; end: number } | null;
  selectionToken?: string | number | null;
  /**
   * Optional list of every known citation in the document. When
   * provided, each range is wrapped in a subdued <mark> so all
   * citations are visible at a glance; the one whose key matches
   * `activeCitationKey` gets a brighter style and is scrolled into view.
   */
  citations?: readonly CitationRange[];
  activeCitationKey?: string | null;
  /**
   * Optional content rendered on the right side of the viewer's
   * header. Used by the contract workspace to mount the
   * markdown/original toggle.
   */
  rightSlot?: React.ReactNode;
}

const MARK_BASE =
  "rounded-sm px-0.5 transition-colors duration-200 bg-warning-soft/40";
const MARK_ACTIVE = "bg-warning-soft ring-2 ring-warning-ring";

export default function DocumentViewer({
  fullText,
  selectedSpan,
  selectionToken,
  citations,
  activeCitationKey,
  rightSlot,
}: DocumentViewerProps) {
  const activeMarkRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = activeMarkRef.current;
    if (!el) return;
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [selectedSpan, selectionToken, activeCitationKey]);

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

  // Two render modes:
  //   1. citations array provided → mark every citation, brighter for active.
  //   2. only selectedSpan provided → legacy single-highlight path. Kept so
  //      review-finding / clause selections still light up a span in the
  //      original-text view even when the parent didn't pass a citation list.
  const useMultiCitations = Array.isArray(citations) && citations.length > 0;
  const segments = useMultiCitations
    ? segmentTextWithCitations(fullText, citations!)
    : null;
  const legacySplit =
    !useMultiCitations && selectedSpan
      ? splitTextWithHighlight(fullText, selectedSpan.start, selectedSpan.end)
      : null;

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
          {segments
            ? segments.map((seg, i) => {
                if (seg.kind === "text") return <span key={i}>{seg.text}</span>;
                const isActive = seg.key === activeCitationKey;
                return (
                  <mark
                    key={i}
                    ref={isActive ? (activeMarkRef as React.RefObject<HTMLElement>) : undefined}
                    className={[MARK_BASE, isActive ? MARK_ACTIVE : ""].join(" ")}
                    data-citation-key={seg.key}
                    data-active={isActive ? "true" : "false"}
                  >
                    {seg.text}
                  </mark>
                );
              })
            : legacySplit?.kind === "valid"
              ? (
                  <>
                    {legacySplit.before}
                    <mark
                      ref={activeMarkRef as React.RefObject<HTMLElement>}
                      className={[MARK_BASE, MARK_ACTIVE].join(" ")}
                    >
                      {legacySplit.highlighted}
                    </mark>
                    {legacySplit.after}
                  </>
                )
              : fullText}
        </pre>
      </div>
    </div>
  );
}
