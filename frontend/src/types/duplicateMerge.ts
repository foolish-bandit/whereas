/**
 * Types for the duplicate-merge surface (PR #76).
 *
 * Mirrors ``backend/app/schemas/duplicate_merge.py``. The endpoint
 * accepts a source Repository record id and merges its artifacts
 * into the target. No raw artifact internals or storage references
 * are surfaced here; that posture is enforced server-side.
 */

import type { DuplicateContractCandidate } from "./contractIntake";

export interface DuplicateMergeRequest {
  source_contract_id: string;
  /** Optional human-readable note. Not echoed back, not persisted. */
  merge_note?: string | null;
}

export interface DuplicateMergeResponse {
  target_contract_id: string;
  source_contract_id: string;
  artifacts_moved: number;
  merged_at: string;
  merged_by_user_id: string;
  /**
   * Counts of links left attached to the source after merge.
   * This PR deliberately does not rewire workflow / request links;
   * the UI uses these to render an honest "stayed on the merged
   * record" warning.
   */
  workflow_runs_attached_to_source: number;
  requests_attached_to_source: number;
}

/**
 * Response shape of ``GET /api/contracts/{id}/duplicate-candidates``.
 * Wraps the existing ``DuplicateContractCandidate`` type used at
 * upload time so the merge UI and the upload-review surface speak
 * the same vocabulary.
 */
export interface DuplicateCandidatesResponse {
  candidates: DuplicateContractCandidate[];
}
