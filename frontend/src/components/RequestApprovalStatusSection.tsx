import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import {
  ApiError,
  MissingDevUserError,
  getRequestApprovalStatus,
} from "../lib/api";
import { mountedPath } from "../lib/routes";
import type { RequestApprovalStatus } from "../types/requestApprovalStatus";
import Pill, { type PillTone } from "./ui/Pill";

interface Props {
  /** ID of the request to look up approval status for. */
  requestId: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; status: RequestApprovalStatus }
  | { kind: "error"; message: string };

/**
 * Compact, lazy-loaded approval visibility surface for a single request.
 *
 * The component renders inline on the Requests page when the user
 * expands a row; it never fetches at list-render time so there's no
 * N+1 cost on initial page load.
 *
 * Server-aligned: badges and blocking copy come straight from the
 * server's ``summary`` so the UI cannot disagree with the live
 * DocuSeal gate. No state derivation here.
 */
export default function RequestApprovalStatusSection({ requestId }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const location = useLocation();

  useEffect(() => {
    let aborted = false;
    setState({ kind: "loading" });
    getRequestApprovalStatus(requestId)
      .then((status) => {
        if (!aborted) setState({ kind: "loaded", status });
      })
      .catch((err) => {
        if (aborted) return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
        } else {
          setState({
            kind: "error",
            message: "Could not load approval status.",
          });
        }
      });
    return () => {
      aborted = true;
    };
  }, [requestId]);

  if (state.kind === "loading") {
    return (
      <p
        className="mt-3 text-xs text-ink-subtle"
        data-testid="request-approval-status-loading"
      >
        Loading approval status…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p
        className="mt-3 text-xs text-danger"
        data-testid="request-approval-status-error"
      >
        {state.message}
      </p>
    );
  }

  const { status } = state;
  return (
    <div
      className="mt-3 space-y-2 rounded border border-rule p-2 text-xs"
      data-testid="request-approval-status"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-ink">Approval status</p>
        <ApprovalBadge status={status} />
      </div>

      {status.matching_policies.length > 0 && (
        <div data-testid="request-approval-policies">
          <p className="text-ink-subtle">Approval Policies</p>
          <ul className="ml-4 list-disc">
            {status.matching_policies.map((p) => (
              <li
                key={p.id}
                data-testid="request-approval-policy"
                className="text-ink-muted"
              >
                <Link
                  to={mountedPath(
                    `/approvals/policies?policy_id=${encodeURIComponent(p.id)}`,
                    location.pathname,
                  )}
                  className="underline-offset-2 hover:underline"
                >
                  {p.name}
                </Link>
                {" · "}
                <span data-testid="request-approval-policy-workflow-state">
                  {policyWorkflowState(p.id, status)}
                </span>
                {p.applies_to_generated_contracts ? " · required" : ""}
                {!p.auto_attach ? " · manual" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {status.workflow_runs.length > 0 ? (
        <div data-testid="request-approval-workflows">
          <p className="text-ink-subtle">Approval Workflows</p>
          <ul className="space-y-1">
            {status.workflow_runs.map((run) => {
              const currentStep =
                run.current_step_order != null
                  ? run.steps.find(
                      (s) => s.step_order === run.current_step_order,
                    )
                  : undefined;
              return (
                <li
                  key={run.id}
                  className="rounded border border-rule p-2"
                  data-testid="request-approval-workflow"
                >
                  <p className="text-ink">
                    <Link
                      to={mountedPath(
                        `/approvals/workflows?workflow_id=${encodeURIComponent(run.id)}`,
                        location.pathname,
                      )}
                      className="underline-offset-2 hover:underline"
                    >
                      {run.name}
                    </Link>
                    {run.source_approval_policy_name ? (
                      <span className="text-ink-subtle">
                        {" "}· from policy {run.source_approval_policy_name}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-ink-subtle">
                    Status:{" "}
                    <span data-testid="request-approval-workflow-status">
                      {run.status}
                    </span>
                    {currentStep ? (
                      <>
                        {" · current step "}
                        <span data-testid="request-approval-current-step">
                          {currentStep.step_order}. {currentStep.title}
                        </span>
                      </>
                    ) : null}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        status.matching_policies.length === 0 && (
          <p
            className="text-ink-subtle"
            data-testid="request-approval-none"
          >
            No approval workflows or policies apply to this request.
          </p>
        )
      )}

      {status.summary.blocking_reason_text && (
        <p
          className="text-warning"
          data-testid="request-approval-blocking-reason"
        >
          {status.summary.blocking_reason_text}
        </p>
      )}

      {status.linked_contract_id ? (
        <p>
          <Link
            to={mountedPath(
              `/repository/${encodeURIComponent(status.linked_contract_id)}`,
              location.pathname,
            )}
            className="text-ink-muted underline-offset-2 hover:underline"
            data-testid="request-approval-contract-link"
          >
            Open linked Repository record
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function policyWorkflowState(
  policyId: string,
  status: RequestApprovalStatus,
): string {
  const runs = status.workflow_runs.filter(
    (run) => run.source_approval_policy_id === policyId,
  );
  if (runs.some((run) => run.status === "active")) return "workflow active";
  if (runs.some((run) => run.status === "completed")) {
    return "workflow completed";
  }
  if (runs.some((run) => run.status === "rejected")) return "workflow rejected";
  if (runs.some((run) => run.status === "cancelled")) {
    return "workflow cancelled";
  }
  return "workflow not attached";
}

function ApprovalBadge({ status }: { status: RequestApprovalStatus }) {
  const { summary } = status;
  let label: string;
  let testIdSuffix: string;
  let tone: PillTone;

  if (summary.has_active_workflows) {
    label = "Approval pending";
    testIdSuffix = "pending";
    tone = "warning";
  } else if (summary.has_rejected_workflows) {
    label = "Approval rejected";
    testIdSuffix = "rejected";
    tone = "danger";
  } else if (summary.ready_for_signature === true) {
    label = "Ready for signature";
    testIdSuffix = "ready";
    tone = "success";
  } else if (summary.has_completed_workflows && status.linked_contract_id == null) {
    label = "Approval completed";
    testIdSuffix = "completed";
    tone = "success";
  } else if (summary.blocking_reason) {
    label = "Approval blocked";
    testIdSuffix = "blocked";
    tone = "danger";
  } else if (status.matching_policies.length === 0 && status.workflow_runs.length === 0) {
    label = "No approval required";
    testIdSuffix = "none";
    tone = "neutral";
  } else {
    label = "Approval pending";
    testIdSuffix = "pending";
    tone = "warning";
  }

  return (
    <Pill
      tone={tone}
      variant="outline"
      className="uppercase tracking-wide"
      data-testid={`request-approval-badge-${testIdSuffix}`}
    >
      {label}
    </Pill>
  );
}
