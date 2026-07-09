import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import ConfidenceBadge from "../ConfidenceBadge";

describe("ConfidenceBadge", () => {
  it("renders a success-toned 'High' badge at the high-tier boundary (0.8)", () => {
    render(<ConfidenceBadge confidence={0.8} data-testid="badge" />);
    const badge = screen.getByTestId("badge");
    expect(badge).toHaveTextContent(/high/i);
    expect(badge).toHaveTextContent(/80%/);
    expect(badge.className).toContain("success");
  });

  it("renders a warning-toned 'Medium' badge at the medium-tier boundary (0.5)", () => {
    render(<ConfidenceBadge confidence={0.5} data-testid="badge" />);
    const badge = screen.getByTestId("badge");
    expect(badge).toHaveTextContent(/medium/i);
    expect(badge).toHaveTextContent(/50%/);
    expect(badge.className).toContain("warning");
  });

  it("renders a warning-toned 'Medium' badge just below the high-tier boundary", () => {
    render(<ConfidenceBadge confidence={0.79} data-testid="badge" />);
    const badge = screen.getByTestId("badge");
    expect(badge).toHaveTextContent(/medium/i);
    expect(badge.className).toContain("warning");
  });

  it("renders a danger-toned 'Low' badge just below the medium-tier boundary", () => {
    render(<ConfidenceBadge confidence={0.49} data-testid="badge" />);
    const badge = screen.getByTestId("badge");
    expect(badge).toHaveTextContent(/low/i);
    expect(badge.className).toContain("danger");
  });

  it("renders a danger-toned 'Low' badge for confidence 0", () => {
    render(<ConfidenceBadge confidence={0} data-testid="badge" />);
    const badge = screen.getByTestId("badge");
    expect(badge).toHaveTextContent(/low/i);
    expect(badge).toHaveTextContent(/0%/);
    expect(badge.className).toContain("danger");
  });

  it("renders an em-dash and a low/danger badge for non-finite confidence", () => {
    render(<ConfidenceBadge confidence={NaN} data-testid="badge" />);
    const badge = screen.getByTestId("badge");
    expect(badge).toHaveTextContent(/low/i);
    expect(badge).toHaveTextContent("—");
    expect(badge.className).toContain("danger");
  });

  it("rounds the displayed percentage", () => {
    render(<ConfidenceBadge confidence={0.965} data-testid="badge" />);
    expect(screen.getByTestId("badge")).toHaveTextContent(/97%/);
  });

  it("sets a title with the model confidence percentage", () => {
    render(<ConfidenceBadge confidence={0.96} data-testid="badge" />);
    expect(screen.getByTestId("badge")).toHaveAttribute(
      "title",
      "Model confidence 96%",
    );
  });
});
