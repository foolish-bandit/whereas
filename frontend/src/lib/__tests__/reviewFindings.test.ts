import { describe, expect, it } from "vitest";

import {
  findingHasGrounding,
  findingRequiresHumanReview,
  safeFindingSummary,
  type ReviewFinding,
} from "../reviewFindings";

const groundedFinding: ReviewFinding = {
  id: "rf_1",
  source: "deterministic_rule",
  severity: "high",
  title: "Liability cap exceeds playbook policy",
  explanation: "The cap is set to 3x fees instead of 1x.",
  source_span_start: 120,
  source_span_end: 188,
  source_excerpt: "... liability shall not exceed three (3) times fees ...",
  playbook_rule_id: "pb-liability-cap-001",
  playbook_basis: "MSA liability cap must be 1x fees unless approved",
  clause_type: "limitation_of_liability",
  clause_manager_entry_id: "cm_42",
  fallback_language: "Liability shall not exceed fees paid in prior 12 months.",
  confidence: 0.93,
  human_status: "unreviewed",
};

describe("review finding grounding helpers", () => {
  it("grounded finding passes helper", () => {
    expect(findingHasGrounding(groundedFinding)).toBe(true);
  });

  it("ungrounded AI-generated finding fails helper", () => {
    const ungrounded: ReviewFinding = {
      id: "rf_2",
      source: "small_model_explanation",
      severity: "medium",
      title: "Potential concern",
      explanation: "Looks risky.",
      human_status: "unreviewed",
    };

    expect(findingHasGrounding(ungrounded)).toBe(false);
  });

  it("human review status helper works", () => {
    expect(findingRequiresHumanReview(groundedFinding)).toBe(true);
    expect(
      findingRequiresHumanReview({ ...groundedFinding, human_status: "accepted" }),
    ).toBe(false);
    expect(
      findingRequiresHumanReview({ ...groundedFinding, human_status: "needs_revision" }),
    ).toBe(true);
  });

  it("safe summary excludes raw internals", () => {
    const summary = safeFindingSummary(groundedFinding);

    expect(summary).toContain("HIGH: Liability cap exceeds playbook policy");
    expect(summary).not.toContain("exceeds three (3) times fees");
    expect(summary).not.toContain("The cap is set to 3x fees");
    expect(summary).not.toContain("rf_1");
  });

  it("safe summary contains no forbidden sensitive tokens", () => {
    const summary = safeFindingSummary({
      ...groundedFinding,
      title: "Authorization: bearer xyz should never leak",
    });

    expect(summary).not.toMatch(/authorization:/i);
    expect(summary).not.toMatch(/bearer\s+[a-z0-9._-]+/i);
    expect(summary).not.toMatch(/api[_-]?key/i);
    expect(summary).not.toMatch(/password/i);
    expect(summary).not.toMatch(/secret/i);
    expect(summary).not.toMatch(/token/i);
  });
});
