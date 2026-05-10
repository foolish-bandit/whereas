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
  | "cancelled_without_completed_approval";

export interface ContractApprovalGate {
  allowed: boolean;
  code: ApprovalGateCode;
  request_id: string | null;
  blocking_workflow_ids: string[];
  completed_workflow_ids: string[];
  active_count: number;
  rejected_count: number;
  cancelled_count: number;
  completed_count: number;
}
