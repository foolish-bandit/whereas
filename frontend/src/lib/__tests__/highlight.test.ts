import { describe, it, expect } from "vitest";

import {
  segmentTextWithCitations,
  splitTextWithHighlight,
} from "../highlight";

describe("splitTextWithHighlight", () => {
  const text = "The parties agree to good faith negotiations.";

  it("splits a valid in-bounds span into before/highlighted/after", () => {
    const result = splitTextWithHighlight(text, 4, 11);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.before).toBe("The ");
      expect(result.highlighted).toBe("parties");
      expect(result.after).toBe(" agree to good faith negotiations.");
      expect(result.before + result.highlighted + result.after).toBe(text);
    }
  });

  it("handles a span that ends at the very end of the text", () => {
    const result = splitTextWithHighlight(text, text.length - 1, text.length);
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.highlighted).toBe(".");
      expect(result.after).toBe("");
    }
  });

  it("rejects a span that exceeds the text length", () => {
    expect(splitTextWithHighlight(text, 0, text.length + 1).kind).toBe(
      "invalid",
    );
  });

  it("rejects negative offsets", () => {
    expect(splitTextWithHighlight(text, -1, 5).kind).toBe("invalid");
  });

  it("rejects start >= end", () => {
    expect(splitTextWithHighlight(text, 5, 5).kind).toBe("invalid");
    expect(splitTextWithHighlight(text, 6, 5).kind).toBe("invalid");
  });

  it("rejects non-integer offsets", () => {
    expect(splitTextWithHighlight(text, 1.5, 5).kind).toBe("invalid");
    expect(splitTextWithHighlight(text, 1, 5.5).kind).toBe("invalid");
  });

  it("rejects null/undefined offsets", () => {
    expect(splitTextWithHighlight(text, null, 5).kind).toBe("invalid");
    expect(splitTextWithHighlight(text, 1, null).kind).toBe("invalid");
    expect(splitTextWithHighlight(text, undefined, undefined).kind).toBe(
      "invalid",
    );
  });

  it("rejects empty text", () => {
    expect(splitTextWithHighlight("", 0, 5).kind).toBe("invalid");
  });

  it("rejects NaN offsets", () => {
    expect(splitTextWithHighlight(text, Number.NaN, 5).kind).toBe("invalid");
  });
});

describe("segmentTextWithCitations", () => {
  const text = "The parties agree to good faith negotiations.";
  //            01234567890123456789012345678901234567890123
  //                     1111111111222222222233333333334

  it("returns the whole text as a single segment when ranges is empty", () => {
    const segs = segmentTextWithCitations(text, []);
    expect(segs).toEqual([{ kind: "text", text }]);
  });

  it("interleaves text and mark segments for valid ranges", () => {
    const segs = segmentTextWithCitations(text, [
      { key: "parties", start: 4, end: 11 },
      { key: "negotiations", start: 32, end: 44 },
    ]);
    expect(segs).toEqual([
      { kind: "text", text: "The " },
      { kind: "mark", key: "parties", text: "parties" },
      { kind: "text", text: " agree to good faith " },
      { kind: "mark", key: "negotiations", text: "negotiations" },
      { kind: "text", text: "." },
    ]);
  });

  it("sorts ranges by start before slicing so input order doesn't matter", () => {
    const segs = segmentTextWithCitations(text, [
      { key: "negotiations", start: 32, end: 44 },
      { key: "parties", start: 4, end: 11 },
    ]);
    const marks = segs.filter((s) => s.kind === "mark").map((s) => s.key);
    expect(marks).toEqual(["parties", "negotiations"]);
  });

  it("drops out-of-bounds ranges silently", () => {
    const segs = segmentTextWithCitations(text, [
      { key: "good", start: 20, end: 24 },
      { key: "way-off", start: 500, end: 600 },
    ]);
    expect(segs.filter((s) => s.kind === "mark").map((s) => s.key)).toEqual([
      "good",
    ]);
  });

  it("drops overlapping ranges in favor of the first one accepted", () => {
    const segs = segmentTextWithCitations(text, [
      { key: "parties_agree", start: 4, end: 17 },
      { key: "parties_only", start: 4, end: 11 },
    ]);
    expect(segs.filter((s) => s.kind === "mark").map((s) => s.key)).toEqual([
      "parties_agree",
    ]);
  });
});
