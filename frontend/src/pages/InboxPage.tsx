import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import {
  ApiError,
  MissingDevUserError,
  createRequest,
  dismissInboxItem,
  listInboxItems,
  updateInboxItem,
} from "../lib/api";
import { isDemoMode } from "../lib/env";
import { MOCK_MSA_ID } from "../lib/mockData";
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
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeRoutingPanel, setActiveRoutingPanel] = useState<
    "repository" | "review" | null
  >(null);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [routeNotice, setRouteNotice] = useState<string | null>(null);
  const [repoName, setRepoName] = useState("");
  const [repoType, setRepoType] = useState("");
  const [repoStatus, setRepoStatus] = useState("Draft");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoFolder, setRepoFolder] = useState("");
  const [reviewType, setReviewType] = useState("review_existing");
  const [reviewNotes, setReviewNotes] = useState("");
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const location = useLocation();
  const demoMode = isDemoMode();

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
  }, [includeDismissed, statusFilter, itemTypeFilter, reloadNonce]);

  useEffect(() => {
    if (state.kind !== "loaded") return;
    const visible = new Set(state.rows.map((row) => row.id));
    setSelectedIds((prev) => prev.filter((id) => visible.has(id)));
  }, [state]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedRows = useMemo(() => {
    if (state.kind !== "loaded") return [] as InboxItem[];
    return state.rows.filter((row) => selectedIdSet.has(row.id));
  }, [state, selectedIdSet]);
  const selectedCount = selectedRows.length;
  const selectedHasApproval = selectedRows.some((row) => row.item_type === "approval");
  const selectedSingleApproval =
    selectedRows.length === 1 && selectedRows[0].item_type === "approval";

  useEffect(() => {
    if (!selectAllRef.current || state.kind !== "loaded") return;
    selectAllRef.current.indeterminate =
      selectedCount > 0 && selectedCount < state.rows.length;
  }, [state, selectedCount]);

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
      if (!demoMode) return;
      // Demo fixtures are not always session-writable; keep the UI
      // state coherent even when the demo API rejects a seeded row.
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: prev.rows.map((r) =>
                r.id === id
                  ? { ...r, status: "completed", updated_at: new Date().toISOString() }
                  : r,
              ),
            }
          : prev,
      );
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
      if (!demoMode) return;
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: includeDismissed
                ? prev.rows.map((r) =>
                    r.id === id
                      ? { ...r, status: "dismissed", updated_at: new Date().toISOString() }
                      : r,
                  )
                : prev.rows.filter((r) => r.id !== id),
            }
          : prev,
      );
    }
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelectedIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id),
    );
  }

  function clearSelection() {
    setSelectedIds([]);
    setActiveRoutingPanel(null);
  }

  function selectAllVisible(checked: boolean) {
    if (state.kind !== "loaded") return;
    setSelectedIds(checked ? state.rows.map((row) => row.id) : []);
  }

  async function routeToRepositoryDemo() {
    if (state.kind !== "loaded" || selectedCount === 0 || selectedHasApproval) return;
    setRoutingBusy(true);
    try {
      const now = new Date().toISOString();
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: prev.rows.map((row) =>
                selectedIdSet.has(row.id) && row.item_type !== "approval"
                  ? {
                      ...row,
                      status: "completed",
                      contract_id: row.contract_id ?? MOCK_MSA_ID,
                      updated_at: now,
                    }
                  : row,
              ),
            }
          : prev,
      );
      setRouteNotice(
        `Routed ${selectedCount} inbox item${selectedCount === 1 ? "" : "s"} toward Repository in demo mode.`,
      );
      clearSelection();
    } finally {
      setRoutingBusy(false);
      setActiveRoutingPanel(null);
    }
  }

  async function routeToReviewDemo() {
    if (state.kind !== "loaded" || selectedCount === 0 || selectedHasApproval) return;
    setRoutingBusy(true);
    try {
      const missingRequest = selectedRows.filter(
        (row) => row.item_type !== "approval" && row.request_id === null,
      );
      const createdIds = new Map<string, string>();
      for (const row of missingRequest) {
        const created = await createRequest({
          title: `Review: ${row.title}`,
          description:
            row.description ??
            (reviewNotes.trim() || "Routed from Inbox intake for review."),
          request_type: reviewType,
          priority: row.priority,
          due_date: row.due_date,
        });
        createdIds.set(row.id, created.id);
      }
      const now = new Date().toISOString();
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: prev.rows.map((row) =>
                selectedIdSet.has(row.id) && row.item_type !== "approval"
                  ? {
                      ...row,
                      status: "completed",
                      request_id: row.request_id ?? createdIds.get(row.id) ?? null,
                      item_type: "request_review",
                      updated_at: now,
                    }
                  : row,
              ),
            }
          : prev,
      );
      setRouteNotice(
        `Routed ${selectedCount} inbox item${selectedCount === 1 ? "" : "s"} toward Requests in demo mode.`,
      );
      clearSelection();
    } finally {
      setRoutingBusy(false);
      setActiveRoutingPanel(null);
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
            The intake front door. New uploads and review work appear
            here first, then route to Repository or Requests.
            Approval tasks stay in the approval workflow and live on{" "}
            <Link
              to={mountedPath("/approvals/tasks", location.pathname)}
              className="underline hover:text-ink"
              data-testid="inbox-approvals-link"
            >
              their dedicated page
            </Link>
            .
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-subtle">
          {state.kind === "loaded" && state.rows.length > 0 && (
            <>
              <label className="flex items-center gap-2">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={selectedCount > 0 && selectedCount === state.rows.length}
                  onChange={(e) => selectAllVisible(e.target.checked)}
                  data-testid="inbox-select-all"
                />
                Select all
              </label>
              <span data-testid="inbox-selected-count">
                {selectedCount} selected
              </span>
              {selectedCount > 0 && (
                <button
                  type="button"
                  className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                  onClick={clearSelection}
                  data-testid="inbox-clear-selection-top"
                >
                  Clear selection
                </button>
              )}
            </>
          )}
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

      {routeNotice && (
        <p className="text-sm text-success" data-testid="inbox-route-notice">
          {routeNotice}
        </p>
      )}

      {selectedCount > 0 && (
        <div
          className="space-y-3 rounded border border-rule bg-canvas-subtle p-3"
          data-testid="inbox-bulk-actions"
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded border border-rule px-3 py-1 text-sm hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setActiveRoutingPanel("repository")}
              disabled={selectedHasApproval}
              data-testid="inbox-move-repository"
            >
              Move to Repository
            </button>
            <button
              type="button"
              className="rounded border border-rule px-3 py-1 text-sm hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => setActiveRoutingPanel("review")}
              disabled={selectedHasApproval}
              data-testid="inbox-move-review"
            >
              Move to Requests / Send for Review
            </button>
            <button
              type="button"
              className="rounded border border-rule px-3 py-1 text-sm hover:bg-canvas-muted"
              onClick={clearSelection}
              data-testid="inbox-clear-selection"
            >
              Clear selection
            </button>
          </div>

          {selectedHasApproval && (
            <div className="text-sm text-ink-muted" data-testid="inbox-approval-selection-help">
              Approval tasks must be completed from the approval task detail page.
              {selectedSingleApproval && (
                <>
                  {" "}
                  <Link
                    to={mountedPath(
                      `/approvals/tasks/${selectedRows[0].id}`,
                      location.pathname,
                    )}
                    className="underline hover:text-ink"
                    data-testid="inbox-open-approval-task"
                  >
                    Open approval task
                  </Link>
                  .
                </>
              )}
            </div>
          )}
        </div>
      )}

      {activeRoutingPanel === "repository" && (
        <section
          className="rounded border border-rule bg-canvas p-4"
          data-testid="inbox-repository-panel"
        >
          <h2 className="text-base font-medium text-ink">Repository settings</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Route selected inbox items into the Repository intake flow.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm text-ink-muted">
              <span>Repository name</span>
              <input
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                data-testid="inbox-repo-name"
              />
            </label>
            <label className="space-y-1 text-sm text-ink-muted">
              <span>Contract type</span>
              <input
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={repoType}
                onChange={(e) => setRepoType(e.target.value)}
                data-testid="inbox-repo-type"
              />
            </label>
            <label className="space-y-1 text-sm text-ink-muted">
              <span>Status</span>
              <select
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={repoStatus}
                onChange={(e) => setRepoStatus(e.target.value)}
                data-testid="inbox-repo-status"
              >
                <option value="Draft">Draft</option>
                <option value="In review">In review</option>
                <option value="Ready">Ready</option>
              </select>
            </label>
            <label className="space-y-1 text-sm text-ink-muted">
              <span>Owner</span>
              <input
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={repoOwner}
                onChange={(e) => setRepoOwner(e.target.value)}
                data-testid="inbox-repo-owner"
              />
            </label>
            <label className="space-y-1 text-sm text-ink-muted sm:col-span-2">
              <span>Folder / category</span>
              <input
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={repoFolder}
                onChange={(e) => setRepoFolder(e.target.value)}
                data-testid="inbox-repo-folder"
              />
            </label>
          </div>
          {!demoMode && (
            <p className="mt-3 text-sm text-ink-muted" data-testid="inbox-repo-real-note">
              Repository routing from Inbox will use the existing upload/classification flow.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {demoMode ? (
              <button
                type="button"
                className="rounded border border-ink bg-ink px-3 py-1 text-sm text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={routingBusy}
                onClick={routeToRepositoryDemo}
                data-testid="inbox-repo-route-demo"
              >
                {routingBusy ? "Routing…" : "Route to Repository"}
              </button>
            ) : (
              <Link
                to={mountedPath("/upload", location.pathname)}
                className="rounded border border-ink bg-ink px-3 py-1 text-sm text-canvas hover:opacity-90"
                data-testid="inbox-repo-open-upload"
              >
                Open Repository upload
              </Link>
            )}
            <button
              type="button"
              className="rounded border border-rule px-3 py-1 text-sm hover:bg-canvas-muted"
              onClick={() => setActiveRoutingPanel(null)}
            >
              Close
            </button>
          </div>
        </section>
      )}

      {activeRoutingPanel === "review" && (
        <section
          className="rounded border border-rule bg-canvas p-4"
          data-testid="inbox-review-panel"
        >
          <h2 className="text-base font-medium text-ink">Move to Review</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Supporting information can be added now; template-specific follow-up
            questions are planned in a later pass.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm text-ink-muted">
              <span>Request type</span>
              <select
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={reviewType}
                onChange={(e) => setReviewType(e.target.value)}
                data-testid="inbox-review-type"
              >
                <option value="review_existing">Review existing</option>
                <option value="new_contract">New contract</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="space-y-1 text-sm text-ink-muted sm:col-span-2">
              <span>Supporting information</span>
              <textarea
                className="h-24 w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                data-testid="inbox-review-notes"
              />
            </label>
          </div>
          {!demoMode && (
            <p className="mt-3 text-sm text-ink-muted" data-testid="inbox-review-real-note">
              Review routing from Inbox uses the existing Request creation flow.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {demoMode ? (
              <button
                type="button"
                className="rounded border border-ink bg-ink px-3 py-1 text-sm text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={routingBusy}
                onClick={routeToReviewDemo}
                data-testid="inbox-review-route-demo"
              >
                {routingBusy ? "Routing…" : "Route to Requests"}
              </button>
            ) : (
              <Link
                to={mountedPath("/requests", location.pathname)}
                className="rounded border border-ink bg-ink px-3 py-1 text-sm text-canvas hover:opacity-90"
                data-testid="inbox-review-open-requests"
              >
                Open Requests workspace
              </Link>
            )}
            <button
              type="button"
              className="rounded border border-rule px-3 py-1 text-sm hover:bg-canvas-muted"
              onClick={() => setActiveRoutingPanel(null)}
            >
              Close
            </button>
          </div>
        </section>
      )}

      {state.kind === "loading" && (
        <LoadingSkeleton rows={6} />
      )}
      {state.kind === "error" && (
        <div data-testid="inbox-error">
          <ErrorState
            title="Could not load inbox"
            description={state.message}
            action={
              <button
                type="button"
                className="rounded border border-rule px-3 py-1 text-xs hover:bg-canvas-muted"
                onClick={() => {
                  setState({ kind: "loading" });
                  setReloadNonce((n) => n + 1);
                }}
              >
                Retry
              </button>
            }
          />
        </div>
      )}
      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title={isFiltered ? "No inbox items match current filters" : "Your inbox is clear"}
          description={
            isFiltered
              ? "Try a different status or type, or clear the filters."
              : "New uploads and review work appear here."
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
              selected={selectedIdSet.has(row.id)}
              onToggleSelected={(checked) => toggleSelected(row.id, checked)}
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
  selected,
  onToggleSelected,
  onComplete,
  onDismiss,
}: {
  row: InboxItem;
  pathname: string;
  todayIso: string;
  selected: boolean;
  onToggleSelected: (checked: boolean) => void;
  onComplete: () => void;
  onDismiss: () => void;
}) {
  const overdue =
    row.status === "open" && row.due_date !== null && row.due_date < todayIso;
  const openHref = primaryOpenHref(row, pathname);
  return (
    <li
      className={`rounded border p-3 text-sm ${selected ? "border-info-ring bg-info-soft/40" : "border-rule"}`}
      data-testid="inbox-row"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <label className="mb-1 flex items-center gap-2 text-xs text-ink-subtle">
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => onToggleSelected(e.target.checked)}
              data-testid="inbox-row-checkbox"
            />
            Select
          </label>
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
