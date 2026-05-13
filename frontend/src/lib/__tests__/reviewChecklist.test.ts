import { describe, expect, it } from "vitest";

import { getReviewChecklist } from "../reviewChecklist";

describe("getReviewChecklist", () => {
  it("returns NDA checklist for 'NDA' (exact case)", () => {
    const { items, matched } = getReviewChecklist("NDA");
    expect(matched).toBe(true);
    expect(items.map((i) => i.label)).toEqual([
      "Confidentiality scope",
      "Term / survival",
      "Residuals",
      "Governing law",
      "Return/destruction of materials",
    ]);
  });

  it("returns NDA checklist for lowercase 'nda'", () => {
    const { items, matched } = getReviewChecklist("nda");
    expect(matched).toBe(true);
    expect(items[0].label).toBe("Confidentiality scope");
  });

  it("returns DPA checklist", () => {
    const { items, matched } = getReviewChecklist("DPA");
    expect(matched).toBe(true);
    expect(items.map((i) => i.label)).toEqual([
      "Data categories",
      "Subprocessors",
      "Security measures",
      "Cross-border transfers",
      "Incident notice",
    ]);
  });

  it("returns MSA checklist", () => {
    const { items, matched } = getReviewChecklist("MSA");
    expect(matched).toBe(true);
    expect(items.map((i) => i.label)).toEqual([
      "SOW linkage",
      "Payment terms",
      "Limitation of liability",
      "Indemnity",
      "Termination",
    ]);
  });

  it("returns Vendor agreement checklist (case-insensitive)", () => {
    const { items, matched } = getReviewChecklist("Vendor Agreement");
    expect(matched).toBe(true);
    expect(items.map((i) => i.label)).toEqual([
      "Service levels",
      "Payment",
      "Data access",
      "Termination",
      "Liability cap",
    ]);
  });

  it("returns Employment checklist", () => {
    const { items, matched } = getReviewChecklist("Employment");
    expect(matched).toBe(true);
    expect(items.map((i) => i.label)).toEqual([
      "Role/compensation",
      "Confidentiality",
      "IP assignment",
      "Restrictive covenants",
      "Termination",
    ]);
  });

  it("returns default checklist for null", () => {
    const { items, matched } = getReviewChecklist(null);
    expect(matched).toBe(false);
    expect(items.map((i) => i.label)).toEqual([
      "Parties",
      "Term",
      "Payment/consideration",
      "Liability",
      "Governing law",
    ]);
  });

  it("returns default checklist for undefined", () => {
    const { items, matched } = getReviewChecklist(undefined);
    expect(matched).toBe(false);
    expect(items).toHaveLength(5);
    expect(items[0].label).toBe("Parties");
  });

  it("returns default checklist for an unrecognized contract type", () => {
    const { items, matched } = getReviewChecklist("Software License");
    expect(matched).toBe(false);
    expect(items.map((i) => i.label)).toContain("Parties");
    expect(items.map((i) => i.label)).toContain("Governing law");
  });

  it("returns default checklist for empty string", () => {
    const { items, matched } = getReviewChecklist("");
    expect(matched).toBe(false);
    expect(items[0].label).toBe("Parties");
  });

  it("handles whitespace-padded contract type", () => {
    const { items, matched } = getReviewChecklist("  NDA  ");
    expect(matched).toBe(true);
    expect(items[0].label).toBe("Confidentiality scope");
  });
});
