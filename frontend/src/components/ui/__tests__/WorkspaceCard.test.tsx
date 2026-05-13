import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import WorkspaceCard from "../WorkspaceCard";

function withRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("WorkspaceCard", () => {
  it("renders title and description", () => {
    withRouter(
      <WorkspaceCard to="/foo" title="My Card" description="A brief hint." />,
    );
    expect(screen.getByText("My Card")).toBeInTheDocument();
    expect(screen.getByText("A brief hint.")).toBeInTheDocument();
  });

  it("renders as a Link when to is provided", () => {
    withRouter(
      <WorkspaceCard to="/requests" title="Go to requests" testId="card-link" />,
    );
    expect(screen.getByTestId("card-link")).toHaveAttribute(
      "href",
      "/requests",
    );
  });

  it("renders as an anchor when href is provided", () => {
    withRouter(
      <WorkspaceCard href="#section" title="Jump to section" testId="card-anchor" />,
    );
    const el = screen.getByTestId("card-anchor");
    expect(el.tagName).toBe("A");
    expect(el).toHaveAttribute("href", "#section");
  });

  it("renders as a button when onClick is provided", () => {
    const handleClick = vi.fn();
    withRouter(
      <WorkspaceCard onClick={handleClick} title="Do action" testId="card-btn" />,
    );
    const el = screen.getByTestId("card-btn");
    expect(el.tagName).toBe("BUTTON");
  });

  it("applies primary variant classes by default", () => {
    withRouter(<WorkspaceCard to="/x" title="Primary" testId="card-primary" />);
    expect(screen.getByTestId("card-primary").className).toContain("bg-canvas");
  });

  it("applies default variant classes when specified", () => {
    withRouter(
      <WorkspaceCard
        to="/x"
        title="Default"
        variant="default"
        testId="card-default"
      />,
    );
    expect(screen.getByTestId("card-default").className).toContain(
      "bg-canvas-subtle",
    );
  });
});
