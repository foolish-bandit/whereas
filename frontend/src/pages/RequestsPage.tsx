import { useEffect, useState } from "react";

import EmptyState from "../components/EmptyState";
import RequestApprovalStatusSection from "../components/RequestApprovalStatusSection";
import RequestConvertSection, {
  ConvertedContractLink,
} from "../components/RequestConvertSection";
import {
  ApiError,
  MissingDevUserError,
  cancelRequest,
  createRequest,
  listRequests,
  updateRequest,
} from "../lib/api";
import type {
  ContractRequest,
  ConvertRequestToContractResponse,
} from "../types/requests";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; rows: ContractRequest[] }
  | { kind: "error"; message: string };

const PRIORITY_OPTIONS = ["low", "normal", "high", "urgent"] as const;
const REQUEST_TYPE_OPTIONS = [
  "new_contract",
  "review_existing",
  "amendment",
  "renewal",
  "other",
] as const;

export default function RequestsPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeCancelled, setIncludeCancelled] = useState(false);
  // Track which rows have their approval-status section expanded.
  // Lazy-load on toggle so a long list doesn't fire N approval-status
  // requests on first render.
  const [expandedApprovalIds, setExpandedApprovalIds] = useState<Set<string>>(
    () => new Set(),
  );

  const [title, setTitle] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [contractType, setContractType] = useState("");
  const [requestType, setRequestType] = useState("");
  const [priority, setPriority] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    setState({ kind: "loading" });
    listRequests({ include_cancelled: includeCancelled })
      .then((rows) => {
        if (!aborted) setState({ kind: "loaded", rows });
      })
      .catch((err) => {
        if (aborted) return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
        } else {
          setState({ kind: "error", message: "Could not load requests." });
        }
      });
    return () => {
      aborted = true;
    };
  }, [includeCancelled]);

  async function onCreate() {
    if (!title.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const row = await createRequest({
        title: title.trim(),
        description: description.trim() || null,
        contract_type: contractType.trim() || null,
        request_type: requestType || null,
        priority: priority || null,
        counterparty_name: counterparty.trim() || null,
        due_date: dueDate || null,
      });
      setTitle("");
      setCounterparty("");
      setContractType("");
      setRequestType("");
      setPriority("");
      setDueDate("");
      setDescription("");
      setState((prev) =>
        prev.kind === "loaded"
          ? { kind: "loaded", rows: [row, ...prev.rows] }
          : prev,
      );
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Could not create request.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function onMarkInProgress(id: string) {
    try {
      const row = await updateRequest(id, { status: "in_progress" });
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: prev.rows.map((r) => (r.id === id ? row : r)),
            }
          : prev,
      );
    } catch {
      // Best-effort UI; surface via reload if it matters.
    }
  }

  async function onComplete(id: string) {
    try {
      const row = await updateRequest(id, { status: "completed" });
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

  async function onCancel(id: string) {
    try {
      await cancelRequest(id);
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: includeCancelled
                ? prev.rows.map((r) =>
                    r.id === id ? { ...r, status: "cancelled" } : r,
                  )
                : prev.rows.filter((r) => r.id !== id),
            }
          : prev,
      );
    } catch {
      // best-effort
    }
  }

  function onToggleApprovalStatus(id: string) {
    setExpandedApprovalIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function onConverted(response: ConvertRequestToContractResponse) {
    // The backend has already linked + completed the request and
    // resolved the inbox item. Mirror that locally so the row's status
    // chip and convert section update without a refetch.
    setState((prev) =>
      prev.kind === "loaded"
        ? {
            kind: "loaded",
            rows: prev.rows.map((r) =>
              r.id === response.request.id ? response.request : r,
            ),
          }
        : prev,
    );
  }

  return (
    <div className="space-y-5" data-testid="requests-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Requests</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Intake records for contract work. Creating a request adds a
            matching item to the Inbox queue.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-subtle">
          <input
            type="checkbox"
            checked={includeCancelled}
            onChange={(e) => setIncludeCancelled(e.target.checked)}
          />
          Show cancelled
        </label>
      </div>

      <section
        className="grid gap-2 rounded border border-rule p-3"
        data-testid="requests-create"
      >
        <h2 className="text-sm font-medium text-ink">New request</h2>
        <input
          className="rounded border border-rule px-2 py-1 text-sm"
          placeholder="Title (e.g. NDA with Acme Corp)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Counterparty"
            value={counterparty}
            onChange={(e) => setCounterparty(e.target.value)}
          />
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Contract type (NDA, MSA, SOW, ...)"
            value={contractType}
            onChange={(e) => setContractType(e.target.value)}
          />
          <select
            className="rounded border border-rule px-2 py-1 text-sm"
            value={requestType}
            onChange={(e) => setRequestType(e.target.value)}
          >
            <option value="">Request type (optional)</option>
            {REQUEST_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt.replace("_", " ")}
              </option>
            ))}
          </select>
          <select
            className="rounded border border-rule px-2 py-1 text-sm"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="">Priority (optional)</option>
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <input
            type="date"
            className="rounded border border-rule px-2 py-1 text-sm"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
        <textarea
          className="rounded border border-rule px-2 py-1 text-sm"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:opacity-50 sm:w-fit sm:py-1.5"
            onClick={onCreate}
            disabled={creating || !title.trim()}
          >
            {creating ? "Creating…" : "Create request"}
          </button>
          {createError && <span className="text-xs text-danger">{createError}</span>}
        </div>
      </section>

      {state.kind === "loading" && (
        <p className="text-sm text-ink-muted">Loading requests…</p>
      )}
      {state.kind === "error" && (
        <p className="text-sm text-danger">{state.message}</p>
      )}
      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title="No requests yet"
          description="Create a request above. It will land in the Inbox as a request_review item."
        />
      )}
      {state.kind === "loaded" && state.rows.length > 0 && (
        <ul className="space-y-2" data-testid="requests-list">
          {state.rows.map((row) => (
            <li
              key={row.id}
              className="rounded border border-rule p-3 text-sm"
              data-testid="requests-row"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="font-medium text-ink">{row.title}</p>
                  <p className="text-xs text-ink-subtle">
                    {row.contract_type ?? "Untyped"} ·{" "}
                    <span data-testid="request-status">{row.status}</span>
                    {row.priority ? ` · ${row.priority}` : ""}
                    {row.due_date ? ` · due ${row.due_date}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {row.status === "open" && (
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                      onClick={() => onMarkInProgress(row.id)}
                    >
                      Start
                    </button>
                  )}
                  {row.status !== "completed" && row.status !== "cancelled" && (
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                      onClick={() => onComplete(row.id)}
                    >
                      Complete
                    </button>
                  )}
                  {row.status !== "cancelled" && (
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
                      onClick={() => onCancel(row.id)}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
              {row.counterparty_name && (
                <p className="mt-2 text-xs text-ink-subtle">
                  Counterparty: {row.counterparty_name}
                </p>
              )}
              {row.description && (
                <p className="mt-2 text-sm text-ink-muted">{row.description}</p>
              )}

              {row.status !== "cancelled" && row.linked_contract_id && (
                <div
                  className="mt-3 flex flex-wrap items-baseline gap-2 text-xs"
                  data-testid="request-converted-link"
                >
                  <span className="text-ink-subtle">Linked contract:</span>
                  <ConvertedContractLink
                    contractId={row.linked_contract_id}
                  />
                </div>
              )}

              {row.status !== "cancelled" &&
                !row.linked_contract_id &&
                row.linked_template_id && (
                  <RequestConvertSection
                    request={row}
                    onConverted={onConverted}
                  />
                )}

              {row.status !== "cancelled" &&
                !row.linked_contract_id &&
                !row.linked_template_id && (
                  <p
                    className="mt-3 text-xs text-ink-subtle"
                    data-testid="request-no-template-hint"
                  >
                    Link an agreement template to this request to generate a
                    draft contract from it.
                  </p>
                )}

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                  onClick={() => onToggleApprovalStatus(row.id)}
                  data-testid="request-approval-toggle"
                  aria-expanded={expandedApprovalIds.has(row.id)}
                >
                  {expandedApprovalIds.has(row.id)
                    ? "Hide approval status"
                    : "View approval status"}
                </button>
              </div>
              {expandedApprovalIds.has(row.id) && (
                <RequestApprovalStatusSection requestId={row.id} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
