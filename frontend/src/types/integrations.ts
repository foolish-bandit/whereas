/**
 * Types for the third-party integrations surface.
 *
 * Mirrors ``backend/app/schemas/integrations.py`` plus
 * ``backend/app/models/__init__.py``'s ``IntegrationProvider`` /
 * ``IntegrationConnectionStatus`` / ``IntegrationIngestMode``.
 *
 * ``provider`` / ``status`` / ``ingest_mode`` are deliberately string-typed;
 * the canonical enum values live with the backend and recommended values
 * are inlined below.
 */

/**
 * Canonical Nango-handled provider keys. Other roadmap providers
 * (Salesforce, HubSpot, Slack, ...) live in the static "planned" cards
 * on the page and never appear in this type.
 */
export type IntegrationProviderKey =
  | "google-drive"
  | "microsoft-onedrive"
  | "microsoft-sharepoint"
  | "gmail"
  | "outlook";

export type IntegrationConnectionStatus =
  | "active"
  | "error"
  | "disconnected";

export type IntegrationIngestMode = "inbox_review" | "direct";

export interface IntegrationProvider {
  key: IntegrationProviderKey | string;
  label: string;
  description: string;
  available: boolean;
}

export interface IntegrationConnection {
  id: string;
  organization_id: string;
  provider: IntegrationProviderKey | string;
  status: IntegrationConnectionStatus | string;
  ingest_mode: IntegrationIngestMode | string;
  display_name: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface ConnectSession {
  token: string;
  expires_at: string | null;
}

export interface CompleteConnectionRequest {
  provider: IntegrationProviderKey | string;
  nango_connection_id: string;
  display_name?: string | null;
  ingest_mode?: IntegrationIngestMode | string;
}

export interface UpdateConnectionRequest {
  display_name?: string | null;
  ingest_mode?: IntegrationIngestMode | string;
}

export interface ManualSyncResult {
  connection_id: string;
  files_seen: number;
  contracts_created: number;
  skipped: number;
  cursor: string | null;
}
