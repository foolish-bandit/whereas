import type {
  DuplicateContractCandidate,
  ExtractedContractMetadata,
} from "./contractIntake";

export type ContractStatus =
  | "uploaded"
  | "extracting"
  | "ready"
  | "failed"
  | "sent_for_signature"
  | "executed";

export interface ContractListItem {
  id: string;
  title: string;
  status: ContractStatus | string;
  mime_type: string;
  file_hash_sha256: string;
  page_count: number | null;
  created_at: string;
  updated_at: string;
  /**
   * PR #76 — when set, this Repository record has been merged into
   * another record (the canonical one). The default list filters
   * these out; detail pages still resolve and render a safe merged
   * notice. Older API responses that don't carry the field treat it
   * as null/absent.
   */
  merged_into_contract_id?: string | null;
  merged_at?: string | null;
}

export type ExtractedFieldValue = unknown;

export interface ExtractedField {
  field_name: string;
  value_json: ExtractedFieldValue;
  span_start: number | null;
  span_end: number | null;
  span_text: string | null;
  confidence: number;
  model_name: string;
  prompt_version: string;
  extracted_at: string;
}

/**
 * One persisted clause from the segmentation pipeline. `text` MUST equal
 * `contract.full_text.slice(span_start, span_end)` exactly. The frontend
 * still re-checks before highlighting, since the backend can lie or rot.
 */
export interface Clause {
  id: string;
  contract_id: string;
  ordinal: number;
  heading: string | null;
  clause_type: string | null;
  clause_type_source: string | null;
  text: string;
  span_start: number;
  span_end: number;
  confidence: number | null;
  segmentation_method: string;
  model_name: string | null;
  prompt_version: string | null;
}

export interface ContractDetail extends ContractListItem {
  full_text: string | null;
  extracted_fields: ExtractedField[];
  clauses: Clause[];
}

export interface UploadContractResponse extends ContractListItem {
  extracted_fields: ExtractedField[];
  clauses: Clause[];
  message?: string | null;
  // PR #66 — upload-intake suggestions + warning-level duplicate
  // candidates. Either may be empty; neither blocks the upload.
  extracted_metadata?: ExtractedContractMetadata | null;
  duplicate_candidates?: DuplicateContractCandidate[];
}

/**
 * A stored file-like artifact tied to a contract. The original upload
 * is recorded as `artifact_type === "original_upload"` with
 * `is_official === true`. Future PRs surface generated DOCX, signed
 * PDFs, redlines, and exhibits as additional artifact rows.
 *
 * The listing endpoint is metadata-only — `storage_key` is intentionally
 * omitted from this type. Use the existing download endpoint to fetch
 * the original artifact's bytes.
 */
export interface ContractArtifact {
  id: string;
  contract_id: string;
  artifact_type: string;
  storage_backend: string;
  filename: string | null;
  mime_type: string | null;
  file_hash_sha256: string | null;
  size_bytes: number | null;
  source: string | null;
  is_official: boolean;
  created_at: string;
  metadata_json: Record<string, unknown> | null;
}

/**
 * A persisted Markdown working snapshot for a contract. The DOCX or
 * PDF remains the original legal artifact; this is a lightweight
 * representation used for fast preview and search.
 */
export interface ContractMarkdownSnapshot {
  id: string;
  contract_id: string;
  markdown_text: string;
  source_kind: string;
  converter_name: string;
  converter_version: string | null;
  conversion_status: string;
  conversion_warnings: unknown[] | null;
  created_at: string;
}
