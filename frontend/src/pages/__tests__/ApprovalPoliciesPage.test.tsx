import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

function renderPage(initialEntry = "/approval-policies") {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/approval-policies" element={<ApprovalPoliciesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ApprovalPoliciesPage", () => {
  beforeEach(() => {
    // Reset call history so each test's assertions see a clean slate.
    mocks.listApprovalPolicies.mockReset();
    mocks.createApprovalPolicy.mockReset();
    mocks.archiveApprovalPolicy.mockReset();
    mocks.listApprovalPolicies.mockImplementation(async (filters?: { include_archived?: boolean }) =>
      filters?.include_archived ? basePolicies : basePolicies.filter((p) => p.status !== "archived"),
    );
    mocks.createApprovalPolicy.mockResolvedValue(undefined);
    mocks.archiveApprovalPolicy.mockResolvedValue(undefined);
  });

  it("renders list/form and hides archived by default", async () => {
    renderPage();
    expect(await screen.findByText("NDA Legal Review policy")).toBeInTheDocument();
    expect(screen.queryByText("Archived Sample Policy")).not.toBeInTheDocument();
  });

  it("shows archived when include archived is enabled", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("checkbox", { name: /include archived/i }));
    expect(await screen.findByText("Archived Sample Policy")).toBeInTheDocument();
  });

  it("submits blank criteria as null and archives via two-step confirm (PR #85)", async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Wildcard Policy" } });
    // PR #85: "Legal Review" now appears both as the workflow-template
    // option AND as the resolved template name on the existing policy
    // row, so we wait via the option role instead of findByText.
    await screen.findByRole("option", { name: "Legal Review" });
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "wftpl-legal-review" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mocks.createApprovalPolicy).toHaveBeenCalled());
    const payload = mocks.createApprovalPolicy.mock.calls[0][0];
    expect(payload.request_type).toBeNull();
    expect(payload.contract_type).toBeNull();
    expect(payload.priority).toBeNull();
    expect(payload.agreement_template_id).toBeNull();

    // PR #85: clicking Archive opens a two-step confirm — no archive
    // request is sent until Confirm archive is clicked.
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(mocks.archiveApprovalPolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("approval-policy-confirm-archive"));
    await waitFor(() => expect(mocks.archiveApprovalPolicy).toHaveBeenCalled());
  });

  it("cancels the archive confirm without sending a request (PR #85)", async () => {
    renderPage();
    await screen.findByText("NDA Legal Review policy");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByTestId("approval-policy-confirm-archive")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("approval-policy-cancel-archive"));
    expect(mocks.archiveApprovalPolicy).not.toHaveBeenCalled();
    // Archive button should be back; confirm should be gone.
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByTestId("approval-policy-confirm-archive")).toBeNull();
  });

  it("renders a status pill, criteria chips, and workflow template name (PR #85)", async () => {
    renderPage();
    await screen.findByText("NDA Legal Review policy");
    expect(screen.getByTestId("approval-policy-status-pill")).toHaveTextContent(
      /active/i,
    );
    // All four criteria chips are present, defaulting to "Any" when the
    // backend field is null.
    expect(
      screen.getByTestId("approval-policy-criteria-request"),
    ).toHaveTextContent(/Request type: Any/i);
    expect(
      screen.getByTestId("approval-policy-criteria-contract"),
    ).toHaveTextContent(/Contract type: Any/i);
    expect(
      screen.getByTestId("approval-policy-criteria-priority"),
    ).toHaveTextContent(/Priority: Any/i);
    expect(
      screen.getByTestId("approval-policy-criteria-agreement"),
    ).toHaveTextContent(/Agreement: Any/i);
  });

  // -------------------------------------------------------------------------
  // PR #61 — policy_id deep-link
  // -------------------------------------------------------------------------

  it("highlights the deep-linked policy_id row", async () => {
    renderPage("/approval-policies?policy_id=p1");
    const target = await screen.findByText("NDA Legal Review policy");
    const row = target.closest('[data-testid="approval-policy-row"]');
    expect(row).toHaveAttribute("data-deep-link-target", "true");
    expect(row).toHaveAttribute("aria-label", expect.stringMatching(/linked approval policy/i));
  });

  it("auto-enables include archived when the deep-linked policy is archived", async () => {
    renderPage("/approval-policies?policy_id=p2");
    // After the auto-toggle + reload, the archived row should appear and
    // be highlighted.
    const archived = await screen.findByText("Archived Sample Policy");
    const row = archived.closest('[data-testid="approval-policy-row"]');
    expect(row).toHaveAttribute("data-deep-link-target", "true");
    expect(
      (screen.getByRole("checkbox", { name: /include archived/i }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("shows a not-found notice when the deep-linked policy is missing", async () => {
    renderPage("/approval-policies?policy_id=p-missing");
    // Even after the auto-archived toggle the id is still missing, so
    // the notice should render.
    await waitFor(() => {
      expect(
        screen.getByTestId("approval-policies-deep-link-not-found"),
      ).toHaveTextContent("p-missing");
    });
  });
});
