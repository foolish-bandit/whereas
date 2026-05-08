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
