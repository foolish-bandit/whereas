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

  it("renders all four core menu items with labels", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    for (const label of [
      "New Request",
      "Upload to Repository",
      "Start from Agreement Template",
      "Open Intake",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("does not surface secondary actions like Playbooks or Clause Manager", () => {
    // These are still reachable from the sidebar; the Start New menu
    // stays focused on the four ways to begin a new piece of work.
    renderMenu();
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    for (const label of [
      "View Approval Tasks",
      "Add Playbook Rule",
      "Add Clause",
    ]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("each menu item includes helper text", () => {
    renderMenu();
    fireEvent.click(screen.getByTestId("start-new-trigger"));
    for (const hint of [
      "Kick off a new contract request",
      "Add a signed Repository record or document",
      "Use a saved template to draft faster",
      "Pick how to bring a contract into Whereas",
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
      ["start-new-new-request", "/demo/requests#new-request"],
      ["start-new-upload", "/demo/upload"],
      [
        "start-new-start-from-agreement-template",
        "/demo/requests/templates",
      ],
      ["start-new-open-intake", "/demo/intake"],
    ];

    for (const [testId, href] of cases) {
      expect(screen.getByTestId(testId)).toHaveAttribute("href", href);
    }
  });

  it("links resolve to bare paths when not under /demo", () => {
    renderMenu("/repository");
    fireEvent.click(screen.getByTestId("start-new-trigger"));

    const cases: [string, string][] = [
      ["start-new-new-request", "/requests#new-request"],
      ["start-new-upload", "/upload"],
      [
        "start-new-start-from-agreement-template",
        "/requests/templates",
      ],
      ["start-new-open-intake", "/intake"],
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
