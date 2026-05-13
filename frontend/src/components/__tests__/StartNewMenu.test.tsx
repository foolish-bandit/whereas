import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import StartNewMenu from "../StartNewMenu";

function renderMenu(initialPath = "/demo/dashboard") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <StartNewMenu />
    </MemoryRouter>,
  );
}

describe("StartNewMenu", () => {
  it("renders a 'Start new' trigger button", () => {
    renderMenu();
    expect(screen.getByTestId("start-new-trigger")).toHaveTextContent(
      "Start new",
    );
  });

  it("menu is closed by default", () => {
    renderMenu();
    expect(screen.queryByTestId("start-new-menu")).not.toBeInTheDocument();
  });

  it("opens on click", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    expect(screen.getByTestId("start-new-menu")).toBeInTheDocument();
  });

  it("toggles closed when trigger is clicked again", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    expect(screen.queryByTestId("start-new-menu")).not.toBeInTheDocument();
  });

  it("closes on Escape keydown", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    expect(screen.getByTestId("start-new-menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("start-new-menu")).not.toBeInTheDocument();
  });

  it("closes on mousedown outside the menu", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    expect(screen.getByTestId("start-new-menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("start-new-menu")).not.toBeInTheDocument();
  });

  it("renders all seven menu items with labels", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    for (const label of [
      "Upload to Repository",
      "Start Request",
      "Start from Agreement Template",
      "Open Inbox Intake",
      "View Approval Tasks",
      "Add Playbook Rule",
      "Add Clause",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("each menu item includes helper text", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    for (const hint of [
      "Add a signed contract or document",
      "Kick off a new contract request",
      "Use a saved template to draft faster",
      "Process an incoming contract",
      "See contracts awaiting your review",
      "Define a new deviation check",
      "Extend the clause library",
    ]) {
      expect(screen.getByText(hint)).toBeInTheDocument();
    }
  });

  it("closes when a menu item is clicked", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    fireEvent.click(screen.getByTestId("start-new-upload"));
    expect(screen.queryByTestId("start-new-menu")).not.toBeInTheDocument();
  });

  it("links resolve to /demo/* when under /demo", () => {
    renderMenu("/demo/dashboard");
    fireEvent.click(screen.getByTestId("start-new-trigger"));

    const cases: [string, string][] = [
      ["start-new-upload", "/demo/upload"],
      ["start-new-start-request", "/demo/requests#new-request"],
      [
        "start-new-start-from-agreement-template",
        "/demo/requests/templates",
      ],
      ["start-new-open-inbox-intake", "/demo/inbox"],
      ["start-new-view-approval-tasks", "/demo/approvals/tasks"],
      ["start-new-add-playbook-rule", "/demo/playbooks"],
      ["start-new-add-clause", "/demo/clause-manager"],
    ];

    for (const [testId, href] of cases) {
      expect(screen.getByTestId(testId)).toHaveAttribute("href", href);
    }
  });

  it("links resolve to bare paths when not under /demo", () => {
    renderMenu("/repository");
    fireEvent.click(screen.getByTestId("start-new-trigger"));

    const cases: [string, string][] = [
      ["start-new-upload", "/upload"],
      ["start-new-start-request", "/requests#new-request"],
      [
        "start-new-start-from-agreement-template",
        "/requests/templates",
      ],
      ["start-new-open-inbox-intake", "/inbox"],
      ["start-new-view-approval-tasks", "/approvals/tasks"],
      ["start-new-add-playbook-rule", "/playbooks"],
      ["start-new-add-clause", "/clause-manager"],
    ];

    for (const [testId, href] of cases) {
      expect(screen.getByTestId(testId)).toHaveAttribute("href", href);
    }
  });

  it("trigger has correct ARIA attributes", () => {
    renderMenu();
    const trigger = screen.getByTestId("start-new-trigger");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});
