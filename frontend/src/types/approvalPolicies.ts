export type ApprovalPolicyStatus = "active" | "archived";

export interface ApprovalPolicy {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  status: ApprovalPolicyStatus;
  workflow_template_id: string;
  workflow_template_name?: string | null;
  request_type: string | null;
  contract_type: string | null;
  priority: string | null;
  agreement_template_id: string | null;
  auto_attach: boolean;
  applies_to_generated_contracts: boolean;
  created_at: string;
  updated_at: string | null;
  created_by?: string | null;
  metadata_json: Record<string, unknown> | null;
}

export interface ApprovalPolicyCreateRequest {
  name: string;
  description?: string | null;
  workflow_template_id: string;
  request_type?: string | null;
  contract_type?: string | null;
  priority?: string | null;
  agreement_template_id?: string | null;
  auto_attach?: boolean;
  applies_to_generated_contracts?: boolean;
  metadata_json?: Record<string, unknown> | null;
}

export interface ApprovalPolicyPatchRequest {
  name?: string;
  description?: string | null;
  status?: ApprovalPolicyStatus;
  workflow_template_id?: string;
  request_type?: string | null;
  contract_type?: string | null;
  priority?: string | null;
  agreement_template_id?: string | null;
  auto_attach?: boolean;
  applies_to_generated_contracts?: boolean;
  metadata_json?: Record<string, unknown> | null;
}

export interface ListApprovalPolicyFilters {
  include_archived?: boolean;
  status?: string;
  request_type?: string;
  contract_type?: string;
  priority?: string;
  workflow_template_id?: string;
}
