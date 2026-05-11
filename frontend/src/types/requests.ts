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

/**
 * Body for ``POST /api/requests/{id}/convert-to-contract``.
 *
 * Mirrors ``AgreementGenerationRequest`` — the conversion endpoint
 * reuses the template generation service. ``variable_values`` is
 * keyed by the linked template's variable ``key``s.
 */
export interface ConvertRequestToContractRequest {
  title?: string | null;
  variable_values: Record<string, unknown>;
}

/**
 * Response shape for ``POST /api/requests/{id}/convert-to-contract``.
 *
 * Reuses the same contract / artifact / markdown_snapshot projections
 * the templates surface returns, plus the freshly-updated request row
 * so the UI can swap both pieces of state in one shot. Storage and
 * encryption fields never appear here.
 */
export interface ConvertRequestToContractResponse {
  request: ContractRequest;
  contract: {
    id: string;
    title: string;
    status: string;
    mime_type: string;
    file_hash_sha256: string;
    page_count: number | null;
    created_at: string;
    updated_at: string;
  };
  artifact: {
    id: string;
    contract_id: string;
    artifact_type: "generated_docx" | string;
    storage_backend: string;
    filename: string | null;
    mime_type: string | null;
    file_hash_sha256: string | null;
    size_bytes: number | null;
    source: "template_generation" | string | null;
    is_official: boolean;
    created_at: string;
    metadata_json: Record<string, unknown> | null;
  };
  markdown_snapshot: {
    id: string;
    contract_id: string;
    markdown_text: string;
    source_kind: string;
    converter_name: string;
    converter_version: string | null;
    conversion_status: string;
    conversion_warnings: unknown[] | null;
    created_at: string;
  } | null;
  variables_used: string[];
}

/**
 * Body for ``POST /api/requests/{id}/convert-upload`` (PR #65).
 *
 * The endpoint is multipart/form-data: the API client builds a
 * ``FormData`` from this shape so the request includes the file part
 * plus the optional metadata fields below as form values.
 */
export interface ConvertRequestUploadInput {
  file: File;
  /** Optional Contract title; falls back to the derived filename. */
  title?: string | null;
  counterparty_name?: string | null;
  contract_type?: string | null;
  notes?: string | null;
  signal?: AbortSignal;
}

/**
 * Response shape for ``POST /api/requests/{id}/convert-upload``.
 *
 * Same projections used by the template-conversion response, minus
 * ``variables_used`` (there are no template variables on this path).
 * Storage / encryption fields are excluded by construction at the
 * schema layer.
 */
export interface ConvertRequestUploadResponse {
  request: ContractRequest;
  contract: {
    id: string;
    title: string;
    status: string;
    mime_type: string;
    file_hash_sha256: string;
    page_count: number | null;
    created_at: string;
    updated_at: string;
  };
  artifact: {
    id: string;
    contract_id: string;
    artifact_type: "original_upload" | string;
    storage_backend: string;
    filename: string | null;
    mime_type: string | null;
    file_hash_sha256: string | null;
    size_bytes: number | null;
    source: "request_upload" | string | null;
    is_official: boolean;
    created_at: string;
    metadata_json: Record<string, unknown> | null;
  };
  markdown_snapshot: {
    id: string;
    contract_id: string;
    markdown_text: string;
    source_kind: string;
    converter_name: string;
    converter_version: string | null;
    conversion_status: string;
    conversion_warnings: unknown[] | null;
    created_at: string;
  } | null;
}
