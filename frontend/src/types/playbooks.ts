/**
 * Types mirroring the backend playbook responses.
 *
 * The persistence layer stores `parsed_rules` as opaque JSON. The
 * `rules: PlaybookRuleSummary[]` array on the detail response is the
 * UI-friendly projection: it carries enough fields to render a list
 * row without knowing the full per-rule_type shape, which keeps the
 * frontend forward-compatible if the schema gains new rule types.
 */
export type PlaybookSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "blocker";

export type PlaybookRuleType =
  | "required_clause"
  | "preferred_value"
  | "text_contains";

export interface PlaybookRuleSummary {
  id: string;
  title: string;
  rule_type: PlaybookRuleType | string;
  clause_type: string;
  severity: PlaybookSeverity | string;
}

export interface PlaybookSummary {
  id: string;
  name: string;
  description: string | null;
  jurisdiction: string | null;
  contract_type: string | null;
  version: string;
  is_active: boolean;
  rule_count: number;
  created_at: string;
  updated_at: string;
}

export interface PlaybookDetail extends PlaybookSummary {
  yaml_source: string;
  parsed_rules: Record<string, unknown>;
  rules: PlaybookRuleSummary[];
}

export interface PlaybookValidationIssue {
  message: string;
  path: string | null;
}

export interface PlaybookValidateResponse {
  ok: true;
  schema_version: string;
  name: string;
  description: string | null;
  jurisdiction: string | null;
  contract_type: string | null;
  version: string;
  rule_count: number;
  rules: PlaybookRuleSummary[];
}

export interface PlaybookValidationErrorBody {
  ok: false;
  errors: PlaybookValidationIssue[];
}
