import type { Clause, ExtractedField } from "../types/contracts";

export type DeterministicRuleType = "required_clause" | "preferred_value" | "manual_review";

export interface DeterministicReviewRule {
  id: string;
  title: string;
  rule_type: DeterministicRuleType;
  severity: "low" | "medium" | "high" | "blocker";
  clause_type?: string;
  metadata_field?: string;
  expected_value?: string;
}

export interface DeterministicReviewFinding {
  id: string;
  rule_id: string;
  rule_type: DeterministicRuleType;
  title: string;
  severity: DeterministicReviewRule["severity"];
  message: string;
  basis: string;
}

export interface DeterministicReviewResult {
  findings: DeterministicReviewFinding[];
  warnings: string[];
}

export function runDeterministicReview(params: {
  clauses?: Clause[];
  extractedFields?: ExtractedField[];
  rules?: DeterministicReviewRule[];
}): DeterministicReviewResult {
  const { clauses = [], extractedFields = [], rules = [] } = params;
  const findings: DeterministicReviewFinding[] = [];
  const warnings: string[] = [];

  if (clauses.length === 0) warnings.push("No clauses available for clause-type checks.");
  if (extractedFields.length === 0) warnings.push("No extracted metadata available for preferred-value checks.");
  if (rules.length === 0) warnings.push("No playbook/review rules available; deterministic review returned no checks.");

  const clauseTypes = new Set(
    clauses.map((c) => (c.clause_type ?? "").trim().toLowerCase()).filter(Boolean),
  );
  const fieldMap = new Map(
    extractedFields.map((f) => [f.field_name.trim().toLowerCase(), String(f.value_json ?? "").trim()]),
  );

  for (const rule of rules) {
    if (rule.rule_type === "required_clause") {
      const wanted = (rule.clause_type ?? "").trim().toLowerCase();
      if (!wanted || clauseTypes.has(wanted)) continue;
      findings.push({
        id: `det-${rule.id}`,
        rule_id: rule.id,
        rule_type: rule.rule_type,
        title: rule.title,
        severity: rule.severity,
        message: `Required clause type \"${rule.clause_type}\" is missing.`,
        basis: `Clause types checked: ${Array.from(clauseTypes).join(", ") || "none"}`,
      });
      continue;
    }
    if (rule.rule_type === "preferred_value") {
      const key = (rule.metadata_field ?? "").trim().toLowerCase();
      if (!key || !rule.expected_value) continue;
      const found = fieldMap.get(key);
      if (!found) continue;
      if (found.toLowerCase() !== rule.expected_value.toLowerCase()) {
        findings.push({
          id: `det-${rule.id}`,
          rule_id: rule.id,
          rule_type: rule.rule_type,
          title: rule.title,
          severity: rule.severity,
          message: `Preferred value mismatch for ${rule.metadata_field}: expected \"${rule.expected_value}\", found \"${found}\".`,
          basis: `Metadata field ${rule.metadata_field}`,
        });
      }
      continue;
    }

    findings.push({
      id: `det-${rule.id}`,
      rule_id: rule.id,
      rule_type: "manual_review",
      title: rule.title,
      severity: rule.severity,
      message: "Manual review required by checklist rule.",
      basis: "Playbook/manual checklist rule",
    });
  }

  return { findings, warnings };
}
