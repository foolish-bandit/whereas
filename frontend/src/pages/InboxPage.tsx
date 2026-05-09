import { useEffect, useState } from "react";

import EmptyState from "../components/EmptyState";
import {
  ApiError,
  MissingDevUserError,
  dismissInboxItem,
  listInboxItems,
  updateInboxItem,
} from "../lib/api";
import type { InboxItem } from "../types/inboxItems";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; rows: InboxItem[] }
  | { kind: "error"; message: string };

export default function InboxPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"" | "open" | "completed">("");

  useEffect(() => {
    let aborted = false;
    setState({ kind: "loading" });
    listInboxItems({
      include_dismissed: includeDismissed,
      status: statusFilter || undefined,
    })
      .then((rows) => {
        if (!aborted) setState({ kind: "loaded", rows });
      })
      .catch((err) => {
        if (aborted) return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
        } else {
          setState({ kind: "error", message: "Could not load inbox." });
        }
      });
    return () => {
      aborted = true;
    };
  }, [includeDismissed, statusFilter]);

  async function onComplete(id: string) {
    try {
      const row = await updateInboxItem(id, { status: "completed" });
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: prev.rows.map((r) => (r.id === id ? row : r)),
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
              rows: includeDismissed
                ? prev.rows.map((r) =>
                    r.id === id ? { ...r, status: "dismissed" } : r,
                  )
                : prev.rows.filter((r) => r.id !== id),
            }
          : prev,
      );
    } catch {
      // best-effort
    }
  }

  return (
    <div className="space-y-5" data-testid="inbox-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Inbox</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Work-queue items. Open a request to triage it; complete or
            dismiss items as you go.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-subtle">
          <select
            className="rounded border border-rule px-2 py-1"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "" | "open" | "completed")
            }
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="completed">Completed</option>
          </select>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeDismissed}
              onChange={(e) => setIncludeDismissed(e.target.checked)}
            />
            Show dismissed
          </label>
        </div>
      </div>

      {state.kind === "loading" && (
        <p className="text-sm text-ink-muted">Loading inbox…</p>
      )}
      {state.kind === "error" && (
        <p className="text-sm text-danger">{state.message}</p>
      )}
      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title="Inbox zero"
          description="Nothing to do here right now. New requests, contracts, and signature events will queue up automatically."
        />
      )}
      {state.kind === "loaded" && state.rows.length > 0 && (
        <ul className="space-y-2" data-testid="inbox-list">
          {state.rows.map((row) => (
            <li
              key={row.id}
              className="rounded border border-rule p-3 text-sm"
              data-testid="inbox-row"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="font-medium text-ink">{row.title}</p>
                  <p className="text-xs text-ink-subtle">
                    {row.item_type} ·{" "}
                    <span data-testid="inbox-status">{row.status}</span>
                    {row.priority ? ` · ${row.priority}` : ""}
                    {row.due_date ? ` · due ${row.due_date}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {row.status === "open" && (
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                      onClick={() => onComplete(row.id)}
                    >
                      Mark complete
                    </button>
                  )}
                  {row.status !== "dismissed" && (
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
                      onClick={() => onDismiss(row.id)}
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
              {row.description && (
                <p className="mt-2 text-sm text-ink-muted">{row.description}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
