import { useEffect, useRef, useState } from "react";

import { ApiError, MissingDevUserError } from "../lib/api";
import {
  createFindingRemediationTask,
  getFindingRemediationPlan,
} from "../lib/remediationApi";
import type { DeviationFinding } from "../types/findings";
import type { FindingRemediationPlan } from "../types/remediation";

interface FindingRemediationCardProps {
  contractId: string;
  finding: DeviationFinding;
}

type PlanState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; plan: FindingRemediationPlan }
  | { kind: "error"; message: string };

type TaskState =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

type CopyState = "idle" | "copied" | "error";

export default function FindingRemediationCard({
  contractId,
  finding,
}: FindingRemediationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [planState, setPlanState] = useState<PlanState>({ kind: "idle" });
  const [taskState, setTaskState] = useState<TaskState>({ kind: "idle" });
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const findingRef = useRef(finding);
  const taskControllerRef = useRef<AbortController | null>(null);
  const panelId = `finding-remediation-${finding.id}`;
  findingRef.current = finding;

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setPlanState({ kind: "loading" });
    setTaskState({ kind: "idle" });
    setCopyState("idle");

    getFindingRemediationPlan(contractId, findingRef.current, {
      signal: controller.signal,
    })
      .then((plan) => {
        if (!controller.signal.aborted) {
          setPlanState({ kind: "loaded", plan });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPlanState({
          kind: "error",
          message: remediationErrorMessage(
            error,
            "Could not load the remediation plan.",
          ),
        });
      });

    return () => controller.abort();
  }, [contractId, expanded, finding.id, loadAttempt]);

  useEffect(() => {
    taskControllerRef.current?.abort();
    taskControllerRef.current = null;
    setTaskState({ kind: "idle" });
    return () => taskControllerRef.current?.abort();
  }, [contractId, finding.id]);

  async function copyLanguage(language: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(language);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = language;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textArea);
        if (!copied) throw new Error("Copy command was rejected.");
      }
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  async function createTask(): Promise<void> {
    if (
      planState.kind !== "loaded" ||
      planState.plan.finding_status === "superseded"
    ) {
      return;
    }
    taskControllerRef.current?.abort();
    const controller = new AbortController();
    taskControllerRef.current = controller;
    setTaskState({ kind: "creating" });

    try {
      const response = await createFindingRemediationTask(
        contractId,
        findingRef.current,
        {},
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setPlanState({ kind: "loaded", plan: response.plan });
      setTaskState({
        kind: "success",
        message: response.created
          ? "Task created"
          : response.reopened
            ? "Task reopened"
            : "Existing task reused",
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setTaskState({
        kind: "error",
        message: remediationErrorMessage(
          error,
          "Could not create the Inbox task.",
        ),
      });
    } finally {
      if (taskControllerRef.current === controller) {
        taskControllerRef.current = null;
      }
    }
  }

  return (
    <section className="mt-2 rounded border border-rule bg-canvas-subtle">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-2.5 py-2 text-left text-[11px] font-medium text-ink transition-colors hover:bg-canvas-muted"
      >
        <span>{expanded ? "Hide remediation plan" : "Plan remediation"}</span>
        <span aria-hidden="true" className="text-ink-subtle">
          {expanded ? "−" : "+"}
        </span>
      </button>

      {expanded && (
        <div id={panelId} className="border-t border-rule px-2.5 py-2.5">
          {planState.kind === "loading" && (
            <p role="status" className="text-[11px] text-ink-subtle">
              Loading approved sources…
            </p>
          )}

          {planState.kind === "error" && (
            <div role="alert" className="space-y-2">
              <p className="text-[11px] text-danger">{planState.message}</p>
              <button
                type="button"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                className="rounded border border-rule bg-canvas px-2 py-1 text-[11px] font-medium text-ink-muted hover:bg-canvas-muted"
              >
                Try again
              </button>
            </div>
          )}

          {planState.kind === "loaded" && (
            <RemediationPlanBody
              plan={planState.plan}
              copyState={copyState}
              taskState={taskState}
              onCopy={copyLanguage}
              onCreateTask={createTask}
            />
          )}
        </div>
      )}
    </section>
  );
}

interface RemediationPlanBodyProps {
  plan: FindingRemediationPlan;
  copyState: CopyState;
  taskState: TaskState;
  onCopy: (language: string) => Promise<void>;
  onCreateTask: () => Promise<void>;
}

function RemediationPlanBody({
  plan,
  copyState,
  taskState,
  onCopy,
  onCreateTask,
}: RemediationPlanBodyProps) {
  const task = plan.existing_task;
  const superseded = plan.finding_status === "superseded";
  const canCreateOrReopen =
    !superseded && (task === null || task.status === "dismissed");

  return (
    <div className="space-y-3">
      <div aria-label="Remediation source">
        <p className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle">
          Approved source
        </p>
        {plan.source_type === "none" ? (
          <p className="mt-0.5 text-[11px] font-medium text-warning">
            No approved source
          </p>
        ) : (
          <>
            <p className="mt-0.5 text-[11px] font-medium text-ink">
              {plan.source_name ?? sourceTypeLabel(plan.source_type)}
            </p>
            <p className="mt-0.5 text-[10px] text-ink-subtle">
              {sourceTypeLabel(plan.source_type)}
            </p>
          </>
        )}
        <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
          {plan.rationale}
        </p>
      </div>

      {plan.scope_warning && (
        <div
          role="note"
          className="rounded border border-warning-ring bg-warning-soft px-2 py-1.5 text-[11px] leading-relaxed text-warning"
        >
          {plan.scope_warning}
        </div>
      )}

      {plan.suggested_language ? (
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle">
              Approved language
            </p>
            <button
              type="button"
              onClick={() => onCopy(plan.suggested_language ?? "")}
              className="rounded border border-rule bg-canvas px-2 py-0.5 text-[10px] font-medium text-ink-muted hover:bg-canvas-muted"
            >
              Copy language
            </button>
          </div>
          <pre
            aria-label="Approved remediation language"
            className="mt-1 whitespace-pre-wrap rounded border border-rule bg-canvas px-2 py-2 font-sans text-[11px] leading-relaxed text-ink-muted"
          >
            {plan.suggested_language}
          </pre>
          {copyState === "copied" && (
            <p role="status" className="mt-1 text-[10px] text-success">
              Copied
            </p>
          )}
          {copyState === "error" && (
            <p role="alert" className="mt-1 text-[10px] text-danger">
              Copy failed. Select the text manually.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded border border-rule bg-canvas px-2 py-2">
          <p className="text-[11px] font-medium text-ink">
            No approved language is available yet.
          </p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-ink-subtle">
            Add preferred language to the playbook rule or an active Clause
            Manager source. The finding can still be assigned as work now.
          </p>
        </div>
      )}

      {superseded && (
        <div
          role="note"
          className="rounded border border-warning-ring bg-warning-soft px-2 py-2 text-[11px] leading-relaxed text-warning"
        >
          This finding belongs to an older review. Open the latest review run
          before creating or reopening remediation work.
        </div>
      )}

      <div className="border-t border-rule pt-2.5">
        {task && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-ink-muted">
              Task {humanizeStatus(task.status)}
            </p>
            <a
              href={`/demo/inbox?item_id=${encodeURIComponent(task.id)}`}
              className="text-[11px] font-medium text-accent underline-offset-2 hover:underline"
            >
              Open in Inbox
            </a>
          </div>
        )}

        {canCreateOrReopen && (
          <button
            type="button"
            onClick={onCreateTask}
            disabled={taskState.kind === "creating"}
            className="rounded border border-ink bg-ink px-2.5 py-1 text-[11px] font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-60"
          >
            {taskState.kind === "creating"
              ? "Saving…"
              : task?.status === "dismissed"
                ? "Reopen Inbox task"
                : "Create Inbox task"}
          </button>
        )}

        {taskState.kind === "success" && (
          <p role="status" className="mt-1.5 text-[10px] text-success">
            {taskState.message}
          </p>
        )}
        {taskState.kind === "error" && (
          <p role="alert" className="mt-1.5 text-[10px] text-danger">
            {taskState.message}
          </p>
        )}
        <p className="mt-1.5 text-[10px] leading-relaxed text-ink-subtle">
          Whereas will not edit the Repository record automatically. Review and
          apply approved language deliberately.
        </p>
      </div>
    </div>
  );
}

function sourceTypeLabel(
  sourceType: FindingRemediationPlan["source_type"],
): string {
  if (sourceType === "playbook_preferred_language") {
    return "Playbook preferred language";
  }
  if (sourceType === "clause_template") return "Clause Manager";
  return "No approved source";
}

function humanizeStatus(status: string): string {
  return status.trim().toLowerCase().replace(/_/g, " ") || "open";
}

function remediationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof MissingDevUserError || error instanceof ApiError) {
    return error.message;
  }
  return fallback;
}