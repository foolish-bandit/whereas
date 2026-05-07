import { describe, expect, it } from "vitest";

import { validateFile } from "../upload";

function makeFile(name: string, size: number, type = ""): File {
  const blob = new Blob([new Uint8Array(size)], { type });
  return new File([blob], name, { type });
}

describe("validateFile", () => {
  it("accepts a small PDF", () => {
    expect(validateFile(makeFile("a.pdf", 1024, "application/pdf"))).toBeNull();
  });

  it("accepts a small DOCX", () => {
    expect(
      validateFile(
        makeFile(
          "a.docx",
          1024,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      ),
    ).toBeNull();
  });

  it("rejects unsupported extensions", () => {
    expect(validateFile(makeFile("a.txt", 1024))).toMatch(/Unsupported/);
  });

  it("rejects empty files", () => {
    expect(validateFile(makeFile("a.pdf", 0))).toMatch(/empty/);
  });

  it("rejects oversized files", () => {
    expect(
      validateFile(makeFile("a.pdf", 51 * 1024 * 1024, "application/pdf")),
    ).toMatch(/max/);
  });
});
