/**
 * Shared types for upload-intake intelligence (PR #66).
 *
 * Both ``UploadContractResponse`` and ``ConvertRequestUploadResponse``
 * carry these two fields so the frontend has a single render surface
 * for the "we noticed this looks like an NDA with Acme" + "this
 * might be a duplicate of an existing contract" feedback.
 *
 * Storage / encryption fields don't appear here — the API server's
 * Pydantic projections forbid them by construction.
 */
export type DuplicateContractReason =
  | "exact_file_hash"
  | "similar_title"
  | "similar_title_and_counterparty";

export type DuplicateContractConfidence = "exact" | "possible";

export interface DuplicateContractCandidate {
  contract_id: string;
  title: string;
  reason: DuplicateContractReason;
  confidence: DuplicateContractConfidence;
  /** ISO 8601 timestamp from the backend. */
  created_at: string;
  status: string;
}

export interface ExtractedContractMetadata {
  suggested_title: string | null;
  likely_contract_type: string | null;
  possible_counterparty_name: string | null;
  /** ISO date (YYYY-MM-DD) when present. */
  effective_date: string | null;
  warnings: string[];
}

/**
 * Mirrors ``backend/app/schemas/contract_intake.ContractMetadataUpdateRequest``.
 *
 * All fields are optional; only the keys present in the request body
 * are updated. ``null`` and empty strings clear the non-title fields;
 * ``title`` is non-nullable on the Contract row so blank input
 * coerces to "Untitled contract" on the server.
 */
export interface ContractMetadataUpdateRequest {
  title?: string | null;
  counterparty_name?: string | null;
  contract_type?: string | null;
  /** ISO date (YYYY-MM-DD) when present. */
  effective_date?: string | null;
}

/**
 * Mirrors ``backend/app/schemas/contract_intake.ContractMetadataResponse``.
 *
 * The merged view used by the upload-review surface: ``title`` lives
 * on ``Contract.title``; the rest live on the latest
 * ``original_upload`` artifact's ``metadata_json``. ``changed_fields``
 * is populated by PATCH; GET returns an empty list.
 */
export interface ContractMetadataView {
  contract_id: string;
  title: string;
  counterparty_name: string | null;
  contract_type: string | null;
  /** ISO date (YYYY-MM-DD) when present. */
  effective_date: string | null;
  updated_at: string;
  changed_fields: string[];
}
