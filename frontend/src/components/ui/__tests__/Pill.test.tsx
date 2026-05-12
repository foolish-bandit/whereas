import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import Pill from "../Pill";
import SeverityTag from "../SeverityTag";
import { statusToPill } from "../../../lib/contract-status";

describe("Pill", () => {
  it("renders children and applies the soft tone classes by default", () => {
    render(<Pill tone="success">Ready</Pill>);
    const el = screen.getByText("Ready");
    expect(el.className).toContain("rounded-full");
    expect(el.className).toContain("bg-success-soft");
    expect(el.className).toContain("text-success");
  });

  it("supports solid and outline variants", () => {
    const { rerender } = render(
      <Pill tone="danger" variant="solid">
        Stop
      </Pill>,
    );
    expect(screen.getByText("Stop").className).toContain("bg-danger");
    rerender(
      <Pill tone="info" variant="outline">
        Info
      </Pill>,
    );
    expect(screen.getByText("Info").className).toContain("border-info-ring");
  });

  it("forwards arbitrary span attributes like data-testid", () => {
    render(
      <Pill tone="warning" data-testid="x">
        Warn
      </Pill>,
    );
    expect(screen.getByTestId("x")).toHaveTextContent("Warn");
  });
});

describe("SeverityTag", () => {
  it("defaults its label to the uppercased level", () => {
    render(<SeverityTag level="high" />);
    expect(screen.getByText("HIGH")).toBeInTheDocument();
  });

  it("renders the rounded-md primitive and the right tone for blocker", () => {
    render(<SeverityTag level="blocker" />);
    const el = screen.getByText("BLOCKER");
    expect(el.className).toContain("rounded-md");
    expect(el.className).toContain("uppercase");
    expect(el.className).toContain("bg-danger-soft");
  });

  it("adds a border on overdue to distinguish it visually", () => {
    render(<SeverityTag level="overdue" />);
    expect(screen.getByText("OVERDUE").className).toContain("border");
  });
});

describe("statusToPill", () => {
  it("maps known statuses consistently", () => {
    expect(statusToPill("sent_for_signature")).toEqual({
      label: "Sent for signature",
      tone: "neutral",
    });
    expect(statusToPill("ready").tone).toBe("success");
    expect(statusToPill("failed").tone).toBe("danger");
  });

  it("falls back to neutral for unknown statuses", () => {
    expect(statusToPill("mystery")).toEqual({ label: "mystery", tone: "neutral" });
  });
});
