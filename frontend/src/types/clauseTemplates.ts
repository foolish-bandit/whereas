export interface ClauseTemplate {
  id: string;
  organization_id: string;
  name: string;
  clause_type: string;
  text: string;
  description: string | null;
  jurisdiction: string | null;
  contract_type: string | null;
  version: string | null;
  source: string | null;
  tags: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ClauseTemplateCreateRequest {
  name: string;
  clause_type: string;
  text: string;
  description?: string | null;
  jurisdiction?: string | null;
  contract_type?: string | null;
  version?: string | null;
  source?: string | null;
  tags?: string[] | null;
}

export type ClauseTemplateUpdateRequest = Partial<ClauseTemplateCreateRequest> & {
  is_active?: boolean;
};
