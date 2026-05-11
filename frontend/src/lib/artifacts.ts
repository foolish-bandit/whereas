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
