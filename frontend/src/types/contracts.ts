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

export interface ContractDetail extends ContractListItem {
  full_text: string | null;
  extracted_fields: ExtractedField[];
}

export interface UploadContractResponse extends ContractListItem {
  extracted_fields: ExtractedField[];
  message?: string | null;
}
