import { describe, it, expect } from "vitest";

import {
  confidenceTier,
  daysUntil,
  formatBytes,
  humanizeFieldName,
  mimeExtension,
  mimeLabel,
  relativeDateWithin,
  renderExtractedValue,
  sanitizeFilename,
} from "../format";

describe("formatBytes", () => {
  it("formats bytes, KB, MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("handles invalid input", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("humanizeFieldName", () => {
  it("uses overrides for known fields", () => {
    expect(humanizeFieldName("effective_date")).toBe("Effective date");
    expect(humanizeFieldName("governing_law")).toBe("Governing law");
  });

  it("falls back to title-case for unknown fields", () => {
    expect(humanizeFieldName("something_obscure")).toBe("Something obscure");
    expect(humanizeFieldName("another-thing")).toBe("Another thing");
  });
});

describe("mimeLabel/mimeExtension", () => {
  it("recognizes PDF and DOCX", () => {
    expect(mimeLabel("application/pdf")).toBe("PDF");
    expect(mimeExtension("application/pdf")).toBe(".pdf");
    expect(
      mimeLabel(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("DOCX");
  });

  it("falls back to the raw mime when unknown", () => {
    expect(mimeLabel("application/octet-stream")).toBe(
      "application/octet-stream",
    );
    expect(mimeExtension("application/octet-stream")).toBe("");
  });
});

describe("sanitizeFilename", () => {
  it("strips unsafe characters and applies a fallback extension", () => {
    expect(sanitizeFilename("MSA / Acme Corp.pdf", ".pdf")).toBe(
      "MSA_Acme_Corp.pdf",
    );
    expect(sanitizeFilename("contract title", ".docx")).toBe(
      "contract_title.docx",
    );
  });

  it("does not double up the extension if already present", () => {
    expect(sanitizeFilename("contract.pdf", ".pdf")).toBe("contract.pdf");
  });

  it("handles empty input with a fallback", () => {
    expect(sanitizeFilename("", ".pdf")).toBe("contract.pdf");
  });
});

describe("confidenceTier", () => {
  it("buckets confidences", () => {
    expect(confidenceTier(0.95)).toBe("high");
    expect(confidenceTier(0.65)).toBe("medium");
    expect(confidenceTier(0.2)).toBe("low");
    expect(confidenceTier(Number.NaN)).toBe("low");
  });
});

describe("renderExtractedValue", () => {
  it("renders primitives directly", () => {
    expect(renderExtractedValue("Acme")).toBe("Acme");
    expect(renderExtractedValue(42)).toBe("42");
    expect(renderExtractedValue(true)).toBe("true");
  });

  it("renders money objects", () => {
    expect(renderExtractedValue({ amount: 1000, currency: "USD" })).toBe(
      "1000 USD",
    );
  });

  it("joins arrays of strings", () => {
    expect(renderExtractedValue(["Acme", "Globex"])).toBe("Acme, Globex");
  });

  it("returns em-dash for null/undefined", () => {
    expect(renderExtractedValue(null)).toBe("—");
    expect(renderExtractedValue(undefined)).toBe("—");
  });
});

describe("daysUntil / relativeDateWithin", () => {
  const now = new Date("2026-05-12T12:00:00Z");

  it("counts whole days regardless of clock time within a day", () => {
    expect(daysUntil("2026-05-12", now)).toBe(0);
    expect(daysUntil("2026-05-13", now)).toBe(1);
    expect(daysUntil("2026-05-11", now)).toBe(-1);
    expect(daysUntil("2026-06-04", now)).toBe(23);
  });

  it("returns null for invalid input", () => {
    expect(daysUntil("not-a-date", now)).toBeNull();
  });

  it("renders 'in N days' / 'today' / 'tomorrow' within the window", () => {
    expect(relativeDateWithin("2026-06-04", 90, now)).toBe("in 23 days");
    expect(relativeDateWithin("2026-05-12", 90, now)).toBe("today");
    expect(relativeDateWithin("2026-05-13", 90, now)).toBe("tomorrow");
  });

  it("returns null when the date is outside the window", () => {
    expect(relativeDateWithin("2027-01-15", 90, now)).toBeNull();
  });
});
