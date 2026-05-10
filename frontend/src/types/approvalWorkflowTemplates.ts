/**
 * Types for the approval workflow templates surface (PR #51).
 *
 * Mirrors `backend/app/schemas/approval_workflow_templates.py`. A
 * workflow template is a reusable blueprint; instantiating one creates
 * a concrete `ApprovalWorkflowRun` plus `ApprovalStep` rows. The
 * template itself is never mutated by an instantiation.
 *
 * Naming caution: `AgreementTemplate` (a document blueprint) is a
 * different concept; the instantiate request carries it under
 * `agreement_template_id` so the two never collide on the wire.
 */

import type { ApprovalWorkflowRun } from "./approvalWorkflows";

export type ApprovalWorkflowTemplateStatus = "active" | "archived";

export interface ApprovalWorkflowTemplateStep {
  id: string;
  organization_id: string;
  workflow_template_id: string;
  step_order: number;
  title: string;
  description: string | null;
  approver_name: string | null;
  approver_email: string | null;
  assigned_to: string | null;
  /** Computed into a concrete `due_date = today + due_in_days` on instantiation. */
  due_in_days: number | null;
  metadata_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalWorkflowTemplate {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  template_type: string | null;
  status: ApprovalWorkflowTemplateStatus | string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  metadata_json: Record<string, unknown> | null;
  steps: ApprovalWorkflowTemplateStep[];
}

export interface ApprovalWorkflowTemplateStepCreate {
  step_order?: number | null;
  title: string;
  description?: string | null;
  approver_name?: string | null;
  approver_email?: string | null;
  assigned_to?: string | null;
  due_in_days?: number | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface ApprovalWorkflowTemplateStepPatch {
  step_order?: number | null;
  title?: string | null;
  description?: string | null;
  approver_name?: string | null;
  approver_email?: string | null;
  assigned_to?: string | null;
  due_in_days?: number | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface ApprovalWorkflowTemplateCreateRequest {
  name: string;
  description?: string | null;
  template_type?: string | null;
  metadata_json?: Record<string, unknown> | null;
  steps: ApprovalWorkflowTemplateStepCreate[];
}

export interface ApprovalWorkflowTemplatePatch {
  name?: string | null;
  description?: string | null;
  template_type?: string | null;
  status?: ApprovalWorkflowTemplateStatus | string | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface ListApprovalWorkflowTemplateFilters {
  status?: string;
  template_type?: string;
  /** Defaults to false on the server. */
  include_archived?: boolean;
  /** Case-insensitive substring match on template name. */
  query?: string;
}

export interface CreateApprovalWorkflowFromTemplateRequest {
  name: string;
  request_id?: string | null;
  contract_id?: string | null;
  /** AgreementTemplate id (document blueprint), distinct from the workflow template. */
  agreement_template_id?: string | null;
  metadata_json?: Record<string, unknown> | null;
}

/** Instantiation returns a fully populated ApprovalWorkflowRun. */
export type CreateApprovalWorkflowFromTemplateResponse = ApprovalWorkflowRun;
