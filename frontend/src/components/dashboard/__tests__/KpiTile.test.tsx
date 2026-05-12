import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import KpiTile from "../KpiTile";
import TrendIndicator from "../TrendIndicator";

describe("KpiTile", () => {
  it("renders label, value, description, and applies tabular-nums to the value", () => {
    render(
      <MemoryRouter>
        <KpiTile label="Open requests" value={42} description="Status open" />
      </MemoryRouter>,
    );
    expect(screen.getByText("Open requests")).toBeInTheDocument();
    const value = screen.getByText("42");
    expect(value).toBeInTheDocument();
    expect(value.className).toContain("tabular-nums");
    expect(value.className).toContain("text-3xl");
    expect(value.className).toContain("font-semibold");
    expect(screen.getByText("Status open")).toBeInTheDocument();
  });

  it("renders as a link when `to` is provided", () => {
    render(
      <MemoryRouter>
        <KpiTile label="X" value={1} to="/demo/requests" testId="t" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("t").tagName).toBe("A");
  });

  it("uses the danger token for value text when danger=true", () => {
    render(
      <MemoryRouter>
        <KpiTile label="Overdue" value={3} danger />
      </MemoryRouter>,
    );
    expect(screen.getByText("3").className).toContain("text-danger");
  });

  it("renders the trend indicator when provided", () => {
    render(
      <MemoryRouter>
        <KpiTile
          label="Executed"
          value={9}
          trend={{ pct: 12 }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/12%/)).toBeInTheDocument();
    expect(screen.getByText(/vs\. last 30 days/)).toBeInTheDocument();
  });
});

describe("TrendIndicator", () => {
  it("renders an up arrow + green for positive deltas by default", () => {
    render(<TrendIndicator delta={{ pct: 12 }} />);
    const node = screen.getByText(/12%/);
    expect(node.className).toContain("text-success");
    expect(node.textContent).toContain("↑");
  });

  it("renders a down arrow + red for negative deltas by default", () => {
    render(<TrendIndicator delta={{ pct: -7 }} />);
    const node = screen.getByText(/7%/);
    expect(node.className).toContain("text-danger");
    expect(node.textContent).toContain("↓");
  });

  it("invert flips the color so a negative delta on overdue counts is good", () => {
    render(<TrendIndicator delta={{ pct: -3, invert: true }} />);
    expect(screen.getByText(/3%/).className).toContain("text-success");
  });

  it("supports a custom caption", () => {
    render(
      <TrendIndicator delta={{ pct: 5, caption: "vs. last quarter" }} />,
    );
    expect(screen.getByText(/vs\. last quarter/)).toBeInTheDocument();
  });
});
