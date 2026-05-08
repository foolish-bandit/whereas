/**
 * Types mirroring the suggested-redline backend.
 *
 * Wire shape matches `backend/app/schemas/redlines.py`. Each redline
 * is a non-deterministic LLM-generated suggestion attached to a
 * failed `DeviationFinding`. The status workflow is independent of
 * the parent finding's `finding_status` — a finding can be marked
 * `reviewed` while one of its redlines is still `proposed`.
 */
export type RedlineStatus = "proposed" | "accepted" | "rejected";

export interface SuggestedRedline {
  id: string;
  organization_id: string;
  contract_id: string;
  finding_id: string;
  redline_text: string;
  rationale: string | null;
  model_name: string;
  prompt_version: string;
  confidence: number;
  status: RedlineStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpdateRedlineStatusRequest {
  status: RedlineStatus;
}
