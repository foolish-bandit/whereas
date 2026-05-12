/**
 * Frontend helpers for translating raw ``ContractArtifact`` taxonomy
 * (``original_upload``, ``generated_docx``, ``signed_pdf``, …) into
 * user-facing labels and origin copy for the Repository detail view
 * (PR #68).
 *
 * The UI never surfaces the on-disk artifact_type names to legal
 * end-users. Developer/debug surfaces may still show them, but the
 * Repository workspace funnels everything through these helpers so a
 * label change is a one-line edit.
 *
 * These helpers also avoid leaking storage internals: they read only
 * the public fields already exposed by ``ContractArtifactResponse``
 * (the ``storage_key`` / ``wrapped_dek`` columns are stripped at the
 * schema layer and re-scrubbed in ``scrubSecrets``).
 */
import type { ContractArtifact } from "../types/contracts";

/**
 * Lookup of user-facing artifact labels.
 *
 * ``original_upload + request_upload`` is a special case: when the
 * file landed on the Repository via the request → upload conversion
 * path (PR #65), the term "Uploaded agreement" reads better than
 * "Source file" because the user is reviewing counterparty paper.
 * Every other ``original_upload`` source flavor (`user_upload`,
 * legacy, null) collapses to "Source file".
 */
export function artifactDisplayLabel(
  artifactType: string,
  source?: string | null,
): string {
  switch (artifactType) {
    case "original_upload":
      if (source === "request_upload") return "Uploaded agreement";
      return "Source file";
    case "generated_docx":
      return "Generated Word document";
    case "signed_pdf":
      return "Signed PDF";
    case "redline":
      return "Redline";
    case "attachment":
      return "Attachment";
    default:
      // Avoid surfacing the raw enum to users; fall back to a generic
      // bucket so a new artifact_type doesn't render as
      // "weird_internal_thing". Developers can still inspect the row
      // via the API directly.
      return "File";
  }
}

/**
 * The four artifact buckets we surface in the document-lifecycle strip.
 * Order matches the left-to-right rendering order; the workspace also
 * relies on this order when picking the "current document" label.
 */
export type LifecycleSlot =
  | "original_upload"
  | "generated_docx"
  | "signed_pdf"
  | "text_preview";

/**
 * Backend download priority is signed PDF > generated DOCX > original
 * upload > legacy fallback (see ``docs/local-first-pwa-clm-architecture.md``
 * §6.2). The Repository detail view mirrors that priority for the
 * "Current document" label so users see the same artifact name the
 * Download action will actually fetch.
 */
export function pickCurrentDocumentLabel(
  artifacts: readonly ContractArtifact[],
): { label: string; slot: LifecycleSlot } | null {
  const signed = artifacts.find((a) => a.artifact_type === "signed_pdf");
  if (signed) {
    return {
      label: artifactDisplayLabel("signed_pdf", signed.source),
      slot: "signed_pdf",
    };
  }
  const generated = artifacts.find((a) => a.artifact_type === "generated_docx");
  if (generated) {
    return {
      label: artifactDisplayLabel("generated_docx", generated.source),
      slot: "generated_docx",
    };
  }
  const original = artifacts.find((a) => a.artifact_type === "original_upload");
  if (original) {
    return {
      label: artifactDisplayLabel("original_upload", original.source),
      slot: "original_upload",
    };
  }
  return null;
}

/**
 * Human-readable origin sentence derived from the artifact's safe
 * fields. Reads only ``source`` and the small whitelist of keys we
 * already populate in ``metadata_json`` (``template_id`` /
 * ``template_name`` / ``request_id`` / ``upload_source`` /
 * ``docuseal_submission_id``). Anything else is intentionally
 * ignored — we never render ``metadata_json`` wholesale.
 */
export function artifactOriginCopy(
  artifact: ContractArtifact,
): string | null {
  const meta = (artifact.metadata_json ?? {}) as Record<string, unknown>;
  if (artifact.artifact_type === "signed_pdf") {
    return "Signed through DocuSeal";
  }
  if (artifact.artifact_type === "generated_docx") {
    const name = typeof meta.template_name === "string" ? meta.template_name : null;
    return name
      ? `Generated from template “${name}”`
      : "Generated from template";
  }
  if (artifact.artifact_type === "original_upload") {
    if (artifact.source === "request_upload") {
      return "Converted from request upload";
    }
    if (artifact.source === "user_upload" || artifact.source == null) {
      return "Uploaded directly";
    }
    return null;
  }
  return null;
}

/**
 * Pick the highest-priority origin sentence across all the artifacts
 * on a contract. Mirrors the lifecycle priority: signed > generated >
 * original, so the Details section says "Signed through DocuSeal"
 * once the contract is executed even if the original_upload is still
 * around.
 */
