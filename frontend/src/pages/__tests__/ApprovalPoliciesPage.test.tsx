import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPolicy } from "../../types/approvalPolicies";
import ApprovalPoliciesPage from "../ApprovalPoliciesPage";

const mocks = vi.hoisted(() => ({
  listApprovalPolicies: vi.fn(),
  createApprovalPolicy: vi.fn(),
  archiveApprovalPolicy: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  listApprovalPolicies: mocks.listApprovalPolicies,
  createApprovalPolicy: mocks.createApprovalPolicy,
  archiveApprovalPolicy: mocks.archiveApprovalPolicy,
  listApprovalWorkflowTemplates: vi.fn().mockResolvedValue([{ id: "wftpl-legal-review", name: "Legal Review", steps: [], status: "active" }]),
  listAgreementTemplates: vi.fn().mockResolvedValue([]),
}));

const basePolicies: ApprovalPolicy[] = [
  { id: "p1", organization_id: "org", name: "NDA Legal Review policy", description: null, status: "active", workflow_template_id: "wftpl-legal-review", request_type: null, contract_type: null, priority: null, agreement_template_id: null, auto_attach: true, applies_to_generated_contracts: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", metadata_json: null },
  { id: "p2", organization_id: "org", name: "Archived Sample Policy", description: null, status: "archived", workflow_template_id: "wftpl-legacy", request_type: null, contract_type: null, priority: null, agreement_template_id: null, auto_attach: true, applies_to_generated_contracts: true, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", metadata_json: null },
];

describe("ApprovalPoliciesPage", () => {
  beforeEach(() => {
    mocks.listApprovalPolicies.mockImplementation(async (filters?: { include_archived?: boolean }) =>
      filters?.include_archived ? basePolicies : basePolicies.filter((p) => p.status !== "archived"),
    );
    mocks.createApprovalPolicy.mockResolvedValue(undefined);
    mocks.archiveApprovalPolicy.mockResolvedValue(undefined);
  });

  it("renders list/form and hides archived by default", async () => {
    render(<ApprovalPoliciesPage />);
    expect(await screen.findByText("NDA Legal Review policy")).toBeInTheDocument();
    expect(screen.queryByText("Archived Sample Policy")).not.toBeInTheDocument();
  });

  it("shows archived when include archived is enabled", async () => {
    render(<ApprovalPoliciesPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: /include archived/i }));
    expect(await screen.findByText("Archived Sample Policy")).toBeInTheDocument();
  });

  it("submits blank criteria as null and archives", async () => {
    render(<ApprovalPoliciesPage />);
    fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Wildcard Policy" } });
    await screen.findByText("Legal Review");
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "wftpl-legal-review" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mocks.createApprovalPolicy).toHaveBeenCalled());
    const payload = mocks.createApprovalPolicy.mock.calls[0][0];
    expect(payload.request_type).toBeNull();
    expect(payload.contract_type).toBeNull();
    expect(payload.priority).toBeNull();
    expect(payload.agreement_template_id).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(mocks.archiveApprovalPolicy).toHaveBeenCalled());
  });
});
