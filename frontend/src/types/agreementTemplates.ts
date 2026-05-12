export interface AgreementTemplate {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  template_type: string | null;
  status: "active" | "archived" | string;
  created_at: string;
  updated_at: string;
  metadata_json: Record<string, unknown> | null;
}

export interface AgreementTemplateCreateRequest {
  name: string;
  description?: string | null;
  template_type?: string | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface AgreementTemplateUpdateRequest {
  name?: string;
  description?: string | null;
  template_type?: string | null;
  status?: "active" | "archived";
  metadata_json?: Record<string, unknown> | null;
}

export interface AgreementTemplateArtifact {
  id: string;
  template_id: string;
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

export interface AgreementTemplateMarkdownSnapshot {
  id: string;
  template_id: string;
  markdown_text: string;
  source_kind: string;
  converter_name: string | null;
  converter_version: string | null;
  conversion_status: "ready" | "failed" | string;
  conversion_warnings: string[] | null;
  created_at: string;
}

export interface AgreementTemplateVariable {
  id: string;
  template_id: string;
  key: string;
  label: string;
  variable_type: string;
  required: boolean;
  default_value: string | null;
  help_text: string | null;
  sort_order: number;
  metadata_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface AgreementTemplateVariableCreateRequest {
  key: string;
  label: string;
  variable_type: string;
  required?: boolean;
  default_value?: string | null;
  help_text?: string | null;
  sort_order?: number;
  metadata_json?: Record<string, unknown> | null;
}

/**
 * One placeholder detected in the template's Text preview (PR #96).
 *
 * Returned by ``GET /api/agreement-templates/{id}/variable-suggestions``.
 * Keys that already exist as ``AgreementTemplateVariable`` rows are
 * filtered out server-side, so this list is just *new* suggestions.
 */
export interface TemplateVariableSuggestion {
  key: string;
  label: string;
  occurrences: number;
}

export interface AgreementTemplateVariableUpdateRequest {
  key?: string;
  label?: string;
  variable_type?: string;
  required?: boolean;
  default_value?: string | null;
  help_text?: string | null;
  sort_order?: number;
  metadata_json?: Record<string, unknown> | null;
}

/**
 * Request payload for `POST /api/agreement-templates/{id}/generate`.
 *
 * `title` is optional — when omitted the backend derives one from the
 * template name + timestamp. `variable_values` is keyed by the
 * template's variable `key`s.
 */
export interface AgreementGenerationRequest {
  title?: string | null;
  variable_values: Record<string, unknown>;
}

/**
 * The new draft contract record created by template generation.
 *
 * Mirrors the contract list-item shape the rest of the app already
 * understands. Storage / encryption metadata is intentionally absent.
 */
export interface GeneratedContractSummary {
  id: string;
  title: string;
  status: string;
  mime_type: string;
  file_hash_sha256: string;
  page_count: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * The `generated_docx` ContractArtifact created alongside the new
 * contract. Storage internals (storage_key, wrapped_dek) are stripped.
 */
export interface GeneratedAgreementArtifact {
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
}

export interface AgreementGenerationResponse {
  contract: GeneratedContractSummary;
  artifact: GeneratedAgreementArtifact;
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
