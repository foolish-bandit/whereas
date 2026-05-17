import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import ApprovalsHubLayout from "../ApprovalsHubLayout";

/**
 * The hub layout tests cover the visible frame the user sees on every
 * /approvals/* page: the title, the intro copy, and the tab bar. Tab
 * content is tested in each tab's own page test; here we only verify
 * which tab is rendered as active for each route.
 *
 * Renders a stripped-down route tree so the layout's <Outlet /> has
 * something to mount — keeps the tests focused on the hub itself.
 */

function renderHub(initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/demo/approvals" element={<ApprovalsHubLayout />}>
          <Route index element={<div data-testid="stub-overview" />} />
          <Route path="tasks" element={<div data-testid="stub-tasks" />} />
          <Route
            path="workflows"
            element={<div data-testid="stub-workflows" />}
          />
          <Route
            path="templates"
            element={<div data-testid="stub-templates" />}
          />
          <Route
            path="policies"
            element={<div data-testid="stub-policies" />}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("ApprovalsHubLayout", () => {
  it("renders the Approvals heading and intro copy", () => {
    renderHub("/demo/approvals");
    expect(
      screen.getByRole("heading", { name: /^approvals$/i, level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Manage approval work in one place/i),
    ).toBeInTheDocument();
  });

  it("renders all five tabs with hrefs into the demo namespace", () => {
    renderHub("/demo/approvals");
    const tabs = screen.getByTestId("approvals-hub-tabs");
    const expectations: { testId: string; href: string; label: RegExp }[] = [
      {
        testId: "approvals-hub-tab-overview",
        href: "/demo/approvals",
        label: /overview/i,
      },
      {
        testId: "approvals-hub-tab-tasks",
        href: "/demo/approvals/tasks",
        label: /tasks/i,
      },
      {
        testId: "approvals-hub-tab-workflows",
        href: "/demo/approvals/workflows",
        label: /workflows/i,
      },
      {
        testId: "approvals-hub-tab-templates",
        href: "/demo/approvals/templates",
        label: /templates/i,
      },
      {
        testId: "approvals-hub-tab-policies",
        href: "/demo/approvals/policies",
        label: /policies/i,
      },
    ];
    for (const { testId, href, label } of expectations) {
      const tab = within(tabs).getByTestId(testId);
      expect(tab).toHaveAttribute("href", href);
      expect(tab.textContent ?? "").toMatch(label);
    }
  });

  it.each([
    { path: "/demo/approvals", active: "approvals-hub-tab-overview" },
    { path: "/demo/approvals/tasks", active: "approvals-hub-tab-tasks" },
    {
      path: "/demo/approvals/workflows",
      active: "approvals-hub-tab-workflows",
    },
    {
      path: "/demo/approvals/templates",
      active: "approvals-hub-tab-templates",
    },
    {
      path: "/demo/approvals/policies",
      active: "approvals-hub-tab-policies",
    },
  ])(
    "marks the active tab for %j",
    ({ path, active }) => {
      renderHub(path);
      const tab = screen.getByTestId(active);
      expect(tab).toHaveAttribute("aria-current", "page");
      // Other tabs should not be active.
      for (const otherId of [
        "approvals-hub-tab-overview",
        "approvals-hub-tab-tasks",
        "approvals-hub-tab-workflows",
        "approvals-hub-tab-templates",
        "approvals-hub-tab-policies",
      ]) {
        if (otherId === active) continue;
        expect(screen.getByTestId(otherId)).not.toHaveAttribute(
          "aria-current",
          "page",
        );
      }
    },
  );

  it("keeps the Overview tab from staying active on /tasks (end-match)", () => {
    // Without `end` on the Overview NavLink, /approvals/tasks would
    // match /approvals as a prefix and both tabs would render active.
    renderHub("/demo/approvals/tasks");
    expect(screen.getByTestId("approvals-hub-tab-overview")).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders the routed child via Outlet", () => {
    renderHub("/demo/approvals/templates");
    expect(screen.getByTestId("stub-templates")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-tasks")).toBeNull();
  });
});
