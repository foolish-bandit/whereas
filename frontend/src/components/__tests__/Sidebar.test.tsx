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
});
