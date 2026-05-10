import { Link } from "react-router-dom";

import { demoPath } from "../lib/routes";
import type { ContractApprovalGate } from "../types/docuseal";

interface Props {
  gate: ContractApprovalGate;
}

/**
 * Renders the "How to unblock" guidance shown beneath the blocked
 * Send-to-DocuSeal panel.
 *
 * Pure presentation: no API calls, no state. Maps the gate's ``code``
 * to actionable guidance and safe links into the existing Requests,
 * Approvals, and Approval Policies pages. Detail-level deep-linking
 * isn't supported by those pages today, so the links target the list
 * routes and the helper text names the relevant policy / workflow ids
 * so the user can find them quickly.
 */
export default function ApprovalGateRemediation({ gate }: Props) {
  if (gate.allowed) return null;

  return (
    <div
      className="mt-2 border-t border-warning/40 pt-2 text-xs"
      data-testid="docuseal-gate-remediation"
    >
      <p className="font-medium text-ink">How to unblock</p>
      <RemediationBody gate={gate} />
    </div>
  );
}

function RemediationBody({ gate }: Props) {
  switch (gate.code) {
    case "active_approval_workflows":
      return (
        <div data-testid="remediation-active-approval-workflows">
          <p className="mt-1">
            Complete the active approval workflow before sending.
          </p>
          <RequestApprovalsLink requestId={gate.request_id} />
          <BlockingWorkflowsBlock
            blockingIds={gate.blocking_workflow_ids ?? []}
          />
        </div>
      );
    case "rejected_approval_workflows":
      return (
        <div data-testid="remediation-rejected-approval-workflows">
          <p className="mt-1">
            An approval workflow was rejected. Resolve or restart the
            approval process before sending.
          </p>
          <RequestApprovalsLink requestId={gate.request_id} />
          <BlockingWorkflowsBlock
            blockingIds={gate.blocking_workflow_ids ?? []}
          />
        </div>
      );
    case "required_approval_policy_unmet":
      return (
        <div data-testid="remediation-required-approval-policy-unmet">
          <p className="mt-1">
            Required approval policies must be completed before sending.
          </p>
          <MissingPoliciesBlock gate={gate} />
          <RequestApprovalsLink requestId={gate.request_id} />
        </div>
      );
    case "cancelled_without_completed_approval":
      return (
        <div data-testid="remediation-cancelled-without-completed-approval">
          <p className="mt-1">
            The approval workflow was cancelled before approval
            completed. Start a new approval workflow before sending.
          </p>
          <RequestApprovalsLink requestId={gate.request_id} />
          <p className="mt-1">
            <Link
              className="underline"
              to={demoPath("/approvals")}
              data-testid="remediation-approvals-link"
            >
              Open approval workflows
            </Link>
          </p>
        </div>
      );
    default:
      return null;
  }
}

function RequestApprovalsLink({ requestId }: { requestId: string | null }) {
  if (!requestId) return null;
  return (
    <p className="mt-1" data-testid="remediation-request-link-wrapper">
      <Link
        className="underline"
        to={demoPath("/requests")}
        data-testid="remediation-request-link"
      >
        View request approvals
      </Link>
      <span className="ml-1 text-ink-subtle">
        — open the linked request and select “View approval status”
        (request id: <code>{requestId}</code>).
      </span>
    </p>
  );
}

function BlockingWorkflowsBlock({ blockingIds }: { blockingIds: string[] }) {
  if (blockingIds.length === 0) return null;
  return (
    <div className="mt-1" data-testid="remediation-blocking-workflows">
      <p>
        <Link
          className="underline"
          to={demoPath("/approvals")}
          data-testid="remediation-approvals-link"
        >
          Open approval workflows
        </Link>
        <span className="ml-1 text-ink-subtle">
          — find the blocking workflow{blockingIds.length === 1 ? "" : "s"} by
          id:
        </span>
      </p>
      <ul className="ml-4 mt-1 list-disc">
        {blockingIds.map((id) => (
          <li key={id}>
            <code>{id}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MissingPoliciesBlock({ gate }: Props) {
  const summaries = gate.missing_policies ?? [];
  const ids = gate.missing_policy_ids ?? [];
  const items: { key: string; label: string; isId: boolean }[] = summaries.length
    ? summaries.map((p) => ({ key: p.id, label: p.name, isId: false }))
    : ids.map((id) => ({ key: id, label: id, isId: true }));
  if (items.length === 0) return null;
  return (
    <div className="mt-1" data-testid="remediation-missing-policies">
      <p>
        <Link
          className="underline"
          to={demoPath("/approval-policies")}
          data-testid="remediation-approval-policies-link"
        >
          Open approval policies
        </Link>
        <span className="ml-1 text-ink-subtle">
          — the following polic{items.length === 1 ? "y is" : "ies are"} not
          yet satisfied:
        </span>
      </p>
      <ul className="ml-4 mt-1 list-disc">
        {items.map((item) => (
          <li key={item.key}>
            {item.isId ? <code>{item.label}</code> : item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
