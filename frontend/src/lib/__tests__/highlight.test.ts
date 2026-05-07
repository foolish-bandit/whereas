import { describe, it, expect } from "vitest";

import { splitTextWithHighlight } from "../highlight";

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
