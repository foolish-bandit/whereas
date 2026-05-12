import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import ReviewTab from "../ReviewTab";
import type { PlaybookFinding } from "../../types/demoExtras";

function finding(overrides: Partial<PlaybookFinding> = {}): PlaybookFinding {
  return {
    id: "find-1",
    playbook_rule_id: "rule.test",
    rule_label: "Test rule",
    severity: "high",
    status: "open",
    finding_text: "Something deviates.",
    standard_position: "Playbook says X.",
    suggested_redline: "Replace with Y.",
    citation: { text_preview_start: 0, text_preview_end: 10 },
    ...overrides,
  };
}

function renderTab(props: Partial<React.ComponentProps<typeof ReviewTab>> = {}) {
  const onJumpToSource = vi.fn();
  const out = render(
    <MemoryRouter>
      <ReviewTab
        contractId="c-test"
        findings={props.findings ?? [finding()]}
        onJumpToSource={onJumpToSource}
      />
    </MemoryRouter>,
  );
  return { ...out, onJumpToSource };
}

describe("ReviewTab", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders severity counters that only count open findings", () => {
    renderTab({
      findings: [
        finding({ id: "b1", severity: "blocker" }),
        finding({ id: "h1", severity: "high" }),
        finding({ id: "h2", severity: "high", status: "accepted" }),
        finding({ id: "m1", severity: "medium" }),
      ],
    });
    expect(screen.getByTestId("review-tab-summary-blocker")).toHaveTextContent(
      "1 BLOCKER",
    );
    expect(screen.getByTestId("review-tab-summary-high")).toHaveTextContent(
      "1 HIGH",
    );
    expect(screen.getByTestId("review-tab-summary-medium")).toHaveTextContent(
      "1 MEDIUM",
    );
    expect(screen.getByTestId("review-tab-summary-resolved")).toHaveTextContent(
      /1 resolved/,
    );
  });

  it("sorts findings open-first, then by severity", () => {
    renderTab({
      findings: [
        finding({ id: "low-open", severity: "low" }),
        finding({
          id: "blocker-waived",
          severity: "blocker",
          status: "waived",
        }),
        finding({ id: "high-open", severity: "high" }),
      ],
    });
    const cards = screen.getAllByTestId(/finding-card-(high|low|blocker)/);
    const order = cards.map((el) =>
      (el.getAttribute("data-testid") ?? "").replace("finding-card-", ""),
    );
    expect(order).toEqual(["high-open", "low-open", "blocker-waived"]);
  });

  it("Accept finding persists status to localStorage and updates the count", () => {
    renderTab({
      findings: [finding({ id: "f1", severity: "high" })],
    });
    fireEvent.click(screen.getByTestId("finding-card-toggle-f1"));
    fireEvent.click(screen.getByTestId("finding-card-accept-f1"));
    expect(
      JSON.parse(window.localStorage.getItem("whereas:demo:findings:c-test") ?? "{}"),
    ).toHaveProperty("f1");
    // Open-high count drops to zero.
    expect(screen.getByTestId("review-tab-summary-high")).toHaveTextContent(
      "0 HIGH",
    );
  });

  it("Waive requires a justification before saving", () => {
    renderTab({
      findings: [finding({ id: "f1", severity: "blocker" })],
    });
    fireEvent.click(screen.getByTestId("finding-card-toggle-f1"));
    fireEvent.click(screen.getByTestId("finding-card-waive-f1"));
    const commit = screen.getByTestId(
      "finding-card-waive-commit-f1",
    ) as HTMLButtonElement;
    expect(commit).toBeDisabled();
    fireEvent.change(screen.getByTestId("finding-card-waive-input-f1"), {
      target: { value: "Approved by Legal" },
    });
    expect(commit).not.toBeDisabled();
    fireEvent.click(commit);
    expect(screen.getByTestId("finding-card-status-f1")).toHaveTextContent(
      /waived/i,
    );
  });

  it("shows an empty state with a link to /demo/playbooks when there are no findings", () => {
    renderTab({ findings: [] });
    expect(screen.getByTestId("review-tab-empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /playbooks/i })).toHaveAttribute(
      "href",
      "/demo/playbooks",
    );
  });

  it("clicking a finding fires onJumpToSource with the citation span", () => {
    const { onJumpToSource } = renderTab({
      findings: [
        finding({
          id: "f1",
          citation: { text_preview_start: 42, text_preview_end: 75 },
        }),
      ],
    });
    fireEvent.click(screen.getByTestId("finding-card-toggle-f1"));
    expect(onJumpToSource).toHaveBeenCalledWith(
      "finding:f1",
      { start: 42, end: 75 },
    );
  });
});
