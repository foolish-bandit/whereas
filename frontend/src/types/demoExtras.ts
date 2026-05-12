/**
 * Demo-only extensions to the contract detail. These don't exist on the
 * canonical backend payload (ContractDetail) — they're surfaced via a
 * sibling map in mockData / mockApi so the demo Review + History tabs
 * have realistic content without polluting the production API types.
 */

export type FindingSeverity = "blocker" | "high" | "medium" | "low";
export type FindingStatus = "open" | "accepted" | "waived" | "mitigated";

export interface PlaybookFinding {
  id: string;
  playbook_rule_id: string;
  rule_label: string;
  severity: FindingSeverity;
  status: FindingStatus;
  finding_text: string;
  standard_position: string;
  suggested_redline: string;
  citation: { text_preview_start: number; text_preview_end: number };
}

export type VersionSource =
  | "upload"
  | "generated"
  | "docuseal_signed"
  | "counterparty";

export interface DocumentVersion {
  id: string;
  version_label: string;
  uploaded_at: string;
  uploaded_by_display_name: string;
  source: VersionSource;
  text_preview: string;
  summary: string;
}
