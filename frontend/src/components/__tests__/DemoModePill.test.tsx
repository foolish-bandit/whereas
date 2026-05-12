import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import DemoModePill from "../DemoModePill";

function renderPill() {
  return render(
    <MemoryRouter>
      <DemoModePill />
    </MemoryRouter>,
  );
}

describe("DemoModePill", () => {
  it("renders the pill button with the demo-mode label", () => {
    renderPill();
    const pill = screen.getByTestId("demo-mode-pill");
    expect(pill).toHaveTextContent(/demo mode/i);
    expect(pill.getAttribute("title")).toMatch(/sample data/i);
  });

  it("clicking the pill opens a popover with banner content + links", () => {
    renderPill();
    fireEvent.click(screen.getByTestId("demo-mode-pill"));
    const popover = screen.getByTestId("demo-mode-pill-popover");
    expect(popover).toHaveTextContent(/sample data/i);
    expect(
      screen.getByTestId("demo-mode-pill-known-limitations"),
    ).toHaveAttribute("href", "/demo/known-limitations");
    expect(screen.getByTestId("demo-mode-pill-view-source")).toHaveAttribute(
      "href",
      expect.stringMatching(/github\.com/),
    );
  });

  it("clicking outside the popover closes it", () => {
    renderPill();
    fireEvent.click(screen.getByTestId("demo-mode-pill"));
    expect(screen.getByTestId("demo-mode-pill-popover")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("demo-mode-pill-popover")).toBeNull();
  });
});
