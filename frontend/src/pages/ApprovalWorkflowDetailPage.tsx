import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import ActivityTimeline from "../components/ActivityTimeline";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import {
  ApiError,
  MissingDevUserError,
  approveApprovalStep,
  cancelApprovalWorkflow,
  getApprovalWorkflow,
  rejectApprovalStep,
} from "../lib/api";
import { formatDate } from "../lib/format";
import { mountedPath } from "../lib/routes";
import type {
  ApprovalStep,
  ApprovalWorkflowRun,
  ApprovalWorkflowRunStatus,
} from "../types/approvalWorkflows";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; workflow: ApprovalWorkflowRun }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

/**
 * Approval Workflow detail page (PR #98).
 *
 * Anchors on a single ``ApprovalWorkflowRun`` and renders, in order:
 *
 *   - Breadcrumb + header (name, status pill, source label).
 *   - Related-record card (mount-aware links to the Request / Repository
 *     record this workflow is attached to).
 *   - Progress summary ("Step N of M", current-step due / overdue).
 *   - Ordered steps timeline (one row per step, current step
 *     highlighted, approver-name only — no decision-note text by
 *     default per PR #98 brief).
 *   - Action area (Approve / Reject for the current pending step;
 *     Cancel workflow while ``status=active``). Reuses the existing
 *     approve / reject / cancel API client so the state machine is
 *     unchanged.
 *   - Activity timeline reused from PR #58 / PR #62, anchored on the
 *     related Request if present, else the linked Repository record.
 *
 * No new mutation surface. Decision notes show presence-only here —
 * the existing inline view on the list page renders the full note
 * because it predates PR #98, and we don't change its behavior.
 */
export default function ApprovalWorkflowDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const location = useLocation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingStepId, setPendingStepId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const workflow = await getApprovalWorkflow(id);
      // Defensive: a regressed backend returning a non-workflow
      // shape (e.g. an empty array) should not crash the renderer.
      if (
        !workflow ||
        typeof workflow !== "object" ||
        !Array.isArray((workflow as { steps?: unknown }).steps)
      ) {
        setState({ kind: "not_found" });
        return;
      }
      setState({ kind: "loaded", workflow });
    } catch (err) {
      if (err instanceof MissingDevUserError) {
        setState({ kind: "error", message: err.message });
        return;
      }
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setState({ kind: "not_found" });
          return;
        }
        setState({ kind: "error", message: err.message });
        return;
      }
      setState({ kind: "error", message: "Could not load this workflow." });
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const listPath = mountedPath("/approvals/workflows", location.pathname);

  async function onApproveStep(stepId: string) {
    setPendingStepId(stepId);
    setActionError(null);
    try {
      await approveApprovalStep(id, stepId);
      await load();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not approve step.",
      );
    } finally {
      setPendingStepId(null);
    }
  }

  async function onRejectStep(stepId: string) {
    setPendingStepId(stepId);
    setActionError(null);
    try {
      await rejectApprovalStep(id, stepId);
      await load();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not reject step.",
      );
    } finally {
      setPendingStepId(null);
    }
  }

  async function onConfirmCancel() {
    setCancelling(true);
    setActionError(null);
    try {
      await cancelApprovalWorkflow(id);
      setConfirmingCancel(false);
      await load();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not cancel workflow.",
      );
    } finally {
      setCancelling(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <div
        className="space-y-4"
        data-testid="approval-workflow-detail-loading"
      >
        <Link to={listPath} className="text-xs text-ink-muted hover:text-ink">
          ← Approval workflows
        </Link>
        <LoadingSkeleton rows={5} />
      </div>
    );
  }

  if (state.kind === "not_found") {
    return (
      <div className="space-y-4" data-testid="approval-workflow-detail">
        <Link to={listPath} className="text-xs text-ink-muted hover:text-ink">
          ← Approval workflows
        </Link>
        <EmptyState
          title="Workflow not found"
          description="This approval workflow may have been removed, or the id is wrong. Try the workflows list."
          action={
            <Link
              to={listPath}
              className="inline-flex items-center rounded border border-rule bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:border-rule-strong"
              data-testid="approval-workflow-detail-not-found-back"
            >
              Back to workflows
            </Link>
          }
        />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-4" data-testid="approval-workflow-detail">
        <Link to={listPath} className="text-xs text-ink-muted hover:text-ink">
          ← Approval workflows
        </Link>
        <ErrorState
          title="Could not load this workflow"
          description={state.message}
        />
      </div>
    );
  }

  return (
    <WorkflowDetailContent
      workflow={state.workflow}
      pathname={location.pathname}
      listPath={listPath}
      actionError={actionError}
      pendingStepId={pendingStepId}
      cancelling={cancelling}
      confirmingCancel={confirmingCancel}
      onApprove={onApproveStep}
      onReject={onRejectStep}
      onAskCancel={() => setConfirmingCancel(true)}
      onCancelCancel={() => setConfirmingCancel(false)}
      onConfirmCancel={onConfirmCancel}
    />
  );
}

