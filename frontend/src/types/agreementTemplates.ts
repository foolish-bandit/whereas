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
 * Request body for ``POST /agreement-templates/{id}/generate``.
 *
 * `title` is optional — the backend falls back to a templated title
 * when omitted. `variable_values` is a flat key→value map; the backend
 * validates against the template's variables and rejects unknown keys.
 */
export interface AgreementGenerationRequest {
  title?: string | null;
  variable_values: Record<string, unknown>;
}

/**
 * Successful generation result. The new draft contract is the
 * canonical record; the artifact is the generated DOCX. Markdown
 * snapshot is present when conversion produced one and absent
 * otherwise — the DOCX is the legal record either way.
 */
export interface AgreementGenerationResponse {
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
