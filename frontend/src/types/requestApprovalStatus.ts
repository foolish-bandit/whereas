/**
 * Types for the request approval visibility surface (PR #56).
 *
 * Mirrors `backend/app/schemas/request_approval_status.py`. The endpoint
 * is read-only — it stitches together the request's matching approval
 * policies, the workflow runs attached to the request and (when
 * present) its linked contract, and a summary that aligns with the
 * DocuSeal send gate. Statuses and codes are typed as union-with-string
 * so a future backend value doesn't immediately break the UI.
 */

export interface RequestApprovalPolicySummary {
  id: string;
  name: string;
  workflow_template_id: string;
  auto_attach: boolean;
  applies_to_generated_contracts: boolean;
  request_type: string | null;
  contract_type: string | null;
  priority: string | null;
  agreement_template_id: string | null;
}

export interface RequestApprovalStepSummary {
  id: string;
  step_order: number;
  title: string;
  status: "pending" | "approved" | "rejected" | "skipped" | string;
  assigned_to: string | null;
  approver_name: string | null;
  approver_email: string | null;
  /** ISO date (YYYY-MM-DD). */
  due_date: string | null;
  /** ISO timestamp. */
  decided_at: string | null;
}

export interface RequestApprovalWorkflowSummary {
  id: string;
  name: string;
  status: "active" | "completed" | "rejected" | "cancelled" | string;
  current_step_order: number | null;
  started_at: string;
  completed_at: string | null;
  source_approval_policy_id: string | null;
  source_approval_policy_name: string | null;
  steps: RequestApprovalStepSummary[];
}

export type RequestApprovalBlockingReason =
  | "active_approval_workflows"
  | "rejected_approval_workflows"
  | "required_approval_policy_unmet"
  | "cancelled_without_completed_approval";

export interface RequestApprovalSummary {
  has_required_policies: boolean;
  has_active_workflows: boolean;
  has_rejected_workflows: boolean;
  has_completed_workflows: boolean;
  all_required_policy_workflows_completed: boolean;
  /** `null` when there's no linked contract (the gate doesn't run). */
  ready_for_signature: boolean | null;
  blocking_reason: RequestApprovalBlockingReason | string | null;
  /** Server-rendered plain-English phrasing for `blocking_reason`. */
  blocking_reason_text: string | null;
}

export interface RequestApprovalStatus {
  request_id: string;
  linked_contract_id: string | null;
  matching_policy_ids: string[];
  matching_policies: RequestApprovalPolicySummary[];
  workflow_runs: RequestApprovalWorkflowSummary[];
  summary: RequestApprovalSummary;
}
