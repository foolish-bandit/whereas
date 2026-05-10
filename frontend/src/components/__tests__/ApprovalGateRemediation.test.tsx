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

  it("renders active-approval guidance with deep-link URLs", () => {
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
    // PR #61: the Requests link now carries ?request_id=<id> so the
    // destination page can scroll/highlight that specific row.
    const reqLink = screen.getByTestId("remediation-request-link");
    expect(reqLink).toHaveAttribute(
      "href",
      "/demo/requests?request_id=req-1",
    );
    expect(
      screen.getByTestId("remediation-request-link-wrapper"),
    ).toHaveTextContent("req-1");
    // Each blocking workflow id is now its own deep-link.
    const workflowLinks = screen.getAllByTestId("remediation-workflow-link");
    const hrefs = workflowLinks.map((el) => el.getAttribute("href"));
    expect(hrefs).toEqual([
      "/demo/approvals?workflow_id=wf-1",
      "/demo/approvals?workflow_id=wf-2",
    ]);
  });

  it("renders rejection guidance with workflow deep-links", () => {
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
    expect(screen.getByTestId("remediation-workflow-link")).toHaveAttribute(
      "href",
      "/demo/approvals?workflow_id=wf-rejected",
    );
    expect(
      screen.getByTestId("remediation-request-link"),
    ).toHaveAttribute("href", "/demo/requests?request_id=req-2");
  });

  it("renders missing policy names with policy deep-links", () => {
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
    const policyLinks = screen.getAllByTestId("remediation-policy-link");
    const hrefs = policyLinks.map((el) => el.getAttribute("href"));
    expect(hrefs).toEqual([
      "/demo/approval-policies?policy_id=apol-1",
      "/demo/approval-policies?policy_id=apol-2",
    ]);
    expect(
      screen.getByTestId("remediation-request-link"),
    ).toHaveAttribute("href", "/demo/requests?request_id=req-3");
  });

  it("falls back to missing policy IDs when names are absent (still deep-linked)", () => {
    renderRemediation(
      gateBase({
        code: "required_approval_policy_unmet",
        missing_policy_ids: ["apol-legacy-1", "apol-legacy-2"],
      }),
    );
    const list = screen.getByTestId("remediation-missing-policies");
    expect(list).toHaveTextContent("apol-legacy-1");
    expect(list).toHaveTextContent("apol-legacy-2");
    const policyLinks = screen.getAllByTestId("remediation-policy-link");
    expect(policyLinks.map((el) => el.getAttribute("href"))).toEqual([
      "/demo/approval-policies?policy_id=apol-legacy-1",
      "/demo/approval-policies?policy_id=apol-legacy-2",
    ]);
  });

  it("renders cancellation guidance with the request deep-link and a list-page link", () => {
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
    ).toHaveAttribute("href", "/demo/requests?request_id=req-4");
    // Cancelled doesn't carry a specific workflow id to deep-link to,
    // so we keep the bare /demo/approvals destination here.
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
    // Blocking workflow guidance should still render with a deep-link.
    expect(screen.getByTestId("remediation-workflow-link")).toHaveAttribute(
      "href",
      "/demo/approvals?workflow_id=wf-only",
    );
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

  it("encodes special characters in deep-link ids", () => {
    renderRemediation(
      gateBase({
        code: "required_approval_policy_unmet",
        missing_policy_ids: ["pol/with space"],
      }),
    );
    expect(
      screen.getByTestId("remediation-policy-link"),
    ).toHaveAttribute(
      "href",
      "/demo/approval-policies?policy_id=pol%2Fwith%20space",
    );
  });

  it("renders nothing for unknown gate codes", () => {
    const { container } = renderRemediation(
      gateBase({ code: "no_linked_request" }),
    );
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
