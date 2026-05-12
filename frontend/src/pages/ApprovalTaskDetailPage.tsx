import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import {
  ApiError,
  MissingDevUserError,
  approveApprovalStep,
  dismissInboxItem,
  getApprovalWorkflow,
  getInboxItem,
  rejectApprovalStep,
  updateInboxItem,
} from "../lib/api";
import { formatDate } from "../lib/format";
import { mountedPath } from "../lib/routes";
import type { InboxItem } from "../types/inboxItems";
import type {
  ApprovalStep,
  ApprovalWorkflowRun,
} from "../types/approvalWorkflows";

type LoadState =
  | { kind: "loading" }
  | {
      kind: "loaded";
      task: InboxItem;
      workflow: ApprovalWorkflowRun | null;
    }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

type ActionState =
  | { kind: "idle" }
  | { kind: "pending"; verb: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/**
 * Approval Task detail / action page (PR #99).
 *
 * Anchors on a single inbox item (`/approvals/tasks/:id`) so an
 * approver can see exactly what they're being asked to approve, the
 * related Request / Repository / Workflow records, and act on the
 * underlying approval step without hopping through the workflow list.
 *
 * Reuses existing APIs only:
 *   - `getInboxItem(id)` for task header data
 *   - `getApprovalWorkflow(metadata.workflow_run_id)` for context
 *     (current step title/order, full workflow link)
 *   - `approveApprovalStep` / `rejectApprovalStep` for action — the
 *     state machine is unchanged
 *   - `updateInboxItem` (mark complete) / `dismissInboxItem` for
 *     non-approval task types
 *
 * Allowlist from `metadata_json`: `workflow_run_id`, `approval_step_id`
 * only — the raw dict is never rendered.
 */
export default function ApprovalTaskDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const location = useLocation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [decisionNote, setDecisionNote] = useState("");

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const task = await getInboxItem(id);
      if (!task || typeof task !== "object" || typeof task.id !== "string") {
        setState({ kind: "not_found" });
        return;
      }
      const refs = readApprovalRefs(task);
      let workflow: ApprovalWorkflowRun | null = null;
      if (refs.workflowRunId) {
        try {
          const wf = await getApprovalWorkflow(refs.workflowRunId);
          if (wf && typeof wf === "object" && Array.isArray((wf as { steps?: unknown }).steps)) {
            workflow = wf;
          }
        } catch {
          // Workflow context is best-effort. If it fails (404 / 500)
          // we still render the task header + the user can act via
          // mark-complete / dismiss.
          workflow = null;
        }
      }
      setState({ kind: "loaded", task, workflow });
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
      setState({ kind: "error", message: "Could not load this approval task." });
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const listPath = mountedPath("/approvals/tasks", location.pathname);

  async function onApprove(workflowId: string, stepId: string) {
    setAction({ kind: "pending", verb: "approve" });
    try {
      const note = decisionNote.trim();
      await approveApprovalStep(workflowId, stepId, {
        decision_note: note ? note : null,
      });
      setDecisionNote("");
      setAction({
        kind: "success",
        message: "Step approved. Refreshing workflow…",
      });
      await load();
    } catch (err) {
      setAction({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not approve step.",
      });
    }
  }

  async function onReject(workflowId: string, stepId: string) {
    setAction({ kind: "pending", verb: "reject" });
    try {
      const note = decisionNote.trim();
      await rejectApprovalStep(workflowId, stepId, {
        decision_note: note ? note : null,
      });
      setDecisionNote("");
      setAction({
        kind: "success",
        message: "Step rejected. Refreshing workflow…",
      });
      await load();
    } catch (err) {
      setAction({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not reject step.",
      });
    }
  }

  async function onMarkComplete() {
    setAction({ kind: "pending", verb: "complete" });
    try {
      await updateInboxItem(id, { status: "completed" });
      setAction({ kind: "success", message: "Task marked complete." });
      await load();
    } catch (err) {
      setAction({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Could not complete task.",
      });
    }
  }

  async function onDismiss() {
    setAction({ kind: "pending", verb: "dismiss" });
    try {
      await dismissInboxItem(id);
      setAction({ kind: "success", message: "Task dismissed." });
      await load();
    } catch (err) {
      setAction({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not dismiss task.",
      });
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="space-y-4" data-testid="approval-task-detail-loading">
        <Link to={listPath} className="text-xs text-ink-muted hover:text-ink">
          ← Approval tasks
        </Link>
        <LoadingSkeleton rows={5} />
      </div>
    );
  }

  if (state.kind === "not_found") {
    return (
      <div className="space-y-4" data-testid="approval-task-detail">
        <Link to={listPath} className="text-xs text-ink-muted hover:text-ink">
          ← Approval tasks
        </Link>
        <EmptyState
          title="Approval task not found"
          description="This task may have been removed or resolved. Try the approval tasks list."
          action={
            <Link
              to={listPath}
              className="inline-flex items-center rounded border border-rule bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:border-rule-strong"
              data-testid="approval-task-detail-not-found-back"
            >
              Back to approval tasks
            </Link>
          }
        />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-4" data-testid="approval-task-detail">
        <Link to={listPath} className="text-xs text-ink-muted hover:text-ink">
          ← Approval tasks
        </Link>
        <ErrorState
          title="Could not load this approval task"
          description={state.message}
        />
      </div>
    );
  }

  return (
    <TaskDetailContent
      task={state.task}
      workflow={state.workflow}
      pathname={location.pathname}
      listPath={listPath}
      action={action}
      decisionNote={decisionNote}
      onDecisionNoteChange={setDecisionNote}
      onApprove={onApprove}
      onReject={onReject}
      onMarkComplete={onMarkComplete}
      onDismiss={onDismiss}
    />
  );
}

