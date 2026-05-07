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
}
