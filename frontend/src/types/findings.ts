/**
 * Types mirroring the persisted playbook-review backend.
 *
 * Shape matches `backend/app/schemas/findings.py`. The persistent
 * model stores only failed deterministic outcomes; the per-rule
 * "results" array on a `ReviewRunDetail` is the matcher's full
 * pass-and-fail list, recomputed by the backend so the UI can show
 * passes alongside the persisted fails.
 */
import type {
  PlaybookRuleMatchResult,
  PlaybookRuleStatus,
} from "./review";

/**
 * Reviewer-settable values. `superseded` is owned by the rerun sweep
 * on the backend and is never sent over the wire by the client.
 */
export type ReviewerFindingStatus = "open" | "reviewed" | "ignored";

/**
 * The full set of values persisted on a finding row. The UI may
 * receive `superseded` rows when explicitly opting in via a query
 * filter or a run's "show all" toggle.
 */
export type FindingStatus = ReviewerFindingStatus | "superseded";

export interface DeviationFinding {
  id: string;
  organization_id: string;
  contract_id: string;
  playbook_id: string;
  review_run_id: string;
  rule_id: string;
  rule_title: string;
  rule_type: string;
  clause_type: string;
  severity: string;
  status: PlaybookRuleStatus;
  finding_status: FindingStatus;
  message: string;
  clause_id: string | null;
  evidence_text: string | null;
  span_start: number | null;
  span_end: number | null;
  matched_terms: string[];
  expected_value: string | null;
  guidance: string | null;
  preferred_language: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewRunSummary {
  id: string;
  organization_id: string;
  contract_id: string;
  playbook_id: string;
  playbook_name: string;
  rules_checked: number;
  passed_count: number;
  failed_count: number;
  created_at: string;
}

export interface ReviewRunDetail extends ReviewRunSummary {
  findings: DeviationFinding[];
  results: PlaybookRuleMatchResult[];
}

export interface RunPlaybookReviewRequest {
  playbook_id: string;
}

export interface UpdateFindingStatusRequest {
  finding_status: ReviewerFindingStatus;
}

export interface ListFindingsFilters {
  playbook_id?: string;
  finding_status?: FindingStatus;
  severity?: string;
  review_run_id?: string;
  include_superseded?: boolean;
}
