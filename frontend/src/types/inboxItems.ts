/**
 * Types for the Inbox / work-queue surface.
 *
 * Mirrors `backend/app/schemas/inbox_items.py`. Status, item_type, and
 * priority are deliberately string-typed; recommended values are
 * listed inline.
 */
export type InboxItemStatus = "open" | "completed" | "dismissed";

export interface InboxItem {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  /**
   * Suggested: request_review, contract_review, signature_followup,
   * metadata_cleanup, general.
   */
  item_type: string;
  status: InboxItemStatus | string;
  /** Suggested: low, normal, high, urgent. */
  priority: string | null;
  assigned_to: string | null;
  /** ISO date (YYYY-MM-DD). */
  due_date: string | null;
  request_id: string | null;
  contract_id: string | null;
  template_id: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  metadata_json: Record<string, unknown> | null;
}

export interface InboxItemCreateRequest {
  title: string;
  description?: string | null;
  item_type: string;
  priority?: string | null;
  assigned_to?: string | null;
  due_date?: string | null;
  request_id?: string | null;
  contract_id?: string | null;
  template_id?: string | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface InboxItemUpdateRequest {
  title?: string;
  description?: string | null;
  item_type?: string;
  status?: InboxItemStatus | string;
  priority?: string | null;
  assigned_to?: string | null;
  due_date?: string | null;
  request_id?: string | null;
  contract_id?: string | null;
  template_id?: string | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface ListInboxItemFilters {
  status?: string;
  item_type?: string;
  priority?: string;
  assigned_to?: string;
  /** ISO date (YYYY-MM-DD). */
  due_before?: string;
  /** ISO date (YYYY-MM-DD). */
  due_after?: string;
  include_dismissed?: boolean;
}
