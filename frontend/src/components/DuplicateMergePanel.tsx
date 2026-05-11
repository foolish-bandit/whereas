import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  MissingDevUserError,
  getContractDuplicateCandidates,
  mergeDuplicateContract,
} from "../lib/api";
import type { DuplicateContractCandidate } from "../types/contractIntake";
import type { DuplicateMergeResponse } from "../types/duplicateMerge";

interface Props {
  /** The canonical Repository record. Source candidates merge INTO it. */
  targetContractId: string;
  /**
   * Called after a successful merge so the parent can refetch its
   * detail / Document History / activity. The merged source id is
   * passed for convenience; callers typically refetch the target
   * regardless of which source was merged.
   */
  onMerged?: (response: DuplicateMergeResponse) => void;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; candidates: DuplicateContractCandidate[] }
  | { kind: "error"; message: string };

type MergeState =
  | { kind: "idle" }
  | { kind: "confirming"; candidate: DuplicateContractCandidate }
  | { kind: "merging"; sourceId: string }
  | { kind: "error"; message: string }
  | { kind: "success"; response: DuplicateMergeResponse };

/**
 * PR #76 — duplicate-merge affordance for a Repository record.
 *
 * The component renders nothing when there are no candidates. When
 * there are, each candidate gets a "Merge into this Repository
 * record" action that opens a confirmation modal before the actual
 * API call.
 *
 * The merge is intentionally narrow:
 *
 * - It does NOT delete the duplicate's files; artifacts move into
 *   this record's Document History instead.
 * - It marks the duplicate record as merged and hides it from the
 *   default Repository list.
 * - It does NOT change DocuSeal state, approval gates, or any
 *   workflow state. The confirmation copy reflects that posture so
 *   users aren't surprised by what is (and isn't) migrated.
 *
 * Server-side responses pass through ``scrubSecrets`` and the
 * component only renders allowlisted candidate fields, so
 * ``storage_key`` / ``wrapped_dek`` / artifact internals cannot
 * appear in the DOM.
 */
export default function DuplicateMergePanel({
  targetContractId,
  onMerged,
}: Props): JSX.Element | null {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "idle" });
  const [mergeState, setMergeState] = useState<MergeState>({ kind: "idle" });

  const fetchCandidates = useCallback(async () => {
    setLoadState({ kind: "loading" });
    try {
      const { candidates } = await getContractDuplicateCandidates(
        targetContractId,
      );
      setLoadState({ kind: "loaded", candidates });
    } catch (err) {
      if (err instanceof MissingDevUserError || err instanceof ApiError) {
        setLoadState({ kind: "error", message: err.message });
        return;
      }
      setLoadState({ kind: "error", message: "Could not load duplicates." });
    }
  }, [targetContractId]);

  useEffect(() => {
    void fetchCandidates();
  }, [fetchCandidates]);

  async function performMerge(candidate: DuplicateContractCandidate) {
    setMergeState({ kind: "merging", sourceId: candidate.contract_id });
    try {
      const response = await mergeDuplicateContract(
        targetContractId,
        candidate.contract_id,
      );
      setMergeState({ kind: "success", response });
      onMerged?.(response);
      // Refresh so the merged candidate disappears from the list.
      await fetchCandidates();
    } catch (err) {
      if (err instanceof MissingDevUserError || err instanceof ApiError) {
        setMergeState({ kind: "error", message: err.message });
        return;
      }
      setMergeState({
        kind: "error",
        message: "Could not merge this duplicate Repository record.",
      });
    }
  }

  if (loadState.kind === "loading" || loadState.kind === "idle") {
    return (
      <section
        className="mt-3 rounded border border-rule p-3 text-xs text-ink-subtle"
        data-testid="duplicate-merge-panel-loading"
      >
        Looking for possible duplicates…
      </section>
    );
  }
  if (loadState.kind === "error") {
    return (
      <section
        className="mt-3 rounded border border-rule p-3 text-xs text-danger"
        data-testid="duplicate-merge-panel-error"
      >
        {loadState.message}
      </section>
    );
  }
  if (loadState.candidates.length === 0) {
    if (mergeState.kind === "success") {
      return (
        <section
          className="mt-3 rounded border border-rule p-3 text-xs"
          data-testid="duplicate-merge-panel-success-only"
        >
          <p className="text-success" data-testid="duplicate-merge-success" role="status">
            Merged. {mergeState.response.artifacts_moved}{" "}
            {mergeState.response.artifacts_moved === 1 ? "file" : "files"}{" "}
            moved into this record&apos;s Document History.
            {mergeState.response.workflow_runs_attached_to_source > 0
              ? " Approval workflows on the merged record stayed on the original."
              : null}
          </p>
        </section>
      );
    }
    return null;
  }

  return (
    <section
      className="mt-3 rounded border border-warning-ring bg-warning-soft p-3 text-xs text-ink"
      data-testid="duplicate-merge-panel"
      aria-label="Possible duplicate Repository records"
    >
      <p className="text-sm font-medium text-ink">
        Possible duplicate Repository record
        {loadState.candidates.length === 1 ? "" : "s"}
      </p>
      <p className="mt-1 text-ink-muted">
        Merging brings the duplicate&apos;s files into this record&apos;s
        Document History. Whereas does not delete anything.
      </p>
      <ul className="mt-2 space-y-2">
        {loadState.candidates.map((c) => (
          <li
            key={c.contract_id}
            className="flex flex-wrap items-center gap-2"
            data-testid="duplicate-merge-row"
          >
            <span
              className="font-medium text-ink"
              data-testid="duplicate-merge-row-title"
            >
              {c.title}
            </span>
            <span className="text-ink-subtle">
              · {humanReason(c.reason)} ({c.confidence})
            </span>
            <button
              type="button"
              className="ml-auto rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => setMergeState({ kind: "confirming", candidate: c })}
              disabled={mergeState.kind === "merging"}
              data-testid="duplicate-merge-action"
            >
              Merge into this Repository record
            </button>
          </li>
        ))}
      </ul>

      {mergeState.kind === "error" ? (
        <p
          className="mt-2 text-danger"
          data-testid="duplicate-merge-error"
          role="alert"
        >
          {mergeState.message}
        </p>
      ) : null}
      {mergeState.kind === "success" ? (
        <p
          className="mt-2 text-success"
          data-testid="duplicate-merge-success"
          role="status"
        >
          Merged. {mergeState.response.artifacts_moved}{" "}
          {mergeState.response.artifacts_moved === 1 ? "file" : "files"} moved
          into this record&apos;s Document History.
          {mergeState.response.workflow_runs_attached_to_source > 0
            ? " Approval workflows on the merged record stayed on the original."
            : null}
        </p>
      ) : null}

      {mergeState.kind === "confirming" ? (
        <ConfirmationModal
          candidate={mergeState.candidate}
          onCancel={() => setMergeState({ kind: "idle" })}
          onConfirm={async (candidate) => {
            await performMerge(candidate);
          }}
        />
      ) : null}
    </section>
  );
}