export function pickPrimaryOriginCopy(
  artifacts: readonly ContractArtifact[],
): string | null {
  const signed = artifacts.find((a) => a.artifact_type === "signed_pdf");
  if (signed) return artifactOriginCopy(signed);
  const generated = artifacts.find((a) => a.artifact_type === "generated_docx");
  if (generated) return artifactOriginCopy(generated);
  const original = artifacts.find((a) => a.artifact_type === "original_upload");
  if (original) return artifactOriginCopy(original);
  return null;
}

/**
 * Safe summary of the source/origin marker shown in the Files list
 * row. Same whitelist as ``artifactOriginCopy`` but rendered as a
 * short chip rather than a sentence.
 */
export function artifactSourceChip(
  artifact: ContractArtifact,
): string | null {
  switch (artifact.source) {
    case "user_upload":
      return "Uploaded";
    case "request_upload":
      return "From request";
    case "template_generation":
      return "From template";
    case "docuseal":
      return "From DocuSeal";
    default:
      return null;
  }
}

/**
 * Pick the priority-winning artifact for the current document marker.
 * Mirrors the backend download-priority order exactly so the badge
 * matches what ``downloadContract`` actually fetches.
 */
function priorityArtifact(
  artifacts: readonly ContractArtifact[],
): ContractArtifact | null {
  return (
    artifacts.find((a) => a.artifact_type === "signed_pdf") ??
    artifacts.find((a) => a.artifact_type === "generated_docx") ??
    artifacts.find((a) => a.artifact_type === "original_upload") ??
    null
  );
}

/**
 * True iff ``artifact`` is the artifact the Download action would
 * resolve to right now. Used by the document history view to draw
 * exactly one "Current document" badge.
 */
export function isCurrentArtifact(
  artifact: ContractArtifact,
  artifacts: readonly ContractArtifact[],
): boolean {
  const winner = priorityArtifact(artifacts);
  return winner != null && winner.id === artifact.id;
}

/**
 * One row in the document-history view. Pre-computed so the renderer
 * does not have to re-derive priority / sort order / metadata chips
 * for every render.
 */
export interface ArtifactHistoryItem {
  artifact: ContractArtifact;
  displayLabel: string;
  originCopy: string | null;
  sourceChip: string | null;
  isCurrent: boolean;
  metadataChips: readonly ArtifactMetadataChip[];
  /**
   * For ``redline`` rows persisted by PR #91, the resolved labels of
   * the two source artifacts the redline was derived from. The
   * metadata that backs this is the allowlisted
   * ``base_artifact_id`` / ``compare_artifact_id`` / type fields the
   * save endpoint writes — no extracted text, no diff content.
   * ``null`` for non-redline rows or when neither id is recoverable.
   */
  redlineLinkage: RedlineLinkage | null;
}

export interface ArtifactMetadataChip {
  key: string;
  label: string;
}

/**
 * Resolved view of a saved redline's source artifacts. Each side may
 * be ``present`` (the source artifact is still in the contract's
 * artifact list) or absent (deleted, archived, or simply not on the
 * loaded slice) — in the absent case ``label`` falls back to the
 * artifact-type label from metadata so the row still reads as
 * "Redline of: Source file ↔ Signed PDF" instead of carrying raw
 * ids.
 */
export interface RedlineLinkage {
  base: RedlineLinkageSide;
  compare: RedlineLinkageSide;
}

export interface RedlineLinkageSide {
  /** User-facing label, resolved from the artifact if present. */
  label: string;
  /** Source artifact filename when known. */
  filename: string | null;
  /** Whether the source artifact was found in the current list. */
  present: boolean;
}

// Allowlist of ``metadata_json`` keys safe to surface in the UI:
// ``template_name``, ``request_id``, ``upload_source``,
// ``docuseal_submission_id``, ``signed_at``. Everything else is
// dropped — we never render ``metadata_json`` wholesale because it
// can carry user-provided notes, internal variable_keys, or other
// context that has not been audited for display. The branches in
// ``safeArtifactMetadataChips`` below are the only readers of
// ``metadata_json`` values for display.

function pickString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Render a safe set of metadata chips for a single artifact. Pulls
 * from the ``SAFE_METADATA_KEYS`` allowlist only; anything outside
 * the allowlist is ignored. Returns ``[]`` when no chips apply.
 */
