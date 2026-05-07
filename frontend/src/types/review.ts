/**
 * Types mirroring the backend playbook-review responses.
 *
 * The shape matches `app/schemas/playbook_review.py`. Results are
 * transient — PR #21 does not persist findings — so there is no
 * "id" on a result and no audit/reviewer fields.
 */
import type { PlaybookRuleType, PlaybookSeverity } from "./playbooks";

export type PlaybookRuleStatus = "pass" | "fail";

export interface PlaybookRuleMatchResult {
  rule_id: string;
  title: string;
  rule_type: PlaybookRuleType | string;
  clause_type: string;
  severity: PlaybookSeverity | string;
  status: PlaybookRuleStatus;
  message: string;
  clause_id: string | null;
  clause_ordinal: number | null;
  clause_heading: string | null;
  evidence_text: string | null;
  span_start: number | null;
  span_end: number | null;
  matched_terms: string[];
  expected_value: string | null;
  description: string | null;
  guidance: string | null;
  preferred_language: string | null;
}

export interface PlaybookReviewResult {
  playbook_id: string;
  playbook_name: string;
  contract_id: string;
  rules_checked: number;
  passed_count: number;
  failed_count: number;
  results: PlaybookRuleMatchResult[];
}