function WorkflowDetailContent({
  workflow,
  pathname,
  listPath,
  actionError,
  pendingStepId,
  cancelling,
  confirmingCancel,
  onApprove,
  onReject,
  onAskCancel,
  onCancelCancel,
  onConfirmCancel,
}: {
  workflow: ApprovalWorkflowRun;
  pathname: string;
  listPath: string;
  actionError: string | null;
  pendingStepId: string | null;
  cancelling: boolean;
  confirmingCancel: boolean;
  onApprove: (stepId: string) => void;
  onReject: (stepId: string) => void;
  onAskCancel: () => void;
  onCancelCancel: () => void;
  onConfirmCancel: () => void;
}) {
  const totalSteps = workflow.steps.length;
  const currentStep =
    workflow.status === "active" && workflow.current_step_order !== null
      ? workflow.steps.find(
          (s) =>
            s.step_order === workflow.current_step_order &&
            s.status === "pending",
        )
      : null;
  const sourceLabel = useMemo(() => deriveSourceLabel(workflow), [workflow]);
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const overdueCurrent =
    currentStep?.due_date !== null &&
    currentStep?.due_date !== undefined &&
    currentStep.due_date < todayIso;

  return (
    <div className="space-y-5" data-testid="approval-workflow-detail">
      <nav className="text-xs text-ink-subtle" aria-label="Breadcrumb">
        <Link
          to={mountedPath("/approvals", pathname)}
          className="hover:text-ink"
          data-testid="approval-workflow-breadcrumb-approvals"
        >
          Approvals
        </Link>
        <span className="mx-1">/</span>
        <Link
          to={listPath}
          className="hover:text-ink"
          data-testid="approval-workflow-breadcrumb-workflows"
        >
          Workflows
        </Link>
        <span className="mx-1">/</span>
        <span className="text-ink-muted">{workflow.name}</span>
      </nav>

      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-lg font-semibold text-ink">{workflow.name}</h1>
          <WorkflowStatusPill status={workflow.status} />
          {sourceLabel && (
            <span
              className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle"
              data-testid="approval-workflow-source-label"
            >
              {sourceLabel}
            </span>
          )}
        </div>
        <p className="text-[11px] text-ink-subtle">
          Started {formatDate(workflow.started_at)}
          {workflow.completed_at
            ? ` · finished ${formatDate(workflow.completed_at)}`
            : ""}
        </p>
      </header>

      <RelatedRecordCard
        workflow={workflow}
        pathname={pathname}
      />

      <ProgressSummary
        workflow={workflow}
        totalSteps={totalSteps}
        currentStep={currentStep ?? null}
        overdueCurrent={overdueCurrent}
      />

      <StepsTimeline
        steps={workflow.steps}
        currentStepOrder={workflow.current_step_order}
        workflowStatus={workflow.status}
        pendingStepId={pendingStepId}
        onApprove={onApprove}
        onReject={onReject}
      />

      {actionError && (
        <p
          className="text-xs text-danger"
          data-testid="approval-workflow-action-error"
        >
          {actionError}
        </p>
      )}

      <ActionArea
        workflow={workflow}
        confirmingCancel={confirmingCancel}
        cancelling={cancelling}
        onAskCancel={onAskCancel}
        onCancelCancel={onCancelCancel}
        onConfirmCancel={onConfirmCancel}
      />

      <ActivityArea workflow={workflow} pathname={pathname} />
    </div>
  );
}

function RelatedRecordCard({
  workflow,
  pathname,
}: {
  workflow: ApprovalWorkflowRun;
  pathname: string;
}) {
  if (!workflow.request_id && !workflow.contract_id) {
    return (
      <section
        className="rounded border border-rule p-3 text-xs text-ink-subtle"
        data-testid="approval-workflow-related"
      >
        Not attached to a Request or Repository record. Manually
        created workflows can still be approved, rejected, or
        cancelled here.
      </section>
    );
  }
  return (
    <section
      className="rounded border border-rule p-3 text-xs"
      data-testid="approval-workflow-related"
    >
      <h2 className="text-xs font-medium text-ink">Attached to</h2>
      <ul className="mt-1 flex flex-wrap gap-3 text-ink-muted">
        {workflow.request_id && (
          <li>
            <Link
              to={mountedPath(`/requests/${workflow.request_id}`, pathname)}
              className="underline hover:text-ink"
              data-testid="approval-workflow-related-request-link"
            >
              Open related Request
            </Link>
          </li>
        )}
        {workflow.contract_id && (
          <li>
            <Link
              to={mountedPath(
                `/repository/${workflow.contract_id}`,
                pathname,
              )}
              className="underline hover:text-ink"
              data-testid="approval-workflow-related-contract-link"
            >
              Open Repository record
            </Link>
          </li>
        )}
      </ul>
    </section>
  );
}

