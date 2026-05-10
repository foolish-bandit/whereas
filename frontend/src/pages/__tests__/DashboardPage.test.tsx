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
});
