import { describe, expect, it } from "vitest";
import { runDeterministicReview, type DeterministicReviewRule } from "../deterministicReview";

const rules: DeterministicReviewRule[] = [
  { id: "r1", title: "Need indemnity", rule_type: "required_clause", severity: "high", clause_type: "indemnity" },
  { id: "r2", title: "Preferred law", rule_type: "preferred_value", severity: "medium", metadata_field: "governing_law", expected_value: "Delaware" },
  { id: "r3", title: "Manual", rule_type: "manual_review", severity: "low" },
];

describe("runDeterministicReview", () => {
  it("missing required clause produces finding", () => {
    const out = runDeterministicReview({ clauses: [], extractedFields: [], rules });
    expect(out.findings.some((f) => f.rule_id === "r1")).toBe(true);
  });

  it("preferred value mismatch produces finding", () => {
    const out = runDeterministicReview({
      clauses: [],
      extractedFields: [{ field_name: "governing_law", value_json: "New York" } as never],
      rules,
    });
    expect(out.findings.some((f) => f.rule_id === "r2")).toBe(true);
  });

  it("matching clause does not produce missing finding", () => {
    const out = runDeterministicReview({
      clauses: [{ clause_type: "indemnity" } as never],
      extractedFields: [],
      rules,
    });
    expect(out.findings.some((f) => f.rule_id === "r1")).toBe(false);
  });
});