function ProgressSummary({
  workflow,
  totalSteps,
  currentStep,
  overdueCurrent,
}: {
  workflow: ApprovalWorkflowRun;
  totalSteps: number;
  currentStep: ApprovalStep | null;
  overdueCurrent: boolean;
}) {
  const completed = workflow.steps.filter(
    (s) => s.status === "approved",
  ).length;
  const rejected = workflow.steps.filter(
    (s) => s.status === "rejected",
  ).length;
  return (
    <section
      className="rounded border border-rule p-3"
      data-testid="approval-workflow-progress"
    >
      <h2 className="text-xs font-medium text-ink">Progress</h2>
      <p
        className="mt-1 text-xs text-ink-subtle"
        data-testid="approval-workflow-progress-line"
      >
        {workflow.status === "active" && workflow.current_step_order !== null
          ? `Step ${workflow.current_step_order} of ${totalSteps}`
          : `${completed} of ${totalSteps} step${totalSteps === 1 ? "" : "s"} approved`}
        {rejected > 0 ? ` · ${rejected} rejected` : ""}
      </p>
      {currentStep && (
        <p
          className="mt-1 text-xs text-ink-subtle"
          data-testid="approval-workflow-progress-current"
        >
          Current: <span className="text-ink">{currentStep.title}</span>
          {currentStep.due_date ? ` · due ${currentStep.due_date}` : ""}
          {overdueCurrent && (
            <span
              className="ml-2 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-danger"
              data-testid="approval-workflow-progress-overdue"
            >
              overdue
            </span>
          )}
        </p>
      )}
    </section>
  );
}

