/**
 * Request/response types for the DocuSeal send flow. The backend
 * decrypts the artifact and POSTs it to DocuSeal as base64; the
 * client only sees this opaque submission projection.
 */
export interface DocuSealSigner {
  email: string;
  name: string;
  role?: string;
}

export interface SendContractToDocuSealRequest {
  signers: DocuSealSigner[];
  approval_override?: boolean;
  approval_override_reason?: string;
}

export interface SendContractToDocuSealResponse {
  contract_id: string;
  artifact_id: string | null;
  artifact_type: string | null;
  filename: string | null;
  submission_id: string | null;
  status: string;
  embed_url: string | null;
  signer_count: number;
  raw: Record<string, unknown> | null;
}

export type ApprovalGateCode =
  | "no_linked_request"
  | "no_workflows_required"
  | "approvals_completed"
  | "active_approval_workflows"
  | "rejected_approval_workflows"
  | "required_approval_policy_unmet"
  | "cancelled_without_completed_approval";

/**
 * Compact, UI-safe projection of an `ApprovalPolicy` row that the
 * DocuSeal gate response carries so the gate can render policy *names*
 * inline without a separate fetch. Mirrors
 * `RequestApprovalPolicySummary` from the request approval visibility
 * surface — same shape so display code can be reused. `description` /
 * `metadata_json` / `created_by` / storage fields are intentionally
 * omitted server-side.
 */
export interface ApprovalGatePolicySummary {
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

export interface ContractApprovalGate {
  allowed: boolean;
  code: ApprovalGateCode | string;
  request_id: string | null;
  blocking_workflow_ids: string[];
  completed_workflow_ids: string[];
  active_count: number;
  rejected_count: number;
  cancelled_count: number;
  completed_count: number;
  /**
   * Policy ids retained for backwards compatibility with clients that
   * pre-date the named-policy projection. Always aligned with
   * `required_policies` / `missing_policies` element-by-element.
   */
  required_policy_ids?: string[];
  missing_policy_ids?: string[];
  required_policies?: ApprovalGatePolicySummary[];
  missing_policies?: ApprovalGatePolicySummary[];
}
