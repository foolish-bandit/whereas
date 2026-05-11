import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import {
  ApiError,
  MissingDevUserError,
  approveApprovalStep,
  cancelApprovalWorkflow,
  createApprovalWorkflow,
  getApprovalWorkflow,
  listApprovalWorkflows,
  rejectApprovalStep,
} from "../lib/api";
import {
  DEEP_LINK_HIGHLIGHT_CLASS,
  scrollDeepLinkIntoView,
} from "../lib/deepLinkHighlight";
import { mountedPath } from "../lib/routes";
import type {
  ApprovalStepCreate,
  ApprovalWorkflowRun,
  ApprovalWorkflowRunListItem,
  ApprovalWorkflowRunStatus,
} from "../types/approvalWorkflows";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; rows: ApprovalWorkflowRunListItem[] }
  | { kind: "error"; message: string };

interface DraftStep {
  title: string;
  approver_name: string;
  approver_email: string;
  due_date: string;
}

function emptyStep(): DraftStep {
  return { title: "", approver_name: "", approver_email: "", due_date: "" };
}

export default function ApprovalWorkflowsPage() {
  const location = useLocation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeTerminal, setIncludeTerminal] = useState(true);

  const [name, setName] = useState("");
  // Foundation PR: ID entry only. UX dropdowns for picking an existing
  // request / contract / template are tracked as a follow-up.
  const [requestId, setRequestId] = useState("");
  const [contractId, setContractId] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep()]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailById, setDetailById] = useState<
    Record<string, ApprovalWorkflowRun>
  >({});
  const [detailError, setDetailError] = useState<string | null>(null);

  // PR #61: ?workflow_id=<id> is the gate-remediation deep-link
  // target. We auto-expand the matching row on first load and scroll
  // it into view; if the id isn't in the current list we surface a
  // notice instead of silently doing nothing.
  const [searchParams] = useSearchParams();
  const deepLinkWorkflowId = searchParams.get("workflow_id");
  const deepLinkRowRef = useRef<HTMLLIElement | null>(null);
  // Guard so we only auto-expand once per deep-link arrival; if the
  // user later collapses the row by hand we don't keep re-opening it.
  const autoExpandedRef = useRef<string | null>(null);

  useEffect(() => {
    let aborted = false;
    setState({ kind: "loading" });
    listApprovalWorkflows({ include_terminal: includeTerminal })
      .then((rows) => {
        if (!aborted) setState({ kind: "loaded", rows });
      })
      .catch((err) => {
        if (aborted) return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
        } else {
          setState({
            kind: "error",
            message: "Could not load approval workflows.",
          });
        }
      });
    return () => {
      aborted = true;
    };
  }, [includeTerminal]);

  const canCreate = useMemo(() => {
    if (!name.trim()) return false;
    if (!requestId.trim() && !contractId.trim()) return false;
    return steps.some((s) => s.title.trim().length > 0);
  }, [name, requestId, contractId, steps]);

  async function loadDetail(id: string): Promise<ApprovalWorkflowRun | null> {
    try {
      const detail = await getApprovalWorkflow(id);
      setDetailById((prev) => ({ ...prev, [id]: detail }));
      setDetailError(null);
      return detail;
    } catch (err) {
      setDetailError(
        err instanceof Error ? err.message : "Could not load workflow detail.",
      );
      return null;
    }
  }

  async function onToggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!detailById[id]) {
      await loadDetail(id);
    }
  }

  const deepLinkRowFound =
    deepLinkWorkflowId !== null &&
    state.kind === "loaded" &&
    state.rows.some((r) => r.id === deepLinkWorkflowId);

  useEffect(() => {
    if (!deepLinkWorkflowId) return;
    if (!deepLinkRowFound) return;
    if (autoExpandedRef.current === deepLinkWorkflowId) return;
    autoExpandedRef.current = deepLinkWorkflowId;
    setExpandedId(deepLinkWorkflowId);
    if (!detailById[deepLinkWorkflowId]) {
      loadDetail(deepLinkWorkflowId);
    }
    // Scroll on the next paint, after the row + detail mount.
    requestAnimationFrame(() =>
      scrollDeepLinkIntoView(deepLinkRowRef.current),
    );
    // detailById / loadDetail are stable enough for our intent here:
    // we just want to fire the expand once per deep-link arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkWorkflowId, deepLinkRowFound]);

  function onAddStep() {
    setSteps((prev) => [...prev, emptyStep()]);
  }

  function onRemoveStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  function onUpdateStep(
    index: number,
    field: keyof DraftStep,
    value: string,
  ) {
    setSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...step, [field]: value } : step)),
    );
  }

  async function onCreate() {
    if (!canCreate) return;
    setCreating(true);
    setCreateError(null);
    const payloadSteps: ApprovalStepCreate[] = steps
      .filter((s) => s.title.trim().length > 0)
      .map((s) => ({
        title: s.title.trim(),
        approver_name: s.approver_name.trim() || null,
        approver_email: s.approver_email.trim() || null,
        due_date: s.due_date || null,
      }));
    try {
      const run = await createApprovalWorkflow({
        name: name.trim(),
        request_id: requestId.trim() || null,
        contract_id: contractId.trim() || null,
        steps: payloadSteps,
      });
      setName("");
      setRequestId("");
      setContractId("");
      setSteps([emptyStep()]);
      setDetailById((prev) => ({ ...prev, [run.id]: run }));
      setExpandedId(run.id);
      setState((prev) =>
        prev.kind === "loaded"
          ? { kind: "loaded", rows: [_toListItem(run), ...prev.rows] }
          : prev,
      );
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Could not create workflow.",
      );
    } finally {
      setCreating(false);
    }
  }

  function _toListItem(run: ApprovalWorkflowRun): ApprovalWorkflowRunListItem {
    return {
      id: run.id,
      organization_id: run.organization_id,
      name: run.name,
      status: run.status,
      request_id: run.request_id,
      contract_id: run.contract_id,
      template_id: run.template_id,
      current_step_order: run.current_step_order,
      started_at: run.started_at,
      completed_at: run.completed_at,
      created_at: run.created_at,
      updated_at: run.updated_at,
    };
  }

  function _replaceListRow(run: ApprovalWorkflowRun) {
    setDetailById((prev) => ({ ...prev, [run.id]: run }));
    setState((prev) =>
      prev.kind === "loaded"
        ? {
            kind: "loaded",
            rows: prev.rows.map((r) => (r.id === run.id ? _toListItem(run) : r)),
          }
        : prev,
    );
  }

  async function onApproveStep(workflowId: string, stepId: string) {
    try {
      const run = await approveApprovalStep(workflowId, stepId);
      _replaceListRow(run);
    } catch (err) {
      setDetailError(
        err instanceof Error ? err.message : "Could not approve step.",
      );
    }
  }

  async function onRejectStep(workflowId: string, stepId: string) {
    try {
      const run = await rejectApprovalStep(workflowId, stepId);
      _replaceListRow(run);
    } catch (err) {
      setDetailError(
        err instanceof Error ? err.message : "Could not reject step.",
      );
    }
  }

  async function onCancelWorkflow(workflowId: string) {
    try {
      const run = await cancelApprovalWorkflow(workflowId);
      _replaceListRow(run);
    } catch (err) {
      setDetailError(
        err instanceof Error ? err.message : "Could not cancel workflow.",
      );
    }
  }

  return (
    <div className="space-y-5" data-testid="approvals-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Approvals</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Sequential approval workflows for requests and contracts. Each
            pending step lands in the assigned reviewer's Inbox as an
            approval item.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-subtle">
          <input
            type="checkbox"
            checked={includeTerminal}
            onChange={(e) => setIncludeTerminal(e.target.checked)}
          />
          Show completed / rejected / cancelled
        </label>
      </div>

      <section
        className="grid gap-2 rounded border border-rule p-3"
        data-testid="approvals-create"
      >
        <h2 className="text-sm font-medium text-ink">New approval workflow</h2>
        <input
          className="rounded border border-rule px-2 py-1 text-sm"
          placeholder="Workflow name (e.g. Legal approval)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="text-xs text-ink-subtle">
          Attach to a request or a contract by ID. (UX for picking from
          dropdowns is a follow-up.)
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Request ID (optional)"
            value={requestId}
            onChange={(e) => setRequestId(e.target.value)}
          />
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Contract ID (optional)"
            value={contractId}
            onChange={(e) => setContractId(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-ink">Steps</p>
          {steps.map((step, index) => (
            <div
              key={index}
              className="grid gap-2 rounded border border-rule p-2 sm:grid-cols-4"
              data-testid="approvals-step-row"
            >
              <input
                className="rounded border border-rule px-2 py-1 text-sm sm:col-span-2"
                placeholder={`Step ${index + 1} title`}
                value={step.title}
                onChange={(e) => onUpdateStep(index, "title", e.target.value)}
              />
              <input
                className="rounded border border-rule px-2 py-1 text-sm"
                placeholder="Approver email"
                value={step.approver_email}
                onChange={(e) =>
                  onUpdateStep(index, "approver_email", e.target.value)
                }
              />
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  className="flex-1 rounded border border-rule px-2 py-1 text-sm"
                  value={step.due_date}
                  onChange={(e) =>
                    onUpdateStep(index, "due_date", e.target.value)
                  }
                />
                {steps.length > 1 && (
                  <button
                    type="button"
                    className="rounded border border-rule px-2 py-1 text-xs hover:bg-canvas-muted"
                    onClick={() => onRemoveStep(index)}
                    aria-label={`Remove step ${index + 1}`}
                  >
                    -
                  </button>
                )}
              </div>
              <input
                className="rounded border border-rule px-2 py-1 text-sm sm:col-span-4"
                placeholder="Approver name (optional)"
                value={step.approver_name}
                onChange={(e) =>
                  onUpdateStep(index, "approver_name", e.target.value)
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="rounded border border-rule px-3 py-1 text-xs hover:bg-canvas-muted"
            onClick={onAddStep}
            data-testid="approvals-add-step"
          >
            + Add step
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:opacity-50 sm:w-fit sm:py-1.5"
            onClick={onCreate}
            disabled={creating || !canCreate}
            data-testid="approvals-create-submit"
          >
            {creating ? "Creating…" : "Create workflow"}
          </button>
          {createError && (
            <span
              className="text-xs text-danger"
              data-testid="approvals-create-error"
            >
              {createError}
            </span>
          )}
        </div>
      </section>

      {state.kind === "loading" && (
        <p className="text-sm text-ink-muted">Loading approval workflows…</p>
      )}
      {state.kind === "error" && (
        <p className="text-sm text-danger" data-testid="approvals-error">
          {state.message}
        </p>
      )}
      {state.kind === "loaded" && deepLinkWorkflowId && !deepLinkRowFound && (
        <p
          className="rounded border border-warning bg-warning/10 px-3 py-2 text-xs text-ink"
          data-testid="approvals-deep-link-not-found"
        >
          The linked approval workflow <code>{deepLinkWorkflowId}</code> was
          not found in the current view. Toggle “Show completed / rejected /
          cancelled” if it may have terminated, or check the workflow id.
        </p>
      )}
      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title="No approval workflows yet"
          description="Create a workflow above. The first pending step will appear in the assigned reviewer's Inbox."
        />
      )}
      {state.kind === "loaded" && state.rows.length > 0 && (
        <ul className="space-y-2" data-testid="approvals-list">
          {state.rows.map((row) => {
            const isDeepLinkTarget = row.id === deepLinkWorkflowId;
            return (
            <li
              key={row.id}
              ref={isDeepLinkTarget ? deepLinkRowRef : undefined}
              className={`rounded border p-3 text-sm ${
                isDeepLinkTarget
                  ? DEEP_LINK_HIGHLIGHT_CLASS
                  : "border-rule"
              }`}
              data-testid="approvals-row"
              data-deep-link-target={isDeepLinkTarget ? "true" : undefined}
              aria-label={
                isDeepLinkTarget
                  ? "Linked approval workflow from approval gate"
                  : undefined
              }
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <p className="font-medium text-ink">{row.name}</p>
                    <WorkflowStatusPill status={row.status} />
                    <WorkflowSourceLabel
                      templateId={row.template_id}
                      detail={detailById[row.id] ?? null}
                    />
                  </div>
                  <WorkflowProgressLine
                    row={row}
                    detail={detailById[row.id] ?? null}
                  />
                  <div className="flex flex-wrap gap-3 text-xs">
                    {row.request_id && (
                      <Link
                        to={mountedPath(
                          `/requests/${row.request_id}`,
                          location.pathname,
                        )}
                        className="text-ink-muted underline hover:text-ink"
                        data-testid="approval-row-request-link"
                      >
                        Open related request
                      </Link>
                    )}
                    {row.contract_id && (
                      <Link
                        to={mountedPath(
                          `/repository/${row.contract_id}`,
                          location.pathname,
                        )}
                        className="text-ink-muted underline hover:text-ink"
                        data-testid="approval-row-contract-link"
                      >
                        Open repository record
                      </Link>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <button
                    type="button"
                    className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                    onClick={() => onToggleExpand(row.id)}
                    data-testid="approvals-toggle-detail"
                  >
                    {expandedId === row.id ? "Hide steps" : "Show steps"}
                  </button>
                  {row.status === "active" && (
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
                      onClick={() => onCancelWorkflow(row.id)}
                      data-testid="approvals-cancel"
                    >
                      Cancel workflow
                    </button>
                  )}
                </div>
              </div>

              {expandedId === row.id && (
                <WorkflowDetail
                  detail={detailById[row.id] ?? null}
                  detailError={detailError}
                  onApprove={(stepId) => onApproveStep(row.id, stepId)}
                  onReject={(stepId) => onRejectStep(row.id, stepId)}
                />
              )}
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const STATUS_PILL_STYLE: Record<ApprovalWorkflowRunStatus, string> = {
  active: "bg-info/10 text-info border-info/40",
  completed: "bg-success/10 text-success border-success/40",
  rejected: "bg-danger/10 text-danger border-danger/40",
  cancelled: "bg-canvas-muted text-ink-muted border-rule",
};

function WorkflowStatusPill({ status }: { status: string }) {
  const key = (status as ApprovalWorkflowRunStatus) in STATUS_PILL_STYLE
    ? (status as ApprovalWorkflowRunStatus)
    : null;
  const className = key
    ? STATUS_PILL_STYLE[key]
    : "bg-canvas-muted text-ink-muted border-rule";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${className}`}
      data-testid="approval-status-pill"
    >
      <span data-testid="approval-status">{status}</span>
    </span>
  );
}

function WorkflowSourceLabel({
  templateId,
  detail,
}: {
  templateId: string | null;
  detail: ApprovalWorkflowRun | null;
}) {
  // We use only safely allowlisted hints — `template_id` on the list
  // item or `metadata_json.source_approval_policy_name` on the loaded
  // detail (PR #58 audit allowlist). No raw IDs or PII surfaced.
  const policyName =
    detail &&
    typeof detail.metadata_json === "object" &&
    detail.metadata_json !== null &&
    typeof (detail.metadata_json as { source_approval_policy_name?: unknown })
      .source_approval_policy_name === "string"
      ? ((detail.metadata_json as { source_approval_policy_name?: string })
          .source_approval_policy_name ?? "")
      : "";
  let label: string | null = null;
  if (policyName) {
    label = `From policy: ${policyName}`;
  } else if (templateId) {
    label = "From template";
  }
  if (!label) return null;
  return (
    <span
      className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle"
      data-testid="approval-row-source"
    >
      {label}
    </span>
  );
}

function WorkflowProgressLine({
  row,
  detail,
}: {
  row: ApprovalWorkflowRunListItem;
  detail: ApprovalWorkflowRun | null;
}) {
  // Total step count needs the loaded detail; for collapsed rows we
  // fall back to "step N" without a denominator.
  const totalSteps = detail?.steps?.length ?? null;
  const current = row.current_step_order ?? null;
  if (current === null && row.status === "active") {
    return null;
  }
  if (row.status !== "active") {
    return null;
  }
  return (
    <p className="text-xs text-ink-subtle" data-testid="approval-row-progress">
      {totalSteps !== null
        ? `Step ${current} of ${totalSteps}`
        : `Step ${current}`}
    </p>
  );
}

function WorkflowDetail({
  detail,
  detailError,
  onApprove,
  onReject,
}: {
  detail: ApprovalWorkflowRun | null;
  detailError: string | null;
  onApprove: (stepId: string) => void;
  onReject: (stepId: string) => void;
}) {
  if (detailError) {
    return (
      <p className="mt-3 text-xs text-danger" data-testid="approvals-detail-error">
        {detailError}
      </p>
    );
  }
  if (!detail) {
    return <p className="mt-3 text-xs text-ink-subtle">Loading steps…</p>;
  }
  return (
    <ol
      className="mt-3 space-y-2 border-t border-rule pt-3"
      data-testid="approvals-step-list"
    >
      {detail.steps.map((step) => {
        const isCurrent =
          detail.status === "active" &&
          detail.current_step_order === step.step_order &&
          step.status === "pending";
        return (
          <li
            key={step.id}
            className="rounded border border-rule p-2 text-xs"
            data-testid="approvals-step-detail"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="font-medium text-ink">
                  {step.step_order}. {step.title}
                </p>
                <p className="text-ink-subtle">
                  Status:{" "}
                  <span data-testid="approval-step-status">{step.status}</span>
                  {step.approver_email ? ` · ${step.approver_email}` : ""}
                  {step.due_date ? ` · due ${step.due_date}` : ""}
                </p>
              </div>
              {isCurrent && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded border border-ink bg-ink px-2 py-1 text-canvas"
                    onClick={() => onApprove(step.id)}
                    data-testid="approvals-approve"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
                    onClick={() => onReject(step.id)}
                    data-testid="approvals-reject"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
            {step.decision_note && (
              <p className="mt-1 text-ink-muted">Note: {step.decision_note}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
