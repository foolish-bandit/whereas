import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import Sidebar from "../Sidebar";

/**
 * The sidebar is the only place that hard-codes the demo nav order, so
 * a test here doubles as a visual regression guard: a missing or
 * reordered entry shows up in the diff.
 */
describe("Sidebar", () => {
  function renderSidebar() {
    render(
      <MemoryRouter>
        <Sidebar isOpen={false} onClose={() => {}} />
      </MemoryRouter>,
    );
  }

  it("includes a Dashboard nav entry pointing to the demo dashboard route", () => {
    renderSidebar();
    // Two copies render (desktop sidebar + mobile drawer); we just
    // need at least one to point at the right path.
    const dashboardLinks = screen
      .getAllByRole("link", { name: "Dashboard" })
      .filter((el) => el.getAttribute("href") === "/demo/dashboard");
    expect(dashboardLinks.length).toBeGreaterThan(0);
  });

  it("renders the Dashboard entry above the other CLM surfaces", () => {
    renderSidebar();
    // Assert against just the desktop sidebar copy to avoid duplicate
    // matches between the desktop nav and the mobile drawer.
    const navs = screen.getAllByRole("link");
    const desktopOrder = navs
      .filter((el) =>
        ["Dashboard", "Inbox", "Requests", "Approvals", "Contracts"].includes(
          el.textContent ?? "",
        ),
      )
      .map((el) => el.textContent);
    // The first five CLM-surface entries should appear in this order
    // (each appears twice: once in the desktop sidebar, once in the
    // mobile drawer).
    expect(desktopOrder.slice(0, 5)).toEqual([
      "Dashboard",
      "Inbox",
      "Requests",
      "Approvals",
      "Contracts",
    ]);
  });

  it("includes an Approvals nav entry pointing to the demo approvals route", () => {
    renderSidebar();
    const approvalLinks = screen
      .getAllByRole("link", { name: "Approvals" })
      .filter((el) => el.getAttribute("href") === "/demo/approvals");
    expect(approvalLinks.length).toBeGreaterThan(0);
  });

  it("includes an Approval Templates nav entry pointing to the demo approval-templates route", () => {
    renderSidebar();
    const links = screen
      .getAllByRole("link", { name: "Approval Templates" })
      .filter((el) => el.getAttribute("href") === "/demo/approval-templates");
    expect(links.length).toBeGreaterThan(0);
  });
});
