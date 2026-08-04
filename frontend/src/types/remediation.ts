import type { InboxItem } from "./inboxItems";

export type FindingRemediationSourceType =
  | "playbook_preferred_language"
  | "clause_template"
  | "none";

export interface FindingRemediationPlan {
  finding_id: string;
  contract_id: string;
  review_run_id: string;
  playbook_id: string;
  rule_id: string;
  rule_title: string;
  clause_type: string;
  severity: string;
  finding_status: string;
  suggested_language: string | null;
  source_type: FindingRemediationSourceType;
  source_id: string | null;
  source_name: string | null;
  rationale: string;
  scope_warning: string | null;
  existing_task: InboxItem | null;
}

export interface FindingRemediationTaskRequest {
  assigned_to?: string | null;
  /** ISO date (YYYY-MM-DD). */
  due_date?: string | null;
}

export interface FindingRemediationTaskResponse {
  plan: FindingRemediationPlan;
  task: InboxItem;
  created: boolean;
  reopened: boolean;
}
