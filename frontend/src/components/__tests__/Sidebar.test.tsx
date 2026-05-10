import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import Sidebar from "../Sidebar";

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
