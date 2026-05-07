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
