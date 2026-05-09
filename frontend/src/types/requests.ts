/**
 * Types for the contract intake / Requests surface.
 *
 * Mirrors `backend/app/schemas/requests.py`. Status, request_type,
 * contract_type, and priority are deliberately string-typed so the
 * UI can display whatever values the backend actually returns;
 * recommended values are listed inline.
 */
export type ContractRequestStatus =
  | "open"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface ContractRequest {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  /** Suggested: new_contract, review_existing, amendment, renewal, other. */
  request_type: string | null;
  /** Suggested: NDA, MSA, SOW, DPA, Employment Agreement, Lease, Other. */
  contract_type: string | null;
  status: ContractRequestStatus | string;
  /** Suggested: low, normal, high, urgent. */
  priority: string | null;
  requester_name: string | null;
  requester_email: string | null;
  counterparty_name: string | null;
  /** ISO date (YYYY-MM-DD). */
  due_date: string | null;
  assigned_to: string | null;
  linked_contract_id: string | null;
  linked_template_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  metadata_json: Record<string, unknown> | null;
}

export interface ContractRequestCreateRequest {
  title: string;
  description?: string | null;
  request_type?: string | null;
  contract_type?: string | null;
  priority?: string | null;
  requester_name?: string | null;
  requester_email?: string | null;
  counterparty_name?: string | null;
  due_date?: string | null;
  assigned_to?: string | null;
  linked_contract_id?: string | null;
  linked_template_id?: string | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface ContractRequestUpdateRequest {
  title?: string;
  description?: string | null;
  request_type?: string | null;
  contract_type?: string | null;
  status?: ContractRequestStatus | string;
  priority?: string | null;
  requester_name?: string | null;
  requester_email?: string | null;
  counterparty_name?: string | null;
  due_date?: string | null;
  assigned_to?: string | null;
  linked_contract_id?: string | null;
  linked_template_id?: string | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface ListContractRequestFilters {
  status?: string;
  request_type?: string;
  contract_type?: string;
  priority?: string;
  assigned_to?: string;
  /** ISO date (YYYY-MM-DD). */
  due_before?: string;
  /** ISO date (YYYY-MM-DD). */
  due_after?: string;
  include_cancelled?: boolean;
}
