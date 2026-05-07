export type ExtractedField = {
  field_name: string
  value_json: unknown
  span_start: number | null
  span_end: number | null
  span_text: string | null
  confidence: number
  model_name: string
  prompt_version: string
  extracted_at: string
}

export type ContractListItem = {
  id: string
  title: string
  status: string
  mime_type: string
  file_hash_sha256: string
  page_count: number | null
  created_at: string
  updated_at: string
}

export type ContractDetail = ContractListItem & {
  full_text: string | null
  extracted_fields: ExtractedField[]
}

export type UploadContractResponse = ContractListItem & {
  extracted_fields: ExtractedField[]
  message: string | null
}