function ConfirmationModal(props: {
  candidate: DuplicateContractCandidate;
  onCancel: () => void;
  onConfirm: (candidate: DuplicateContractCandidate) => Promise<void>;
}): JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="duplicate-merge-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="duplicate-merge-modal"
    >
      <div className="w-full max-w-md rounded border border-rule bg-canvas p-4 text-sm text-ink shadow-xl">
        <h2
          id="duplicate-merge-modal-title"
          className="text-base font-semibold text-ink"
          data-testid="duplicate-merge-modal-title"
        >
          Merge into this Repository record?
        </h2>
        <div
          className="mt-3 space-y-2 text-xs text-ink-subtle"
          data-testid="duplicate-merge-modal-body"
        >
          <p>
            The duplicate record{" "}
            <span className="font-medium text-ink">{props.candidate.title}</span>{" "}
            will be marked as merged and hidden from normal Repository
            results.
          </p>
          <p>
            Its files (the source file, any generated Word document, and any
            signed PDF) will appear in this Repository record&apos;s Document
            History. <strong className="text-ink">No files are deleted.</strong>
          </p>
          <p>
            Approval workflows and request links stay on the original record.
            DocuSeal is not contacted.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded border border-rule bg-canvas px-3 py-1 text-xs text-ink hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-60"
            onClick={props.onCancel}
            disabled={submitting}
            data-testid="duplicate-merge-modal-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded border border-rule bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={async () => {
              setSubmitting(true);
              try {
                await props.onConfirm(props.candidate);
              } finally {
                setSubmitting(false);
              }
            }}
            disabled={submitting}
            data-testid="duplicate-merge-modal-confirm"
          >
            {submitting ? "Merging…" : "Merge duplicate"}
          </button>
        </div>
      </div>
    </div>
  );
}

function humanReason(reason: DuplicateContractCandidate["reason"]): string {
  switch (reason) {
    case "exact_file_hash":
      return "exact file match";
    case "similar_title_and_counterparty":
      return "matching title and counterparty";
    case "similar_title":
      return "matching title";
    default:
      return reason;
  }
}
