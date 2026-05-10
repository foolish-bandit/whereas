import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import ApprovalGateRemediation from "../ApprovalGateRemediation";
import type {
  ApprovalGatePolicySummary,
  ContractApprovalGate,
} from "../../types/docuseal";

function policy(id: string, name: string): ApprovalGatePolicySummary {
  return {
    id,
    name,
    workflow_template_id: `tpl-${id}`,
    auto_attach: true,
    applies_to_generated_contracts: true,
    request_type: null,
    contract_type: null,
    priority: null,
    agreement_template_id: null,
  };
}

function gateBase(overrides: Partial<ContractApprovalGate>): ContractApprovalGate {
  return {
    allowed: false,
    code: "active_approval_workflows",
    request_id: null,
    blocking_workflow_ids: [],
    completed_workflow_ids: [],
    active_count: 0,
    rejected_count: 0,
    cancelled_count: 0,
    completed_count: 0,
    ...overrides,
  };
}

function renderRemediation(gate: ContractApprovalGate) {
  return render(
    <MemoryRouter>
      <ApprovalGateRemediation gate={gate} />
    </MemoryRouter>,
  );
}

describe("ApprovalGateRemediation", () => {
  it("renders nothing when the gate allows the send", () => {
    const { container } = renderRemediation(
      gateBase({ allowed: true, code: "approvals_completed" }),
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders active-approval guidance for active_approval_workflows", () => {
    renderRemediation(
      gateBase({
        code: "active_approval_workflows",
        request_id: "req-1",
        blocking_workflow_ids: ["wf-1", "wf-2"],
        active_count: 2,
      }),
    );
    expect(
      screen.getByTestId("remediation-active-approval-workflows"),
    ).toHaveTextContent(
      /complete the active approval workflow before sending/i,
    );
    // Request approvals link uses the demo Requests route.
    const reqLink = screen.getByTestId("remediation-request-link");
    expect(reqLink).toHaveAttribute("href", "/demo/requests");
    expect(
      screen.getByTestId("remediation-request-link-wrapper"),
    ).toHaveTextContent("req-1");
    // Blocking workflow ids are surfaced as copy + an Approvals link.
    const block = screen.getByTestId("remediation-blocking-workflows");
    expect(block).toHaveTextContent("wf-1");
    expect(block).toHaveTextContent("wf-2");
    expect(
      screen.getByTestId("remediation-approvals-link"),
    ).toHaveAttribute("href", "/demo/approvals");
  });

  it("renders rejection guidance for rejected_approval_workflows", () => {
    renderRemediation(
      gateBase({
        code: "rejected_approval_workflows",
        request_id: "req-2",
        blocking_workflow_ids: ["wf-rejected"],
        rejected_count: 1,
      }),
    );
    expect(
      screen.getByTestId("remediation-rejected-approval-workflows"),
    ).toHaveTextContent(
      /an approval workflow was rejected\. resolve or restart the approval process/i,
    );
    expect(screen.getByTestId("remediation-blocking-workflows")).toHaveTextContent(
      "wf-rejected",
    );
    expect(
      screen.getByTestId("remediation-request-link"),
    ).toHaveAttribute("href", "/demo/requests");
  });

  it("renders missing policy names and link for required_approval_policy_unmet", () => {
    renderRemediation(
      gateBase({
        code: "required_approval_policy_unmet",
        request_id: "req-3",
        required_policy_ids: ["apol-1", "apol-2"],
        missing_policy_ids: ["apol-1", "apol-2"],
        required_policies: [
          policy("apol-1", "Standard Legal Review"),
          policy("apol-2", "Executive Approval"),
        ],
        missing_policies: [
          policy("apol-1", "Standard Legal Review"),
          policy("apol-2", "Executive Approval"),
        ],
      }),
    );
    expect(
      screen.getByTestId("remediation-required-approval-policy-unmet"),
    ).toHaveTextContent(
      /required approval policies must be completed before sending/i,
    );
    const list = screen.getByTestId("remediation-missing-policies");
    expect(list).toHaveTextContent("Standard Legal Review");
    expect(list).toHaveTextContent("Executive Approval");
    // Names should be preferred over opaque ids.
    expect(list).not.toHaveTextContent("apol-1");
    expect(list).not.toHaveTextContent("apol-2");
    expect(
      screen.getByTestId("remediation-approval-policies-link"),
    ).toHaveAttribute("href", "/demo/approval-policies");
    expect(
      screen.getByTestId("remediation-request-link"),
    ).toHaveAttribute("href", "/demo/requests");
  });

  it("falls back to missing policy IDs when names are absent", () => {
    renderRemediation(
      gateBase({
        code: "required_approval_policy_unmet",
        missing_policy_ids: ["apol-legacy-1", "apol-legacy-2"],
      }),
    );
    const list = screen.getByTestId("remediation-missing-policies");
    expect(list).toHaveTextContent("apol-legacy-1");
    expect(list).toHaveTextContent("apol-legacy-2");
  });

  it("renders cancellation guidance for cancelled_without_completed_approval", () => {
    renderRemediation(
      gateBase({
        code: "cancelled_without_completed_approval",
        request_id: "req-4",
        cancelled_count: 1,
      }),
    );
    expect(
      screen.getByTestId("remediation-cancelled-without-completed-approval"),
    ).toHaveTextContent(
      /the approval workflow was cancelled before approval completed/i,
    );
    expect(
      screen.getByTestId("remediation-request-link"),
    ).toHaveAttribute("href", "/demo/requests");
    // Link to the Approvals page so the user can start a fresh workflow.
    expect(
      screen.getByTestId("remediation-approvals-link"),
    ).toHaveAttribute("href", "/demo/approvals");
  });

  it("omits the request approvals link when no request_id is present", () => {
    renderRemediation(
      gateBase({
        code: "active_approval_workflows",
        request_id: null,
        blocking_workflow_ids: ["wf-only"],
        active_count: 1,
      }),
    );
    expect(
      screen.queryByTestId("remediation-request-link"),
    ).not.toBeInTheDocument();
    // Blocking workflow guidance should still render.
    expect(
      screen.getByTestId("remediation-blocking-workflows"),
    ).toHaveTextContent("wf-only");
  });

  it("omits the blocking workflows block when no ids are present", () => {
    renderRemediation(
      gateBase({
        code: "active_approval_workflows",
        request_id: "req-5",
        blocking_workflow_ids: [],
        active_count: 1,
      }),
    );
    expect(
      screen.queryByTestId("remediation-blocking-workflows"),
    ).not.toBeInTheDocument();
  });

  it("renders nothing for unknown gate codes", () => {
    const { container } = renderRemediation(
      gateBase({ code: "no_linked_request" }),
    );
    // Container holds a wrapper div with the heading; the body is empty.
    expect(
      screen.queryByTestId("remediation-active-approval-workflows"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("remediation-rejected-approval-workflows"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("remediation-required-approval-policy-unmet"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("remediation-cancelled-without-completed-approval"),
    ).not.toBeInTheDocument();
    // Wrapper itself still renders (heading is fine even if body empty).
    expect(container.querySelector('[data-testid="docuseal-gate-remediation"]')).not.toBeNull();
  });

  it("does not surface any storage internals", () => {
    renderRemediation(
      gateBase({
        code: "required_approval_policy_unmet",
        required_policies: [policy("apol-1", "Standard Legal Review")],
        missing_policies: [policy("apol-1", "Standard Legal Review")],
      }),
    );
    const html = document.body.innerHTML;
    expect(html).not.toContain("storage_key");
    expect(html).not.toContain("wrapped_dek");
    expect(html).not.toContain("wrapped_master_key");
  });
});
