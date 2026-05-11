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
 * Generic Inbox / work-queue view (legacy route at /demo/inbox).
 *
 * Approval-specific triage lives at /demo/approvals/tasks; this page
 * keeps the rest of the work queue (request_review, signature_followup,
 * metadata_cleanup, general). PR #84 polished this surface so rows
 * link straight to the related Request, Repository record, or
 * Agreement Template when those ids are present, item-type and
 * priority render as small pills instead of inline " · " text, and
 * an overdue badge appears when an open item is past its due date.
 */
export default function InboxPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"" | "open" | "completed">(
    "",
  );
  const [itemTypeFilter, setItemTypeFilter] = useState("");
  const location = useLocation();

  useEffect(() => {
    let aborted = false;
    setState({ kind: "loading" });
    listInboxItems({
      include_dismissed: includeDismissed,
      status: statusFilter || undefined,
      item_type: itemTypeFilter || undefined,
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
  }, [includeDismissed, statusFilter, itemTypeFilter]);

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

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const isFiltered = Boolean(
    statusFilter || itemTypeFilter || includeDismissed,
  );

  return (
    <div className="space-y-5" data-testid="inbox-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Inbox</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Work-queue items across requests, signatures, metadata
            cleanup, and general follow-ups. Click an item to jump to
            the related Request, Repository record, or template;
            complete or dismiss items as you go. Approval tasks live
            on <Link
              to={mountedPath("/approvals/tasks", location.pathname)}
              className="underline hover:text-ink"
              data-testid="inbox-approvals-link"
            >their dedicated page</Link>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-subtle">
          <select
            className="rounded border border-rule px-2 py-1"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "" | "open" | "completed")
            }
            data-testid="inbox-filter-status"
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="completed">Completed</option>
          </select>
          <input
            className="rounded border border-rule px-2 py-1"
            placeholder="Filter by type"
            value={itemTypeFilter}
            onChange={(e) => setItemTypeFilter(e.target.value)}
            data-testid="inbox-filter-type"
          />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeDismissed}
              onChange={(e) => setIncludeDismissed(e.target.checked)}
              data-testid="inbox-include-dismissed"
            />
            Show dismissed
          </label>
        </div>
      </div>

      {state.kind === "loading" && (
        <p className="text-sm text-ink-muted">Loading inbox…</p>
      )}
      {state.kind === "error" && (
        <p className="text-sm text-danger" data-testid="inbox-error">
          {state.message}
        </p>
      )}
      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title={isFiltered ? "No items match the current filters" : "Inbox zero"}
          description={
            isFiltered
              ? "Try a different status or type, or clear the filters."
              : "Nothing to do here right now. New requests, contracts, and signature events will queue up automatically."
          }
        />
      )}
      {state.kind === "loaded" && state.rows.length > 0 && (
        <ul className="space-y-2" data-testid="inbox-list">
          {state.rows.map((row) => (
            <InboxRow
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

function InboxRow({
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
  const openHref = primaryOpenHref(row, pathname);
  return (
    <li
      className="rounded border border-rule p-3 text-sm"
      data-testid="inbox-row"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">
            {openHref ? (
              <Link
                to={openHref}
                className="hover:underline"
                data-testid="inbox-row-title-link"
              >
                {row.title}
              </Link>
            ) : (
              row.title
            )}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <ItemTypeChip type={row.item_type} />
            <StatusChip status={row.status} />
            {row.priority && <PriorityChip priority={row.priority} />}
            {row.due_date && (
              <span className="text-ink-subtle">due {row.due_date}</span>
            )}
            {overdue && (
              <span
                className="rounded bg-danger/10 px-1.5 py-0.5 font-medium uppercase tracking-wide text-danger"
                data-testid="inbox-row-overdue"
              >
                overdue
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {openHref && (
            <Link
              to={openHref}
              className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
              data-testid="inbox-row-open"
            >
              Open
            </Link>
          )}
          {row.status === "open" && (
            <button
              type="button"
              className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
              onClick={onComplete}
            >
              Mark complete
            </button>
          )}
          {row.status !== "dismissed" && (
            <button
              type="button"
              className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
              onClick={onDismiss}
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
  );
}

function ItemTypeChip({ type }: { type: string }) {
  // Preserve the raw item_type as the chip's testId so existing tests
  // that grep for "request_review" / "approval" still match. Display
  // copy converts the snake_case to a friendlier label.
  const friendly = type.replace(/_/g, " ");
  return (
    <span
      className="rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-ink-muted"
      data-testid="inbox-row-type"
    >
      {friendly}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "open"
      ? "border-info-ring bg-info-soft text-info"
      : status === "completed"
        ? "border-success-ring bg-success-soft text-success"
        : "border-rule bg-canvas-muted text-ink-muted";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-medium uppercase tracking-wide ${tone}`}
    >
      <span data-testid="inbox-status">{status}</span>
    </span>
  );
}

function PriorityChip({ priority }: { priority: string }) {
  const tone =
    priority === "urgent" || priority === "high"
      ? "border-danger-ring bg-danger-soft text-danger"
      : "border-rule bg-canvas-subtle text-ink-muted";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-medium uppercase tracking-wide ${tone}`}
      data-testid="inbox-row-priority"
    >
      {priority}
    </span>
  );
}

/**
 * Pick the most useful destination for this inbox row. Preferred
 * order: Request detail (intake + approval context) → Repository
 * record → Agreement template. Returns null for rows with none of
 * those ids, in which case the row title falls back to non-link text.
 */
function primaryOpenHref(row: InboxItem, pathname: string): string | null {
  if (row.request_id) {
    return mountedPath(`/requests/${row.request_id}`, pathname);
  }
  if (row.contract_id) {
    return mountedPath(`/repository/${row.contract_id}`, pathname);
  }
  if (row.template_id) {
    return mountedPath(`/requests/templates/${row.template_id}`, pathname);
  }
  return null;
}