function TaskDetailContent({
  task,
  workflow,
  pathname,
  listPath,
  action,
  decisionNote,
  onDecisionNoteChange,
  onApprove,
  onReject,
  onMarkComplete,
  onDismiss,
}: {
  task: InboxItem;
  workflow: ApprovalWorkflowRun | null;
  pathname: string;
  listPath: string;
  action: ActionState;
  decisionNote: string;
  onDecisionNoteChange: (v: string) => void;
  onApprove: (workflowId: string, stepId: string) => void;
  onReject: (workflowId: string, stepId: string) => void;
  onMarkComplete: () => void;
  onDismiss: () => void;
}) {
  const refs = useMemo(() => readApprovalRefs(task), [task]);
  const isApproval = task.item_type === "approval";
  const isActionable = task.status === "open";
  const isResolved =
    task.status === "completed" || task.status === "dismissed";
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const overdue =
    isActionable && task.due_date !== null && task.due_date < todayIso;

  const currentStep = workflow ? findCurrentStep(workflow, refs) : null;
  const actionableStep =
    isActionable && workflow?.status === "active" ? currentStep : null;

  return (
    <div className="space-y-5" data-testid="approval-task-detail">
      <nav className="text-xs text-ink-subtle" aria-label="Breadcrumb">
        <Link
          to={mountedPath("/approvals", pathname)}
          className="hover:text-ink"
          data-testid="approval-task-breadcrumb-approvals"
        >
          Approvals
        </Link>
        <span className="mx-1">/</span>
        <Link
          to={listPath}
          className="hover:text-ink"
          data-testid="approval-task-breadcrumb-tasks"
        >
          Tasks
        </Link>
        <span className="mx-1">/</span>
        <span className="text-ink-muted">{task.title}</span>
      </nav>

      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-lg font-semibold text-ink">{task.title}</h1>
          <TaskStatusPill status={task.status} />
          {task.priority && (
            <span
              className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle"
              data-testid="approval-task-detail-priority"
            >
              {task.priority} priority
            </span>
          )}
          {overdue && (
            <span
              className="rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-danger"
              data-testid="approval-task-detail-overdue"
            >
              overdue
            </span>
          )}
        </div>
        <p className="text-[11px] text-ink-subtle">
          Created {formatDate(task.created_at)}
          {task.due_date ? ` · due ${task.due_date}` : ""}
        </p>
      </header>

      <WhatAmIApproving
        task={task}
        workflow={workflow}
        currentStep={currentStep}
        pathname={pathname}
        isApproval={isApproval}
      />

      <ContextCards
        task={task}
        workflow={workflow}
        pathname={pathname}
      />

      <ActionPanel
        task={task}
        workflow={workflow}
        actionableStep={actionableStep}
        isApproval={isApproval}
        isActionable={isActionable}
        isResolved={isResolved}
        decisionNote={decisionNote}
        onDecisionNoteChange={onDecisionNoteChange}
        action={action}
        onApprove={onApprove}
        onReject={onReject}
        onMarkComplete={onMarkComplete}
        onDismiss={onDismiss}
      />
    </div>
  );
}

