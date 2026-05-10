/**
 * Types for the approval workflow surface (PR #50).
 *
 * Mirrors `backend/app/schemas/approval_workflows.py`. Workflow + step
 * statuses are typed as the documented enum values, but kept as union
 * with `string` so a future backend addition doesn't immediately break
 * the UI.
 */

export type ApprovalWorkflowRunStatus =
  | "active"
  | "completed"
  | "rejected"
  | "cancelled";

export type ApprovalStepStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "skipped";

export interface ApprovalStep {
  id: string;
  organization_id: string;
  workflow_run_id: string;
  step_order: number;
  title: string;
  description: string | null;
  approver_name: string | null;
  approver_email: string | null;
  assigned_to: string | null;
  status: ApprovalStepStatus | string;
  decision_note: string | null;
  decided_at: string | null;
  /** ISO date (YYYY-MM-DD). */
  due_date: string | null;
  inbox_item_id: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: Record<string, unknown> | null;
}

export interface ApprovalWorkflowRun {
  id: string;
  organization_id: string;
  name: string;
  status: ApprovalWorkflowRunStatus | string;
  request_id: string | null;
  contract_id: string | null;
  template_id: string | null;
  current_step_order: number | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  metadata_json: Record<string, unknown> | null;
  steps: ApprovalStep[];
}

export interface ApprovalWorkflowRunListItem {
  id: string;
  organization_id: string;
  name: string;
  status: ApprovalWorkflowRunStatus | string;
  request_id: string | null;
  contract_id: string | null;
  template_id: string | null;
  current_step_order: number | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalStepCreate {
  title: string;
  description?: string | null;
  approver_name?: string | null;
  approver_email?: string | null;
  assigned_to?: string | null;
  /** ISO date (YYYY-MM-DD). */
  due_date?: string | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface ApprovalWorkflowRunCreateRequest {
  name: string;
  request_id?: string | null;
  contract_id?: string | null;
  template_id?: string | null;
  steps: ApprovalStepCreate[];
  metadata_json?: Record<string, unknown> | null;
}

export interface ApprovalStepDecisionRequest {
  decision_note?: string | null;
}

export interface ListApprovalWorkflowFilters {
  status?: string;
  request_id?: string;
  contract_id?: string;
  /** Defaults to true on the server. Set false to hide terminal runs. */
  include_terminal?: boolean;
}