function StepsTimeline({
  steps,
  currentStepOrder,
  workflowStatus,
  pendingStepId,
  onApprove,
  onReject,
}: {
  steps: ApprovalStep[];
  currentStepOrder: number | null;
  workflowStatus: string;
  pendingStepId: string | null;
  onApprove: (stepId: string) => void;
  onReject: (stepId: string) => void;
}) {
  const sorted = useMemo(
    () => [...steps].sort((a, b) => a.step_order - b.step_order),
    [steps],
  );
  return (
    <section
      className="rounded border border-rule p-3"
      data-testid="approval-workflow-steps"
    >
      <h2 className="text-xs font-medium text-ink">Steps</h2>
      <ol className="mt-2 space-y-2" data-testid="approval-workflow-steps-list">
        {sorted.map((step) => {
          const isCurrent =
            workflowStatus === "active" &&
            currentStepOrder === step.step_order &&
            step.status === "pending";
          return (
            <li
              key={step.id}
              className={`rounded border p-2 text-xs ${
                isCurrent
                  ? "border-info-ring bg-info-soft"
                  : "border-rule bg-canvas"
              }`}
              data-testid="approval-workflow-step"
              data-step-order={step.step_order}
              data-current={isCurrent ? "true" : "false"}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-ink">
                    {step.step_order}. {step.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-subtle">
                    <StepStatusChip status={step.status} />
                    {step.approver_name && (
                      <span className="ml-2">{step.approver_name}</span>
                    )}
                    {step.approver_email && (
                      <span className="ml-2">{step.approver_email}</span>
                    )}
                    {step.due_date ? ` · due ${step.due_date}` : ""}
                    {step.decided_at
                      ? ` · decided ${formatDate(step.decided_at)}`
                      : ""}
                    {step.decision_note && (
                      <span
                        className="ml-2 rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-[10px] text-ink-muted"
                        data-testid="approval-workflow-step-note-indicator"
                        title="A decision note was recorded on this step"
                      >
                        decision note recorded
                      </span>
                    )}
                  </p>
                </div>
                {isCurrent && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded border border-ink bg-ink px-2 py-1 text-canvas disabled:opacity-50"
                      onClick={() => onApprove(step.id)}
                      disabled={pendingStepId === step.id}
                      data-testid="approval-workflow-step-approve"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted disabled:opacity-50"
                      onClick={() => onReject(step.id)}
                      disabled={pendingStepId === step.id}
                      data-testid="approval-workflow-step-reject"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ActionArea({
  workflow,
  confirmingCancel,
  cancelling,
  onAskCancel,
  onCancelCancel,
  onConfirmCancel,
}: {
  workflow: ApprovalWorkflowRun;
  confirmingCancel: boolean;
  cancelling: boolean;
  onAskCancel: () => void;
  onCancelCancel: () => void;
  onConfirmCancel: () => void;
}) {
  if (workflow.status !== "active") {
    return (
      <section
        className="rounded border border-rule p-3 text-xs text-ink-subtle"
        data-testid="approval-workflow-action-area"
      >
        Workflow is {workflow.status}. No further action is available
        from this page.
      </section>
    );
  }
  return (
    <section
      className="rounded border border-rule p-3"
      data-testid="approval-workflow-action-area"
    >
      <h2 className="text-xs font-medium text-ink">Workflow actions</h2>
      <p className="mt-1 text-xs text-ink-subtle">
        Approve / reject the current pending step above, or cancel
        the whole workflow. Cancelling a workflow dismisses its open
        approval inbox items and skips remaining pending steps.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {confirmingCancel ? (
          <>
            <button
              type="button"
              className="rounded border border-danger bg-danger px-2 py-1 text-canvas disabled:opacity-50"
              onClick={onConfirmCancel}
              disabled={cancelling}
              data-testid="approval-workflow-confirm-cancel"
            >
              {cancelling ? "Cancelling…" : "Confirm cancel"}
            </button>
            <button
              type="button"
              className="rounded border border-rule px-2 py-1 text-ink hover:bg-canvas-muted disabled:opacity-50"
              onClick={onCancelCancel}
              disabled={cancelling}
              data-testid="approval-workflow-cancel-cancel"
            >
              Keep workflow
            </button>
          </>
        ) : (
          <button
            type="button"
            className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
            onClick={onAskCancel}
            data-testid="approval-workflow-cancel"
          >
            Cancel workflow
          </button>
        )}
      </div>
    </section>
  );
}

function ActivityArea({
  workflow,
  pathname,
}: {
  workflow: ApprovalWorkflowRun;
  pathname: string;
}) {
  // The activity timeline endpoints are anchored on the Request or
  // the Repository record, not the workflow itself. Reuse them
  // here when one is attached so the user sees the approval events
  // (workflow.created / step.activated / step.approved / …) in the
  // same projection as everywhere else in the app.
  if (workflow.request_id) {
    return (
      <section
        className="rounded border border-rule p-3"
        data-testid="approval-workflow-activity"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xs font-medium text-ink">Related activity</h2>
          <Link
            to={mountedPath(`/requests/${workflow.request_id}`, pathname)}
            className="text-[11px] text-ink-muted underline hover:text-ink"
          >
            Open the Request for the full timeline
          </Link>
        </div>
        <div className="mt-2">
          <ActivityTimeline
            kind="request"
            requestId={workflow.request_id}
          />
        </div>
      </section>
    );
  }
  if (workflow.contract_id) {
    return (
      <section
        className="rounded border border-rule p-3"
        data-testid="approval-workflow-activity"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xs font-medium text-ink">Related activity</h2>
          <Link
            to={mountedPath(
              `/repository/${workflow.contract_id}`,
              pathname,
            )}
            className="text-[11px] text-ink-muted underline hover:text-ink"
          >
            Open the Repository record for the full timeline
          </Link>
        </div>
        <div className="mt-2">
          <ActivityTimeline
            kind="contract"
            contractId={workflow.contract_id}
          />
        </div>
      </section>
    );
  }
  return null;
}

const STATUS_PILL: Record<ApprovalWorkflowRunStatus, string> = {
  active: "bg-info/10 text-info border-info/40",
  completed: "bg-success/10 text-success border-success/40",
  rejected: "bg-danger/10 text-danger border-danger/40",
  cancelled: "bg-canvas-muted text-ink-muted border-rule",
};

function WorkflowStatusPill({ status }: { status: string }) {
  const cls =
    (status as ApprovalWorkflowRunStatus) in STATUS_PILL
      ? STATUS_PILL[status as ApprovalWorkflowRunStatus]
      : "bg-canvas-muted text-ink-muted border-rule";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
      data-testid="approval-workflow-status-pill"
    >
      {status}
    </span>
  );
}

const STEP_STATUS_PILL: Record<string, string> = {
  pending: "bg-info/10 text-info border-info/40",
  approved: "bg-success/10 text-success border-success/40",
  rejected: "bg-danger/10 text-danger border-danger/40",
  skipped: "bg-canvas-muted text-ink-muted border-rule",
};

function StepStatusChip({ status }: { status: string }) {
  const cls =
    STEP_STATUS_PILL[status] ?? "bg-canvas-muted text-ink-muted border-rule";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
      data-testid="approval-workflow-step-status"
    >
      {status}
    </span>
  );
}

function deriveSourceLabel(workflow: ApprovalWorkflowRun): string | null {
  const meta = (workflow.metadata_json ?? {}) as Record<string, unknown>;
  const policyName =
    typeof meta.source_approval_policy_name === "string"
      ? meta.source_approval_policy_name
      : null;
  if (policyName) return `From policy: ${policyName}`;
  if (workflow.template_id) return "From template";
  return null;
}
