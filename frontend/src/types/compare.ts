/**
 * PR #71 — text-based artifact version compare wire types.
 *
 * Mirrors ``backend/app/schemas/compare.py``. Storage internals
 * (``storage_key`` / ``wrapped_dek``) and the raw extracted text are
 * never part of this payload; the response carries safe metadata
 * plus a structured diff for the Document History "Compare versions"
 * panel.
 */

export type DiffLineType = "context" | "added" | "removed";
export type DiffBlockType = "context" | "added" | "removed" | "changed";

export interface ArtifactCompareSide {
  artifact_id: string;
  artifact_type: string;
  /** User-facing label resolved by the backend (Source file, Signed PDF, …). */
  label: string;
  filename: string | null;
  created_at: string;
}

export interface CompareSummary {
  added_lines: number;
  removed_lines: number;
  changed_blocks: number;
  unchanged_lines: number;
}

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffBlock {
  type: DiffBlockType;
  /** 1-based start line in the base version. */
  base_line_start: number;
  /** 1-based start line in the compare version. */
  compare_line_start: number;
  lines: DiffLine[];
}

export interface ArtifactCompareResponse {
  base: ArtifactCompareSide;
  compare: ArtifactCompareSide;
  summary: CompareSummary;
  diff_blocks: DiffBlock[];
  /**
   * Opaque tags the backend appended (e.g. ``base_text_truncated``,
   * ``diff_lines_truncated``). The frontend maps a small allowlist
   * to human-readable copy in the panel; unknown tags are dropped.
   */
  warnings: string[];
}
