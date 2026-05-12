/**
 * PR #118 — Playbook Grid Builder foundation.
 *
 * A `ReviewRule` is a structured, Summize-style review-position row:
 * one issue + the firm's standard position, fallback, canned response,
 * and a short example clause. This is intentionally distinct from
 * `PlaybookRuleSummary` (which projects YAML playbook rules) so the
 * UI grid foundation can iterate without coupling to the YAML schema.
 *
 * Today the grid is demo/mock-only — there is no flat review-rule CRUD
 * endpoint yet. The `*` server fields you'd normally expect are absent
 * by design; nothing about a `ReviewRule` is sent to the server in real
 * mode.
 */
export type ReviewRuleSeverity = "low" | "medium" | "high" | "blocker";
export type ReviewRuleStatus = "active" | "archived";

/**
 * A user-facing contract-type label. Kept as a free string with a
 * suggested set of values so the grid doesn't have to mirror raw
 * backend enums in the UI.
 */
export type ReviewRuleContractType =
  | "Any"
  | "NDA"
  | "MSA"
  | "Vendor agreement"
  | "Customer contract"
  | "Employment agreement"
  | "DPA"
  | "Lease"
  | "Other";

export interface ReviewRule {
  id: string;
  /** Required: short label for the issue this rule covers. */
  issue: string;
  /** Required: contract type the rule applies to (defaults to "Any"). */
  contract_type: ReviewRuleContractType | string;
  /** Severity / risk; defaults to "medium". */
  severity: ReviewRuleSeverity;
  /** Required: the firm's preferred / standard position. */
  standard_position: string;
  /** Optional: acceptable fallback if the standard can't be obtained. */
  fallback_position: string | null;
  /** Optional: pre-canned reviewer reply suggesting the fallback. */
  canned_response: string | null;
  /** Optional: short, safe sample clause language. */
  example_clause: string | null;
  /** Active rules participate in review; archived stay for audit. */
  status: ReviewRuleStatus;
  updated_at: string;
}

/** Editor input shape — what the modal collects and submits. */
export interface ReviewRuleInput {
  issue: string;
  contract_type: string;
  severity: ReviewRuleSeverity;
  standard_position: string;
  fallback_position: string;
  canned_response: string;
  example_clause: string;
  status: ReviewRuleStatus;
}

export const REVIEW_RULE_CONTRACT_TYPES: ReviewRuleContractType[] = [
  "Any",
  "NDA",
  "MSA",
  "Vendor agreement",
  "Customer contract",
  "Employment agreement",
  "DPA",
  "Lease",
  "Other",
];

export const REVIEW_RULE_SEVERITIES: ReviewRuleSeverity[] = [
  "low",
  "medium",
  "high",
  "blocker",
];
