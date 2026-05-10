import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DashboardPage from "../DashboardPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const SAMPLE_SUMMARY = {
  counts: {
    open_requests: 3,
    in_progress_requests: 1,
    urgent_or_high_priority_requests: 2,
    open_inbox_items: 5,
    overdue_inbox_items: 1,
    contracts_total: 12,
    contracts_sent_for_signature: 2,
    contracts_executed: 4,
    templates_active: 3,
    active_approval_workflows: 2,
    pending_approval_steps: 4,
    overdue_approval_steps: 1,
    active_approval_workflow_templates: 3,
  },
  upcoming: {
    requests_due_soon: [
      {
        id: "req-1",
        title: "NDA with Acme",
        status: "open",
        priority: "high",
        request_type: "new_contract",
        contract_type: "NDA",
        counterparty_name: "Acme Corp",
        due_date: "2026-05-12",
        linked_contract_id: null,
        created_at: "2026-05-08T16:00:00Z",
        updated_at: "2026-05-08T16:00:00Z",
      },
    ],
    inbox_items_due_soon: [
      {
        id: "inbox-1",
        title: "Review NDA draft",
        status: "open",
        priority: "high",
        item_type: "request_review",
        due_date: "2026-05-10",
        request_id: "req-1",
        contract_id: null,
        template_id: null,
        created_at: "2026-05-08T16:00:00Z",
        updated_at: "2026-05-08T16:00:00Z",
      },
    ],
  },
  recent_activity: {
    recent_contracts: [
      {
        id: "contract-recent",
        title: "Acme MSA draft",
        status: "ready",
        created_at: "2026-05-08T15:00:00Z",
        updated_at: "2026-05-08T15:00:00Z",
        docuseal_submission_id: null,
        has_generated_docx: true,
        has_signed_pdf: false,
      },
    ],
    recent_requests: [
      {
        id: "req-recent",
        title: "MSA renewal",
        status: "in_progress",
        priority: "normal",
        request_type: "renewal",
        contract_type: "MSA",
        counterparty_name: null,
        due_date: null,
        linked_contract_id: null,
        created_at: "2026-05-07T10:00:00Z",
        updated_at: "2026-05-07T10:00:00Z",
      },
    ],
    recent_signed_contracts: [
      {
        id: "contract-signed",
        title: "DPA with HostingCo",
        status: "executed",
        created_at: "2026-04-30T14:00:00Z",
        updated_at: "2026-04-30T14:00:00Z",
        docuseal_submission_id: "demo-submission",
        has_generated_docx: false,
        has_signed_pdf: true,
      },
    ],
  },
  approval_analytics: {
    pending_steps: 4,
    overdue_steps: 1,
    active_workflows: 2,
    completed_workflows: 7,
    rejected_workflows: 1,
    cancelled_workflows: 2,
    workflows_completed_last_30_days: 3,
    workflows_rejected_last_30_days: 1,
    pending_by_assignee: [
      {
        assigned_to: "user-alice",
        count: 3,
        overdue_count: 1,
      },
      {
        assigned_to: null,
        count: 1,
        overdue_count: 0,
      },
    ],
    oldest_pending_steps: [
      {
        id: "step-overdue",
        workflow_run_id: "wf-blocked",
        title: "Legal review",
        step_order: 1,
        assigned_to: "user-alice",
        approver_name: "Alice Counsel",
        due_date: "2026-05-01",
        created_at: "2026-04-28T10:00:00Z",
        request_id: "req-blocked",
        contract_id: null,
      },
      {
        id: "step-no-due",
        workflow_run_id: "wf-other",
        title: "Finance review",
        step_order: 2,
        assigned_to: null,
        approver_name: null,
        due_date: null,
        created_at: "2026-05-01T10:00:00Z",
        request_id: null,
        contract_id: "contract-blocked",
      },
    ],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route path="/dashboard" element={<DashboardPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("DashboardPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("renders metric cards from the summary response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SAMPLE_SUMMARY));
    renderPage();

    const counts = await screen.findByTestId("dashboard-counts");
    expect(
      within(counts).getByTestId("count-open_requests").textContent,
    ).toContain("3");
    expect(
      within(counts).getByTestId("count-overdue_inbox_items").textContent,
    ).toContain("1");
    expect(
      within(counts).getByTestId("count-contracts_executed").textContent,
    ).toContain("4");
    expect(
      within(counts).getByTestId("count-templates_active").textContent,
    ).toContain("3");
    expect(
      within(counts).getByTestId("count-active_approval_workflows").textContent,
    ).toContain("2");
    expect(
      within(counts).getByTestId("count-pending_approval_steps").textContent,
    ).toContain("4");
    expect(
      within(counts).getByTestId("count-overdue_approval_steps").textContent,
    ).toContain("1");
  });

  it("renders upcoming requests and links to the requests page", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SAMPLE_SUMMARY));
    renderPage();

    const row = await screen.findByTestId("dashboard-request-row");
    expect(within(row).getByText("NDA with Acme")).toBeInTheDocument();
    const link = within(row).getByRole("link", { name: "NDA with Acme" });
    expect(link).toHaveAttribute("href", "/demo/requests");
  });

  it("renders upcoming inbox items and links to the inbox page", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SAMPLE_SUMMARY));
    renderPage();

    const row = await screen.findByTestId("dashboard-inbox-row");
    expect(within(row).getByText("Review NDA draft")).toBeInTheDocument();
    expect(
      within(row).getByRole("link", { name: "Review NDA draft" }),
    ).toHaveAttribute("href", "/demo/inbox");
  });

  it("renders recent contracts with badges and links to the workspace", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SAMPLE_SUMMARY));
    renderPage();

    const recent = await screen.findByTestId("section-recent-contracts");
    const link = within(recent).getByRole("link", {
      name: "Acme MSA draft",
    });
    expect(link).toHaveAttribute("href", "/demo/contracts/contract-recent");
    // The "generated" badge should appear because has_generated_docx is true.
    expect(within(recent).getByText(/generated/)).toBeInTheDocument();

    const signed = screen.getByTestId("section-recent-signed-contracts");
    expect(within(signed).getByText(/signed PDF/)).toBeInTheDocument();
  });

  it("renders empty states when sub-lists are empty without crashing", async () => {
    const empty = {
      ...SAMPLE_SUMMARY,
      upcoming: { requests_due_soon: [], inbox_items_due_soon: [] },
      recent_activity: {
        recent_contracts: [],
        recent_requests: [],
        recent_signed_contracts: [],
      },
    };
    fetchMock.mockResolvedValue(jsonResponse(empty));
    renderPage();

    const upcoming = await screen.findByTestId("section-requests-due-soon");
    expect(
      within(upcoming).getByText(
        /No requests due in the next two weeks/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing in the inbox is due/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No contracts yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No request activity yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No executed contracts yet/i),
    ).toBeInTheDocument();
  });

  it("renders an error message when the API fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
    renderPage();
    expect(
      await screen.findByTestId("dashboard-error"),
    ).toBeInTheDocument();
  });

  it("renders a loading state before the request resolves", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    renderPage();
    expect(screen.getByTestId("dashboard-loading")).toBeInTheDocument();
    resolveFetch(jsonResponse(SAMPLE_SUMMARY));
    await waitFor(() => {
      expect(screen.queryByTestId("dashboard-loading")).toBeNull();
    });
  });

  it("does not surface storage internals in the rendered DOM", async () => {
    // Worst case: the backend regresses and returns secret-shaped fields.
    // The API client's scrub plus the dashboard's compact projections
    // should keep them out of the DOM. We assert against the rendered
    // text rather than the JSON because that's what users actually see.
    const tampered = {
      ...SAMPLE_SUMMARY,
      recent_activity: {
        ...SAMPLE_SUMMARY.recent_activity,
        recent_contracts: [
          {
            ...SAMPLE_SUMMARY.recent_activity.recent_contracts[0],
            // These keys would be stripped by `scrubSecrets` if they
            // ever appeared on the wire — we're double-checking the
            // rendered surface here.
            storage_key: "secret-key",
            wrapped_dek: "secret-dek",
          },
        ],
      },
    };
    fetchMock.mockResolvedValue(jsonResponse(tampered));
    renderPage();
    await screen.findByTestId("dashboard-counts");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("storage_key");
    expect(text).not.toContain("wrapped_dek");
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain("secret-dek");
  });

  // -------------------------------------------------------------------------
  // PR #62 — approval analytics block
  // -------------------------------------------------------------------------

  it("renders the approval analytics tiles from the summary response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SAMPLE_SUMMARY));
    renderPage();
    const block = await screen.findByTestId("dashboard-approval-analytics");
    expect(
      within(block).getByTestId("approval-analytics-pending_steps").textContent,
    ).toContain("4");
    expect(
      within(block).getByTestId("approval-analytics-overdue_steps").textContent,
    ).toContain("1");
    expect(
      within(block).getByTestId("approval-analytics-active_workflows")
        .textContent,
    ).toContain("2");
    expect(
      within(block).getByTestId(
        "approval-analytics-workflows_completed_last_30_days",
      ).textContent,
    ).toContain("3");
    expect(
      within(block).getByTestId(
        "approval-analytics-workflows_rejected_last_30_days",
      ).textContent,
    ).toContain("1");
  });

  it("renders the oldest pending steps with workflow_id deep-links and request_id deep-links", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SAMPLE_SUMMARY));
    renderPage();
    const list = await screen.findByTestId("section-oldest-pending-steps");
    const rows = within(list).getAllByTestId("approval-analytics-oldest-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Legal review");
    expect(rows[0]).toHaveTextContent("Alice Counsel");
    expect(rows[0]).toHaveTextContent("step 1");
    expect(rows[0]).toHaveTextContent("due 2026-05-01");
    // Workflow link uses the PR #61 deep-link query string.
    const workflowLinks = within(list).getAllByTestId(
      "approval-analytics-workflow-link",
    );
    expect(workflowLinks[0]).toHaveAttribute(
      "href",
      "/demo/approvals?workflow_id=wf-blocked",
    );
    // The first row also exposes a request_id deep-link.
    expect(
      within(rows[0]).getByTestId("approval-analytics-request-link"),
    ).toHaveAttribute("href", "/demo/requests?request_id=req-blocked");
    // The second row has no request_id and renders no request link, and
    // surfaces "no due date" + "Unassigned" guard rails.
    expect(rows[1]).toHaveTextContent("Unassigned");
    expect(rows[1]).toHaveTextContent("no due date");
    expect(
      within(rows[1]).queryByTestId("approval-analytics-request-link"),
    ).toBeNull();
  });

  it("renders pending_by_assignee buckets with overdue subset and an Unassigned row", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SAMPLE_SUMMARY));
    renderPage();
    const list = await screen.findByTestId("section-pending-by-assignee");
    const rows = within(list).getAllByTestId(
      "approval-analytics-assignee-row",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("user-alice");
    expect(rows[0]).toHaveTextContent("3 pending");
    expect(rows[0]).toHaveTextContent("1 overdue");
    expect(rows[1]).toHaveTextContent("Unassigned");
    expect(rows[1]).toHaveTextContent("1 pending");
    // Bucket with 0 overdue should not surface "0 overdue" copy.
    expect(rows[1]).not.toHaveTextContent("overdue");
  });

  it("renders empty state for approval analytics when there are no pending steps", async () => {
    const emptyAnalytics = {
      ...SAMPLE_SUMMARY,
      approval_analytics: {
        ...SAMPLE_SUMMARY.approval_analytics,
        pending_steps: 0,
        overdue_steps: 0,
        active_workflows: 0,
        pending_by_assignee: [],
        oldest_pending_steps: [],
      },
    };
    fetchMock.mockResolvedValue(jsonResponse(emptyAnalytics));
    renderPage();
    await screen.findByTestId("dashboard-approval-analytics");
    expect(
      within(screen.getByTestId("section-oldest-pending-steps")).getByText(
        /No pending approval steps/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("section-pending-by-assignee")).getByText(
        /No pending approval steps/i,
      ),
    ).toBeInTheDocument();
  });

  it("does not render approver_email or signer PII on the analytics surface", async () => {
    // Even if a regressed backend started returning approver_email or
    // similar PII keys on the wire, the typed surface drops them and
    // the rendered DOM should remain clean.
    const tampered = {
      ...SAMPLE_SUMMARY,
      approval_analytics: {
        ...SAMPLE_SUMMARY.approval_analytics,
        oldest_pending_steps: [
          {
            ...SAMPLE_SUMMARY.approval_analytics.oldest_pending_steps[0],
            approver_email: "alice@example.com",
            decision_note: "Internal note that should not leak",
          },
        ],
      },
    };
    fetchMock.mockResolvedValue(jsonResponse(tampered));
    renderPage();
    await screen.findByTestId("dashboard-approval-analytics");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("Internal note that should not leak");
    expect(text).not.toContain("storage_key");
    expect(text).not.toContain("wrapped_dek");
  });
});
