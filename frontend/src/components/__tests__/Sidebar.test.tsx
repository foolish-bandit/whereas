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

  it("includes a Dashboard nav entry pointing to the demo dashboard route", () => {
    renderSidebar();
    const dashboardLinks = screen
      .getAllByRole("link", { name: "Dashboard" })
      .filter((el) => el.getAttribute("href") === "/demo/dashboard");
    expect(dashboardLinks.length).toBeGreaterThan(0);
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

  it("includes an Approval Policies nav entry pointing to the demo route", () => {
    renderSidebar();
    const links = screen
      .getAllByRole("link", { name: "Approval Policies" })
      .filter((el) => el.getAttribute("href") === "/demo/approval-policies");
    expect(links.length).toBeGreaterThan(0);
  });
});
