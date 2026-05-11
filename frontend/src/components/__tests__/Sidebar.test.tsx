import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Sidebar from "../Sidebar";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

describe("Sidebar", () => {
  function renderSidebar() {
    render(
      <MemoryRouter>
        <Sidebar isOpen={false} onClose={() => {}} />
      </MemoryRouter>,
    );
  }

  function linksFor(label: string): HTMLElement[] {
    return screen.queryAllByRole("link", { name: label });
  }

  it("renders the consolidated top-level navigation", () => {
    renderSidebar();
    const expected: { label: string; href: string }[] = [
      { label: "Dashboard", href: "/demo/dashboard" },
      { label: "Repository", href: "/demo/repository" },
      { label: "Requests", href: "/demo/requests" },
      { label: "Playbooks", href: "/demo/playbooks" },
      { label: "Clause Manager", href: "/demo/clause-manager" },
      { label: "Approvals", href: "/demo/approvals" },
      { label: "Settings", href: "/demo/settings" },
    ];
    for (const { label, href } of expected) {
      const matching = linksFor(label).filter(
        (el) => el.getAttribute("href") === href,
      );
      expect(matching.length, `expected sidebar link ${label} -> ${href}`).toBeGreaterThan(0);
    }
  });

  it("does not surface former sub-surfaces as top-level entries", () => {
    renderSidebar();
    // These used to be top-level sidebar items. They now live under
    // their respective workspaces (Requests, Approvals, Repository).
    for (const label of [
      "Contracts",
      "Agreement Templates",
      "Approval Workflows",
      "Approval Templates",
      "Approval Policies",
      "Inbox",
      "Upload",
      "Clause Library",
    ]) {
      expect(linksFor(label)).toHaveLength(0);
    }
  });

  // -------------------------------------------------------------------------
  // Legacy-alias active highlighting
  //
  // The sidebar uses a single source of truth (NAV_EXTRA_MATCHES) to keep
  // the right top-level entry highlighted when the user is on a legacy
  // alias or workspace sub-page. The tests below pin that behavior so
  // existing deep links from PR #60/#61 keep visually announcing the
  // right top-level location.
  // -------------------------------------------------------------------------

  function someLinkIsActive(label: string): boolean {
    // The active class is applied via NavLink's className callback; the
    // bg-canvas-muted + font-medium pair is unique to the active state
    // in this component. Either the desktop or mobile sidebar list can
    // satisfy the assertion — both render the same NavList.
    return linksFor(label).some((el) =>
      el.className.includes("font-medium"),
    );
  }

  const ALIAS_MATCHES: { path: string; activeLabel: string }[] = [
    { path: "/demo/contracts", activeLabel: "Repository" },
    { path: "/demo/contracts/abc-123", activeLabel: "Repository" },
    { path: "/demo/upload", activeLabel: "Repository" },
    { path: "/demo/clause-library", activeLabel: "Clause Manager" },
    { path: "/demo/agreement-templates", activeLabel: "Requests" },
    { path: "/demo/agreement-templates/tmpl-1", activeLabel: "Requests" },
    { path: "/demo/requests/templates", activeLabel: "Requests" },
    { path: "/demo/inbox", activeLabel: "Approvals" },
    { path: "/demo/approval-workflows", activeLabel: "Approvals" },
    { path: "/demo/approval-templates", activeLabel: "Approvals" },
    { path: "/demo/approval-policies", activeLabel: "Approvals" },
  ];

  for (const { path, activeLabel } of ALIAS_MATCHES) {
    it(`highlights ${activeLabel} when the user is on ${path}`, () => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <Sidebar isOpen={false} onClose={() => {}} />
        </MemoryRouter>,
      );
      expect(
        someLinkIsActive(activeLabel),
        `expected ${activeLabel} highlighted on ${path}`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// PR #86 — overdue badges sourced from the dashboard summary
// ---------------------------------------------------------------------------

const DEV_USER = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function summaryWithOverdueSteps(count: number) {
  return {
    counts: {
      open_requests: 0,
      in_progress_requests: 0,
      urgent_or_high_priority_requests: 0,
      open_inbox_items: 0,
      overdue_inbox_items: 0,
      contracts_total: 0,
      contracts_sent_for_signature: 0,
      contracts_executed: 0,
      templates_active: 0,
      active_approval_workflows: 0,
      pending_approval_steps: 0,
      overdue_approval_steps: count,
      active_approval_workflow_templates: 0,
    },
    upcoming: { requests_due_soon: [], inbox_items_due_soon: [] },
    recent_activity: {
      recent_contracts: [],
      recent_requests: [],
      recent_signed_contracts: [],
    },
    approval_analytics: {
      pending_steps: 0,
      overdue_steps: 0,
      active_workflows: 0,
      completed_workflows: 0,
      rejected_workflows: 0,
      cancelled_workflows: 0,
      workflows_completed_last_30_days: 0,
      workflows_rejected_last_30_days: 0,
      pending_by_assignee: [],
      oldest_pending_steps: [],
    },
  };
}

describe("Sidebar overdue badges (PR #86)", () => {
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

  function renderSidebar() {
    render(
      <MemoryRouter>
        <Sidebar isOpen={false} onClose={() => {}} />
      </MemoryRouter>,
    );
  }

  it("renders an overdue badge next to Approvals when overdue_approval_steps > 0", async () => {
    fetchMock.mockResolvedValue(jsonResponse(summaryWithOverdueSteps(3)));
    renderSidebar();
    // Both desktop + mobile NavLists render — there should be two
    // badges (one per list), both showing the same count.
    const badges = await screen.findAllByTestId("sidebar-overdue-badge");
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge).toHaveTextContent("3");
      expect(badge).toHaveAttribute(
        "aria-label",
        expect.stringMatching(/3 overdue approval steps/i),
      );
    }
  });

  it("uses the singular form in the aria-label when only one step is overdue", async () => {
    fetchMock.mockResolvedValue(jsonResponse(summaryWithOverdueSteps(1)));
    renderSidebar();
    const badges = await screen.findAllByTestId("sidebar-overdue-badge");
    expect(badges[0]).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/1 overdue approval step$/i),
    );
  });

  it("does not render a badge when there are no overdue approval steps", async () => {
    fetchMock.mockResolvedValue(jsonResponse(summaryWithOverdueSteps(0)));
    renderSidebar();
    // Wait for the fetch to resolve before asserting absence.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("sidebar-overdue-badge")).toBeNull();
  });

  it("still renders the navigation when the summary fetch fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
    renderSidebar();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Nav links still render — fetch failure must never blow up the
    // sidebar shell.
    const matching = screen
      .queryAllByRole("link", { name: "Approvals" })
      .filter((el) => el.getAttribute("href") === "/demo/approvals");
    expect(matching.length).toBeGreaterThan(0);
    expect(screen.queryByTestId("sidebar-overdue-badge")).toBeNull();
  });

  it("does not surface storage internals through the summary payload", async () => {
    // Defense-in-depth: even if a regressed backend included secret
    // keys on the wire, none should make it to the sidebar DOM.
    fetchMock.mockResolvedValue(
      jsonResponse({
        ...summaryWithOverdueSteps(2),
        recent_activity: {
          recent_contracts: [
            {
              id: "c-1",
              title: "x",
              status: "ready",
              created_at: "2026-05-01",
              updated_at: "2026-05-01",
              docuseal_submission_id: null,
              has_generated_docx: false,
              has_signed_pdf: false,
              storage_key: "should-not-appear",
              wrapped_dek: "should-not-appear",
            },
          ],
          recent_requests: [],
          recent_signed_contracts: [],
        },
      }),
    );
    renderSidebar();
    await screen.findAllByTestId("sidebar-overdue-badge");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("storage_key");
    expect(text).not.toContain("wrapped_dek");
    expect(text).not.toContain("should-not-appear");
  });
});