function WhatAmIApproving({
  task,
  workflow,
  currentStep,
  pathname,
  isApproval,
}: {
  task: InboxItem;
  workflow: ApprovalWorkflowRun | null;
  currentStep: ApprovalStep | null;
  pathname: string;
  isApproval: boolean;
}) {
  const lines: string[] = [];
  if (isApproval) {
    if (currentStep) {
      lines.push(
        `You are being asked to approve step ${currentStep.step_order}` +
          (workflow ? ` of ${workflow.steps.length}` : "") +
          `: ${currentStep.title}.`,
      );
    } else if (workflow) {
      lines.push(
        `This task belongs to workflow "${workflow.name}", which is ${workflow.status}.`,
      );
    } else {
      lines.push("This is an approval task. Open the workflow to act on it.");
    }
  } else {
    lines.push(
      task.description ??
        "This task is in your queue. Mark complete or dismiss it once handled.",
    );
  }

  return (
    <section
      className="rounded border border-rule p-3"
      data-testid="approval-task-detail-what"
    >
      <h2 className="text-xs font-medium text-ink">What am I approving?</h2>
      <p
        className="mt-1 text-xs text-ink-muted"
        data-testid="approval-task-detail-explanation"
      >
        {lines.join(" ")}
      </p>
      <ul className="mt-2 flex flex-wrap gap-3 text-xs text-ink-muted">
        {task.request_id && (
          <li>
            <Link
              to={mountedPath(`/requests/${task.request_id}`, pathname)}
              className="underline hover:text-ink"
              data-testid="approval-task-detail-request-link"
            >
              Open related Request
            </Link>
          </li>
        )}
        {task.contract_id && (
          <li>
            <Link
              to={mountedPath(`/repository/${task.contract_id}`, pathname)}
              className="underline hover:text-ink"
              data-testid="approval-task-detail-contract-link"
            >
              Open Repository record
            </Link>
          </li>
        )}
        {workflow && (
          <li>
            <Link
              to={mountedPath(
                `/approvals/workflows/${workflow.id}`,
                pathname,
              )}
              className="underline hover:text-ink"
              data-testid="approval-task-detail-workflow-link"
            >
              Open approval workflow
            </Link>
          </li>
        )}
        {!task.request_id && !task.contract_id && !workflow && (
          <li className="text-ink-subtle">No linked records.</li>
        )}
      </ul>
    </section>
  );
}

