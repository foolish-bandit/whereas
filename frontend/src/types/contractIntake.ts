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
