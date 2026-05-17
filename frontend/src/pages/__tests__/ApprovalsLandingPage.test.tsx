import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ApprovalsLandingPage from "../ApprovalsLandingPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const COUNTS_FIXTURE = {
  open_requests: 0,
  in_progress_requests: 0,
  urgent_or_high_priority_requests: 0,
  open_inbox_items: 0,
  overdue_inbox_items: 0,
  contracts_total: 0,
  contracts_sent_for_signature: 0,
  contracts_executed: 0,
  templates_active: 0,
  active_approval_workflows: 4,
  pending_approval_steps: 7,
  overdue_approval_steps: 2,
  active_approval_workflow_templates: 3,
};

const SUMMARY_FIXTURE = {
  counts: COUNTS_FIXTURE,
  upcoming: { requests_due_soon: [], inbox_items_due_soon: [] },
  recent_activity: {
    recent_contracts: [],
    recent_requests: [],
    recent_signed_contracts: [],
  },
  approval_analytics: {
    pending_steps: 7,
    overdue_steps: 2,
    active_workflows: 4,
    completed_workflows: 0,
    rejected_workflows: 0,
    cancelled_workflows: 0,
    workflows_completed_last_30_days: 0,
    workflows_rejected_last_30_days: 0,
    pending_by_assignee: [],
    oldest_pending_steps: [],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApprovalsLandingPage", () => {
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

  function renderPage() {
    render(
      <MemoryRouter initialEntries={["/demo/approvals"]}>
        <ApprovalsLandingPage />
      </MemoryRouter>,
    );
  }

  it("renders inside the approvals-landing data-testid wrapper", async () => {
    // Heading + intro copy now live in ApprovalsHubLayout; the landing
    // page is the Overview tab body and renders only the card grid.
    // See ApprovalsHubLayout.test.tsx for the heading assertion.
    fetchMock.mockResolvedValue(jsonResponse(SUMMARY_FIXTURE));
    renderPage();
    expect(screen.getByTestId("approvals-landing")).toBeInTheDocument();
  });

  it("renders cards for tasks, workflows, templates, and policies with correct hrefs", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SUMMARY_FIXTURE));
    renderPage();
    const expectations: { testId: string; href: string; label: RegExp }[] = [
      {
        testId: "approvals-card-tasks",
        href: "/demo/approvals/tasks",
        label: /approval tasks/i,
      },
      {
        testId: "approvals-card-workflows",
        href: "/demo/approvals/workflows",
        label: /approval workflows/i,
      },
      {
        testId: "approvals-card-templates",
        href: "/demo/approvals/templates",
        label: /approval templates/i,
      },
      {
        testId: "approvals-card-policies",
        href: "/demo/approvals/policies",
        label: /approval policies/i,
      },
    ];
    for (const { testId, href, label } of expectations) {
      const card = screen.getByTestId(testId);
      expect(card).toHaveAttribute("href", href);
      expect(card.textContent ?? "").toMatch(label);
    }
  });

  it("renders live counts on the cards once the summary loads", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SUMMARY_FIXTURE));
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("approvals-card-tasks-count")).toHaveTextContent(
        "7",
      ),
    );
    expect(
      screen.getByTestId("approvals-card-workflows-count"),
    ).toHaveTextContent("4");
    expect(
      screen.getByTestId("approvals-card-templates-count"),
    ).toHaveTextContent("3");
    // Policies has no headline count yet — see ApprovalsLandingPage rationale.
    expect(screen.queryByTestId("approvals-card-policies-count")).toBeNull();
  });

  it("flags overdue approval steps on the tasks card when present", async () => {
    fetchMock.mockResolvedValue(jsonResponse(SUMMARY_FIXTURE));
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByTestId("approvals-card-tasks-secondary"),
      ).toHaveTextContent(/2 overdue/i),
    );
  });

  it("hides the overdue subline when no approval steps are overdue", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ...SUMMARY_FIXTURE,
        counts: { ...COUNTS_FIXTURE, overdue_approval_steps: 0 },
      }),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("approvals-card-tasks-count")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("approvals-card-tasks-secondary")).toBeNull();
  });

  it("renders cards without counts when the summary endpoint fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
    renderPage();
    // Cards should still render and navigation should still work.
    expect(screen.getByTestId("approvals-card-tasks")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId("approvals-card-tasks-count")).toBeNull(),
    );
  });
});
