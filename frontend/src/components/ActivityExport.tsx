import { useState } from "react";

import {
  ApiError,
  MissingDevUserError,
  exportContractActivity,
  exportRequestActivity,
  type ActivityExportFormat,
  type DownloadResult,
} from "../lib/api";

type Props =
  | { kind: "request"; requestId: string }
  | { kind: "contract"; contractId: string };

type State =
  | { kind: "idle" }
  | { kind: "downloading"; format: ActivityExportFormat }
  | { kind: "error"; message: string };

/**
 * PR #75 — small action row that exports the activity timeline of a
 * Repository (contract) or a Request as CSV or JSON.
 *
 * The component is intentionally narrow:
 *
 * - It calls the existing authenticated API helper, which returns a
 *   blob; we trigger a browser download by anchor-click.
 * - It never renders the response body in the DOM. Loading + error
 *   states are short, generic strings — the export bytes go straight
 *   to a file, not into rendered text.
 * - It uses user-facing terminology ("Activity", "Repository") rather
 *   than backend terminology ("audit log", "contract").
 */
export default function ActivityExport(props: Props): JSX.Element {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onClick(format: ActivityExportFormat) {
    setState({ kind: "downloading", format });
    try {
      const result =
        props.kind === "contract"
          ? await exportContractActivity(props.contractId, format)
          : await exportRequestActivity(props.requestId, format);
      triggerBlobDownload(result, format, props);
      setState({ kind: "idle" });
    } catch (err) {
      if (err instanceof MissingDevUserError || err instanceof ApiError) {
        setState({ kind: "error", message: err.message });
        return;
      }
      setState({ kind: "error", message: "Export failed unexpectedly." });
    }
  }

  const busy = state.kind === "downloading";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-ink-subtle" data-testid="activity-export-label">
        Export activity:
      </span>
      <button
        type="button"
        onClick={() => onClick("csv")}
        disabled={busy}
        className="rounded border border-rule px-2 py-1 text-ink hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="activity-export-csv"
      >
        {state.kind === "downloading" && state.format === "csv"
          ? "Exporting…"
          : "CSV"}
      </button>
      <button
        type="button"
        onClick={() => onClick("json")}
        disabled={busy}
        className="rounded border border-rule px-2 py-1 text-ink hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="activity-export-json"
      >
        {state.kind === "downloading" && state.format === "json"
          ? "Exporting…"
          : "JSON"}
      </button>
      {state.kind === "error" ? (
        <span className="text-danger" data-testid="activity-export-error">
          {state.message}
        </span>
      ) : null}
    </div>
  );
}

function triggerBlobDownload(
  result: DownloadResult,
  format: ActivityExportFormat,
  props: Props,
): void {
  const fallback = fallbackFilename(props, format);
  const filename = result.filename ?? fallback;
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function fallbackFilename(
  props: Props,
  format: ActivityExportFormat,
): string {
  const subjectType = props.kind === "contract" ? "contract" : "request";
  const subjectId =
    props.kind === "contract" ? props.contractId : props.requestId;
  const safe = subjectId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `whereas-${subjectType}-${safe}-activity.${format}`;
}