export function safeArtifactMetadataChips(
  artifact: ContractArtifact,
): ArtifactMetadataChip[] {
  const meta = (artifact.metadata_json ?? {}) as Record<string, unknown>;
  const chips: ArtifactMetadataChip[] = [];
  // Template generation: surface the template name (NOT the id).
  if (artifact.artifact_type === "generated_docx") {
    const name = pickString(meta, "template_name");
    if (name) chips.push({ key: "template_name", label: `Template: ${name}` });
  }
  // Request conversion: surface the originating request (id is opaque
  // but stable; we link it from the request workspace already).
  if (artifact.source === "request_upload") {
    const reqId = pickString(meta, "request_id");
    if (reqId) chips.push({ key: "request_id", label: "From request" });
  }
  if (artifact.artifact_type === "original_upload") {
    const uploadSource = pickString(meta, "upload_source");
    if (uploadSource === "request_conversion" && !chips.some((c) => c.key === "request_id")) {
      chips.push({ key: "upload_source", label: "From request" });
    }
  }
  // Signed PDF: signed_at is small and useful; the submission id is
  // long and opaque so we only show a short marker that DocuSeal
  // produced this artifact rather than the raw id.
  if (artifact.artifact_type === "signed_pdf") {
    const signedAt = pickString(meta, "signed_at");
    if (signedAt) chips.push({ key: "signed_at", label: `Signed ${signedAt}` });
    const sub = pickString(meta, "docuseal_submission_id");
    if (sub) chips.push({ key: "docuseal_submission_id", label: "DocuSeal submission" });
  }
  return chips;
}

/**
 * Resolve the two source artifacts of a saved ``redline`` row from
 * the contract's current artifact list (PR #92).
 *
 * Reads only the allowlisted metadata keys the save endpoint writes
 * (``base_artifact_id``, ``compare_artifact_id``, ``base_artifact_type``,
 * ``compare_artifact_type``). Falls back to the artifact-type label
 * when a source artifact is no longer in the list, marking that side
 * ``present=false`` so the renderer can hint that it's missing.
 *
 * Returns ``null`` when the artifact is not a redline, when
 * ``metadata_json`` is missing, or when neither id is recoverable —
 * in those cases the row simply skips the linkage line.
 */
export function resolveRedlineLinkage(
  artifact: ContractArtifact,
  allArtifacts: readonly ContractArtifact[],
): RedlineLinkage | null {
  if (artifact.artifact_type !== "redline") return null;
  const meta = (artifact.metadata_json ?? {}) as Record<string, unknown>;
  const baseId = pickString(meta, "base_artifact_id");
  const compareId = pickString(meta, "compare_artifact_id");
  if (!baseId && !compareId) return null;
  const baseTypeFallback = pickString(meta, "base_artifact_type");
  const compareTypeFallback = pickString(meta, "compare_artifact_type");
  return {
    base: _resolveSide(allArtifacts, baseId, baseTypeFallback),
    compare: _resolveSide(allArtifacts, compareId, compareTypeFallback),
  };
}

function _resolveSide(
  allArtifacts: readonly ContractArtifact[],
  artifactId: string | null,
  typeFallback: string | null,
): RedlineLinkageSide {
  const found = artifactId
    ? allArtifacts.find((a) => a.id === artifactId)
    : undefined;
  if (found) {
    return {
      label: artifactDisplayLabel(found.artifact_type, found.source),
      filename: found.filename,
      present: true,
    };
  }
  return {
    label: typeFallback
      ? artifactDisplayLabel(typeFallback, null)
      : "File",
    filename: null,
    present: false,
  };
}

function createdAtMs(artifact: ContractArtifact): number {
  const t = Date.parse(artifact.created_at);
  // Anything unparseable sorts last; matches "no timestamp" being the
  // legacy/unknown case.
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Build the document-history rows for the workspace. Sorted newest
 * first by ``created_at`` (with id tie-break so the order is stable),
 * priority-winner flagged with ``isCurrent``, and metadata pre-scrubbed
 * through the safe allowlist.
 */
export function getArtifactHistoryItems(
  artifacts: readonly ContractArtifact[],
): ArtifactHistoryItem[] {
  const winner = priorityArtifact(artifacts);
  return artifacts
    .slice()
    .sort((a, b) => {
      const dt = createdAtMs(b) - createdAtMs(a);
      if (dt !== 0) return dt;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    })
    .map((artifact) => ({
      artifact,
      displayLabel: artifactDisplayLabel(artifact.artifact_type, artifact.source),
      originCopy: artifactOriginCopy(artifact),
      sourceChip: artifactSourceChip(artifact),
      isCurrent: winner != null && winner.id === artifact.id,
      metadataChips: safeArtifactMetadataChips(artifact),
      redlineLinkage: resolveRedlineLinkage(artifact, artifacts),
    }));
}

/**
 * Re-export ``formatBytes`` under the PR-#69 name. Keeps the helper
 * surface area in one place so a future change to size formatting can
 * be made without crawling the workspace page.
 */
export { formatBytes as formatFileSize } from "./format";
