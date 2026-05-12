export interface CitationRange {
  /** Stable identifier for the citation (e.g. fieldKey). */
  key: string;
  start: number;
  end: number;
}

export type CitationSegment =
  | { kind: "text"; text: string }
  | { kind: "mark"; key: string; text: string };

/**
 * Slice fullText into non-overlapping text / mark segments using the
 * provided citation ranges. Overlapping or out-of-bounds ranges are
 * dropped. The result is suitable for direct rendering with `<mark>`
 * elements.
 */
export function segmentTextWithCitations(
  fullText: string,
  ranges: readonly CitationRange[],
): CitationSegment[] {
  if (typeof fullText !== "string" || fullText.length === 0) return [];
  const valid = ranges
    .filter(
      (r) =>
        Number.isInteger(r.start) &&
        Number.isInteger(r.end) &&
        r.start >= 0 &&
        r.end > r.start &&
        r.end <= fullText.length,
    )
    .sort((a, b) => a.start - b.start);

  const segments: CitationSegment[] = [];
  let cursor = 0;
  for (const r of valid) {
    // Drop ranges that overlap an earlier accepted one — we never
    // render nested or overlapping marks.
    if (r.start < cursor) continue;
    if (r.start > cursor) {
      segments.push({ kind: "text", text: fullText.slice(cursor, r.start) });
    }
    segments.push({
      kind: "mark",
      key: r.key,
      text: fullText.slice(r.start, r.end),
    });
    cursor = r.end;
  }
  if (cursor < fullText.length) {
    segments.push({ kind: "text", text: fullText.slice(cursor) });
  }
  return segments;
}

export type HighlightSplit =
  | {
      kind: "valid";
      before: string;
      highlighted: string;
      after: string;
    }
  | { kind: "invalid" };

/**
 * Split full_text into before/highlighted/after slices using exact character
 * offsets. Returns "invalid" when offsets cannot be trusted; callers should
 * render a "Citation unavailable" message instead of attempting fuzzy match.
 */
export function splitTextWithHighlight(
  fullText: string,
  spanStart: number | null | undefined,
  spanEnd: number | null | undefined,
): HighlightSplit {
  if (typeof fullText !== "string" || fullText.length === 0) {
    return { kind: "invalid" };
  }
  if (typeof spanStart !== "number" || typeof spanEnd !== "number") {
    return { kind: "invalid" };
  }
  if (!Number.isInteger(spanStart) || !Number.isInteger(spanEnd)) {
    return { kind: "invalid" };
  }
  if (spanStart < 0 || spanEnd <= spanStart) {
    return { kind: "invalid" };
  }
  if (spanEnd > fullText.length) {
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    before: fullText.slice(0, spanStart),
    highlighted: fullText.slice(spanStart, spanEnd),
    after: fullText.slice(spanEnd),
  };
}