function ContextCards({
  task,
  workflow,
  pathname,
}: {
  task: InboxItem;
  workflow: ApprovalWorkflowRun | null;
  pathname: string;
}) {
  const cards: JSX.Element[] = [];

  if (task.request_id) {
    cards.push(
      <article
        key="request"
        className="rounded border border-rule p-3"
        data-testid="approval-task-detail-context-request"
      >
        <h3 className="text-xs font-medium text-ink">Request</h3>
        <p className="mt-1 text-xs text-ink-muted">
          Linked to a contract request. Open the request for intake
          details, the agreement template, and review status.
        </p>
        <Link
          to={mountedPath(`/requests/${task.request_id}`, pathname)}
          className="mt-2 inline-block text-xs text-ink-muted underline hover:text-ink"
        >
          Open request
        </Link>
      </article>,
    );
  }

  if (task.contract_id) {
    cards.push(
      <article
        key="repository"
        className="rounded border border-rule p-3"
        data-testid="approval-task-detail-context-repository"
      >
        <h3 className="text-xs font-medium text-ink">Repository record</h3>
        <p className="mt-1 text-xs text-ink-muted">
          Linked to a contract in the repository. Open the record for
          metadata, clauses, and prior versions.
        </p>
        <Link
          to={mountedPath(`/repository/${task.contract_id}`, pathname)}
          className="mt-2 inline-block text-xs text-ink-muted underline hover:text-ink"
        >
          Open repository record
        </Link>
      </article>,
    );
  }

  if (workflow) {
    const completed = workflow.steps.filter(
      (s) => s.status === "approved",
    ).length;
    const total = workflow.steps.length;
    const progress =
      workflow.status === "active" && workflow.current_step_order !== null
        ? `Step ${workflow.current_step_order} of ${total}`
        : `${completed} of ${total} step${total === 1 ? "" : "s"} approved`;
    cards.push(
      <article
        key="workflow"
        className="rounded border border-rule p-3"
        data-testid="approval-task-detail-context-workflow"
      >
        <h3 className="text-xs font-medium text-ink">Approval workflow</h3>
        <p
          className="mt-1 text-xs text-ink-muted"
          data-testid="approval-task-detail-context-workflow-progress"
        >
          {workflow.name} · {workflow.status} · {progress}
        </p>
        <Link
          to={mountedPath(`/approvals/workflows/${workflow.id}`, pathname)}
          className="mt-2 inline-block text-xs text-ink-muted underline hover:text-ink"
        >
          Open workflow
        </Link>
      </article>,
    );
  }

  if (cards.length === 0) return null;

  return (
    <section
      className="grid gap-3 sm:grid-cols-2"
      data-testid="approval-task-detail-context"
    >
      {cards}
    </section>
  );
}

