/**
 * Types for the activity timeline surface (PR #58).
 *
 * Mirrors `backend/app/schemas/activity.py`. Both endpoints
 * (`/api/requests/{id}/activity` and `/api/contracts/{id}/activity`)
 * return the same item shape.
 *
 * The endpoint is read-only; rows project from the existing audit log
 * and never mutate state.
 */

export type ActivityEventType =
  | "approval.workflow.created"
  | "approval.step.activated"
  | "approval.step.approved"
  | "approval.step.rejected"
  | "approval.workflow.completed"
  | "approval.workflow.rejected"
  | "approval.workflow.cancelled"
  | "contract.sent_for_signature"
  | "contract.executed"
  | string;

export interface ActivityTimelineItem {
  id: string;
  event_type: ActivityEventType;
  /** ISO timestamp. */
  occurred_at: string;
  actor_user_id: string | null;
  /** Server-rendered label; clients should not derive this. */
  title: string;
  /** Optional second-line description (server-rendered). */
  description: string | null;
  request_id: string | null;
  contract_id: string | null;
  workflow_run_id: string | null;
  approval_step_id: string | null;
  step_order: number | null;
  /** "ad_hoc" / "template" / "policy" — workflow origin label. */
  source: string | null;
}

export interface ActivityTimelineResponse {
  items: ActivityTimelineItem[];
}
