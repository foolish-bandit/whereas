import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import ApprovalsLandingPage from "../ApprovalsLandingPage";

describe("ApprovalsLandingPage", () => {
  function renderPage() {
    render(
      <MemoryRouter initialEntries={["/demo/approvals"]}>
        <ApprovalsLandingPage />
      </MemoryRouter>,
    );
  }

  it("renders the Approvals heading and intro copy", () => {
    renderPage();
    expect(
      screen.getByRole("heading", { name: /approvals/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it("renders cards for tasks, workflows, templates, and policies with correct hrefs", () => {
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
});