function ActionPanel({
  task,
  workflow,
  actionableStep,
  isApproval,
  isActionable,
  isResolved,
  decisionNote,
  onDecisionNoteChange,
  action,
  onApprove,
  onReject,
  onMarkComplete,
  onDismiss,
}: {
  task: InboxItem;
  workflow: ApprovalWorkflowRun | null;
  actionableStep: ApprovalStep | null;
  isApproval: boolean;
  isActionable: boolean;
  isResolved: boolean;
  decisionNote: string;
  onDecisionNoteChange: (v: string) => void;
  action: ActionState;
  onApprove: (workflowId: string, stepId: string) => void;
  onReject: (workflowId: string, stepId: string) => void;
  onMarkComplete: () => void;
  onDismiss: () => void;
}) {
  if (isResolved) {
    return (
      <section
        className="rounded border border-rule bg-canvas-muted p-3 text-xs text-ink-muted"
        data-testid="approval-task-detail-resolved"
      >
        This task is {task.status}. No further action is available from
        this page.
      </section>
    );
  }

  const pending = action.kind === "pending";

  return (
    <section
      className="rounded border border-rule p-3"
      data-testid="approval-task-detail-actions"
    >
      <h2 className="text-xs font-medium text-ink">Action</h2>

      {isApproval && actionableStep && workflow ? (
        <>
          <p className="mt-1 text-xs text-ink-muted">
            Approve or reject the current pending step. A decision note
            is optional and will be saved on the step record.
          </p>
          <label className="mt-2 block text-[11px] text-ink-subtle">
            Decision note (optional)
            <textarea
              value={decisionNote}
              onChange={(e) => onDecisionNoteChange(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border border-rule bg-canvas p-2 text-xs text-ink"
              data-testid="approval-task-detail-decision-note"
              disabled={pending}
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <button
              type="button"
              className="rounded border border-ink bg-ink px-2 py-1 text-canvas disabled:opacity-50"
              onClick={() => onApprove(workflow.id, actionableStep.id)}
              disabled={pending}
              data-testid="approval-task-detail-approve"
            >
              {pending && action.verb === "approve" ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted disabled:opacity-50"
              onClick={() => onReject(workflow.id, actionableStep.id)}
              disabled={pending}
              data-testid="approval-task-detail-reject"
            >
              {pending && action.verb === "reject" ? "Rejecting…" : "Reject"}
            </button>
          </div>
        </>
      ) : isApproval ? (
        <p
          className="mt-1 text-xs text-ink-muted"
          data-testid="approval-task-detail-no-actionable-step"
        >
          {workflow
            ? `Workflow is ${workflow.status}. No pending step is available to act on.`
            : "No matching approval workflow could be loaded. Open the workflow list to act on this approval."}
        </p>
      ) : (
        <p className="mt-1 text-xs text-ink-muted">
          Mark this task complete once handled, or dismiss it if no
          action is needed.
        </p>
      )}

      {!isApproval && isActionable && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted disabled:opacity-50"
            onClick={onMarkComplete}
            disabled={pending}
            data-testid="approval-task-detail-complete"
          >
            {pending && action.verb === "complete"
              ? "Marking complete…"
              : "Mark complete"}
          </button>
          <button
            type="button"
            className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted disabled:opacity-50"
            onClick={onDismiss}
            disabled={pending}
            data-testid="approval-task-detail-dismiss"
          >
            {pending && action.verb === "dismiss" ? "Dismissing…" : "Dismiss"}
          </button>
        </div>
      )}

      {action.kind === "error" && (
        <p
          className="mt-2 text-xs text-danger"
          data-testid="approval-task-detail-action-error"
        >
          {action.message}
        </p>
      )}
      {action.kind === "success" && (
        <p
          className="mt-2 text-xs text-success"
          data-testid="approval-task-detail-action-success"
        >
          {action.message}
        </p>
      )}
    </section>
  );
}

const TASK_STATUS_PILL: Record<string, string> = {
  open: "bg-info/10 text-info border-info/40",
  completed: "bg-success/10 text-success border-success/40",
  dismissed: "bg-canvas-muted text-ink-muted border-rule",
};

function TaskStatusPill({ status }: { status: string }) {
  const cls =
    TASK_STATUS_PILL[status] ?? "bg-canvas-muted text-ink-muted border-rule";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
      data-testid="approval-task-detail-status-pill"
    >
      {status}
    </span>
  );
}

/**
 * Allowlisted projection of `metadata_json` for approval inbox items.
 *
 * The raw dict is never rendered; only these two id fields are read
 * so we can fetch the related workflow + highlight the current step.
 */
function readApprovalRefs(
  task: InboxItem,
): { workflowRunId: string | null; approvalStepId: string | null } {
  const meta = (task.metadata_json ?? {}) as Record<string, unknown>;
  const wf =
    typeof meta.workflow_run_id === "string" ? meta.workflow_run_id : null;
  const step =
    typeof meta.approval_step_id === "string" ? meta.approval_step_id : null;
  return { workflowRunId: wf, approvalStepId: step };
}

function findCurrentStep(
  workflow: ApprovalWorkflowRun,
  refs: { workflowRunId: string | null; approvalStepId: string | null },
): ApprovalStep | null {
  // Prefer the exact step the inbox item points at — fall back to the
  // workflow's current pending step if the id is missing or stale.
  if (refs.approvalStepId) {
    const direct = workflow.steps.find((s) => s.id === refs.approvalStepId);
    if (direct) return direct;
  }
  if (workflow.status === "active" && workflow.current_step_order !== null) {
    const pending = workflow.steps.find(
      (s) =>
        s.step_order === workflow.current_step_order && s.status === "pending",
    );
    return pending ?? null;
  }
  return null;
}
