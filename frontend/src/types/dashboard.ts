/**
 * Types for the dashboard summary surface.
 *
 * Mirrors `backend/app/schemas/dashboard.py`. The list shapes are
 * deliberately compact projections, not the full request / inbox /
 * contract detail responses — see the backend module docstring for
 * the rationale.
 */

export interface DashboardCounts {
  open_requests: number;
  in_progress_requests: number;
  urgent_or_high_priority_requests: number;
  open_inbox_items: number;
  overdue_inbox_items: number;
  contracts_total: number;
  contracts_sent_for_signature: number;
  contracts_executed: number;
  templates_active: number;
  /** PR #50 — narrow approval workflow surface. */
  active_approval_workflows: number;
  pending_approval_steps: number;
  overdue_approval_steps: number;
  /** PR #51 — reusable approval workflow blueprints. */
  active_approval_workflow_templates: number;
}

export interface DashboardRequestSummary {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  request_type: string | null;
  contract_type: string | null;
  counterparty_name: string | null;
  /** ISO date (YYYY-MM-DD). */
  due_date: string | null;
  linked_contract_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardInboxSummary {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  item_type: string;
  /** ISO date (YYYY-MM-DD). */
  due_date: string | null;
  request_id: string | null;
  contract_id: string | null;
  template_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardContractSummary {
  id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  docuseal_submission_id: string | null;
  has_generated_docx: boolean;
  has_signed_pdf: boolean;
}

export interface DashboardUpcoming {
  requests_due_soon: DashboardRequestSummary[];
  inbox_items_due_soon: DashboardInboxSummary[];
}

export interface DashboardRecentActivity {
  recent_contracts: DashboardContractSummary[];
  recent_requests: DashboardRequestSummary[];
  recent_signed_contracts: DashboardContractSummary[];
}

/**
 * PR #62 — lightweight approval analytics block.
 *
 * Aggregate over existing approval workflow + step rows; no new
 * backend tables, no state transitions. Reporting / explainability
 * only. ``approver_email`` is intentionally omitted from the row
 * shape to keep approver PII off the dashboard surface.
 */
export interface DashboardApprovalAssigneeBucket {
  assigned_to: string | null;
  count: number;
  overdue_count: number;
}

export interface DashboardOldestPendingStep {
  id: string;
  workflow_run_id: string;
  title: string;
  step_order: number;
  assigned_to: string | null;
  approver_name: string | null;
  /** ISO date (YYYY-MM-DD). */
  due_date: string | null;
  created_at: string;
  request_id: string | null;
  contract_id: string | null;
}

export interface DashboardApprovalAnalytics {
  pending_steps: number;
  overdue_steps: number;
  active_workflows: number;
  completed_workflows: number;
  rejected_workflows: number;
  cancelled_workflows: number;
  workflows_completed_last_30_days: number;
  workflows_rejected_last_30_days: number;
  pending_by_assignee: DashboardApprovalAssigneeBucket[];
  oldest_pending_steps: DashboardOldestPendingStep[];
}

export interface DashboardSummary {
  counts: DashboardCounts;
  upcoming: DashboardUpcoming;
  recent_activity: DashboardRecentActivity;
  approval_analytics: DashboardApprovalAnalytics;
}
