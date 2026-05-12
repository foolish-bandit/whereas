import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import {
  ApiError,
  MissingDevUserError,
  dismissInboxItem,
  listInboxItems,
  updateInboxItem,
} from "../lib/api";
import { mountedPath } from "../lib/routes";
import type { InboxItem } from "../types/inboxItems";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; rows: InboxItem[] }
  | { kind: "error"; message: string };

/**
 * Approval Tasks view (PR #79).
 *
 * A purpose-built lens on the Inbox filtered to `item_type=approval`,
 * styled so reviewers can quickly see which Request or Repository
 * record needs them and click through. Approve / reject decisions
 * themselves still happen on the Approval Workflows page where the
 * full step list lives — this view is for triage and navigation.
 *
 * The generic Inbox (work queue across all item types) is still
 * available at `/inbox` for users who want to see everything.
 */
export default function ApprovalTasksPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const location = useLocation();

  useEffect(() => {
    let aborted = false;
    setState({ kind: "loading" });
    listInboxItems({
      item_type: "approval",
      status: includeCompleted ? undefined : "open",
    })
      .then((rows) => {
        if (!aborted) setState({ kind: "loaded", rows });
      })
      .catch((err) => {
        if (aborted) return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
        } else {
          setState({ kind: "error", message: "Could not load approval tasks." });
        }
      });
    return () => {
      aborted = true;
    };
  }, [includeCompleted]);

  async function onComplete(id: string) {
    try {
      const row = await updateInboxItem(id, { status: "completed" });
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: includeCompleted
                ? prev.rows.map((r) => (r.id === id ? row : r))
                : prev.rows.filter((r) => r.id !== id),
            }
          : prev,
      );
    } catch {
      // best-effort
    }
  }

  async function onDismiss(id: string) {
    try {
      await dismissInboxItem(id);
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: prev.rows.filter((r) => r.id !== id),
            }
          : prev,
      );
    } catch {
      // best-effort
    }
  }

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);

  return (
    <div className="space-y-5" data-testid="approval-tasks-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Approval tasks</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Open approval steps assigned to you and your team. Open the related
            Request or Repository record for context, then act on the matching
            workflow.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-subtle">
          <input
            type="checkbox"
            checked={includeCompleted}
            onChange={(e) => setIncludeCompleted(e.target.checked)}
            data-testid="approval-tasks-include-completed"
          />
          Show completed
        </label>
      </div>

      {state.kind === "loading" && (
        <p className="text-sm text-ink-muted">Loading approval tasks…</p>
      )}
      {state.kind === "error" && (
        <p className="text-sm text-danger" data-testid="approval-tasks-error">
          {state.message}
        </p>
      )}
      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title="No approval tasks"
          description={
            includeCompleted
              ? "Nothing has hit the approval queue yet. Attach a workflow or policy to a request or Repository record to create tasks."
              : "Inbox zero for approvals. Toggle “Show completed” to review resolved approval work."
          }
        />
      )}
      {state.kind === "loaded" && state.rows.length > 0 && (
        <ul className="space-y-2" data-testid="approval-tasks-list">
          {state.rows.map((row) => (
            <ApprovalTaskRow
              key={row.id}
              row={row}
              pathname={location.pathname}
              todayIso={todayIso}
              onComplete={() => onComplete(row.id)}
              onDismiss={() => onDismiss(row.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ApprovalTaskRow({
  row,
  pathname,
  todayIso,
  onComplete,
  onDismiss,
}: {
  row: InboxItem;
  pathname: string;
  todayIso: string;
  onComplete: () => void;
  onDismiss: () => void;
}) {
  const overdue =
    row.status === "open" && row.due_date !== null && row.due_date < todayIso;
  const reviewHref = primaryReviewHref(row, pathname);
  return (
    <li
      className="rounded border border-rule p-3 text-sm"
      data-testid="approval-task-row"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium text-ink">{row.title}</p>
          <p className="text-xs text-ink-subtle">
            <span data-testid="approval-task-status">{row.status}</span>
            {row.priority ? ` · ${row.priority} priority` : ""}
            {row.due_date ? ` · due ${row.due_date}` : ""}
            {overdue ? (
              <span
                className="ml-2 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-danger"
                data-testid="approval-task-overdue"
              >
                overdue
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Link
            to={mountedPath(`/approvals/tasks/${row.id}`, pathname)}
            className="rounded border border-rule px-2 py-1 text-ink hover:bg-canvas-muted"
            data-testid="approval-task-open-detail"
          >
            Open detail
          </Link>
          {reviewHref && (
            <Link
              to={reviewHref}
              className="rounded border border-ink bg-ink px-2 py-1 text-canvas hover:opacity-90"
              data-testid="approval-task-review"
            >
              Review
            </Link>
          )}
          {row.status === "open" && (
            <button
              type="button"
              className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
              onClick={onComplete}
              data-testid="approval-task-complete"
            >
              Mark complete
            </button>
          )}
          {row.status !== "dismissed" && (
            <button
              type="button"
              className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
              onClick={onDismiss}
              data-testid="approval-task-dismiss"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
      {row.description && (
        <p className="mt-2 text-sm text-ink-muted">{row.description}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {row.request_id && (
          <Link
            to={mountedPath(`/requests/${row.request_id}`, pathname)}
            className="text-ink-muted underline hover:text-ink"
            data-testid="approval-task-request-link"
          >
            Open related request
          </Link>
        )}
        {row.contract_id && (
          <Link
            to={mountedPath(`/repository/${row.contract_id}`, pathname)}
            className="text-ink-muted underline hover:text-ink"
            data-testid="approval-task-contract-link"
          >
            Open repository record
          </Link>
        )}
        {!row.request_id && !row.contract_id && (
          <Link
            to={mountedPath("/approvals/workflows", pathname)}
            className="text-ink-muted underline hover:text-ink"
            data-testid="approval-task-workflows-link"
          >
            Open approval workflows
          </Link>
        )}
      </div>
    </li>
  );
}

/**
 * Pick the most useful destination for the Review CTA. We prefer the
 * Request detail (where reviewers see intake context and approval
 * status); otherwise the Repository record; otherwise the workflows
 * list as a last resort.
 */
function primaryReviewHref(row: InboxItem, pathname: string): string | null {
  if (row.request_id) {
    return mountedPath(`/requests/${row.request_id}`, pathname);
  }
  if (row.contract_id) {
    return mountedPath(`/repository/${row.contract_id}`, pathname);
  }
  return mountedPath("/approvals/workflows", pathname);
}
