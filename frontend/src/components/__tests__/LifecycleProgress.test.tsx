import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LifecycleProgress from "../LifecycleProgress";
import type { LifecycleStage } from "../../lib/requestLifecycle";

function stage(
  id: string,
  label: string,
  status: LifecycleStage["status"],
  description?: string,
): LifecycleStage {
  return { id, label, status, description };
}

const SIMPLE_STAGES: LifecycleStage[] = [
  stage("intake", "Intake", "complete", "Request submitted."),
  stage("draft", "Draft / Upload", "current", "Generate or upload."),
  stage("approval", "Approval", "not_started"),
  stage("repository", "Repository", "not_started"),
  stage("signature", "Signature", "not_started"),
  stage("executed", "Executed", "not_started"),
];

describe("LifecycleProgress", () => {
  it("renders a nav landmark with accessible label", () => {
    render(<LifecycleProgress stages={SIMPLE_STAGES} />);
    expect(
      screen.getByRole("navigation", { name: /contract lifecycle/i }),
    ).toBeInTheDocument();
  });

  it("renders a list item for each stage", () => {
    render(<LifecycleProgress stages={SIMPLE_STAGES} />);
    for (const s of SIMPLE_STAGES) {
      expect(screen.getByTestId(`lifecycle-stage-${s.id}`)).toBeInTheDocument();
    }
  });

  it("renders stage labels", () => {
    render(<LifecycleProgress stages={SIMPLE_STAGES} />);
    expect(screen.getAllByText("Intake").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Draft / Upload").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Approval").length).toBeGreaterThan(0);
  });

  it("uses aria-current=step on the current stage", () => {
    render(<LifecycleProgress stages={SIMPLE_STAGES} />);
    const currentLi = screen.getByTestId("lifecycle-stage-draft");
    expect(currentLi).toHaveAttribute("aria-current", "step");
  });

  it("does not set aria-current on non-current stages", () => {
    render(<LifecycleProgress stages={SIMPLE_STAGES} />);
    const intakeLi = screen.getByTestId("lifecycle-stage-intake");
    expect(intakeLi).not.toHaveAttribute("aria-current");
    const approvalLi = screen.getByTestId("lifecycle-stage-approval");
    expect(approvalLi).not.toHaveAttribute("aria-current");
  });

  it("renders Complete icon for complete stages", () => {
    render(<LifecycleProgress stages={SIMPLE_STAGES} />);
    const icons = screen.getAllByRole("img", { name: /complete/i });
    expect(icons.length).toBeGreaterThan(0);
  });

  it("renders Current step icon for the current stage", () => {
    render(<LifecycleProgress stages={SIMPLE_STAGES} />);
    const icons = screen.getAllByRole("img", { name: /current step/i });
    expect(icons.length).toBeGreaterThan(0);
  });

  it("renders Not started icon for not_started stages", () => {
    render(<LifecycleProgress stages={SIMPLE_STAGES} />);
    const icons = screen.getAllByRole("img", { name: /not started/i });
    expect(icons.length).toBeGreaterThan(0);
  });

  it("renders Blocked icon for blocked stages", () => {
    const stages = [
      stage("intake", "Intake", "complete"),
      stage("approval", "Approval", "blocked", "An approval workflow was rejected."),
    ];
    render(<LifecycleProgress stages={stages} />);
    const icons = screen.getAllByRole("img", { name: /blocked/i });
    expect(icons.length).toBeGreaterThan(0);
  });

  it("applies custom data-testid when provided", () => {
    render(<LifecycleProgress stages={SIMPLE_STAGES} data-testid="my-progress" />);
    expect(screen.getByTestId("my-progress")).toBeInTheDocument();
  });

  it("defaults data-testid to lifecycle-progress", () => {
    render(<LifecycleProgress stages={SIMPLE_STAGES} />);
    expect(screen.getByTestId("lifecycle-progress")).toBeInTheDocument();
  });

  describe("descriptions", () => {
    it("renders description text when provided", () => {
      render(<LifecycleProgress stages={SIMPLE_STAGES} />);
      // Description is rendered in mobile view; the text should be in the DOM
      expect(screen.getAllByText("Request submitted.").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Generate or upload.").length).toBeGreaterThan(0);
    });

    it("renders fine when description is omitted", () => {
      const stages = [
        stage("intake", "Intake", "complete"),
        stage("draft", "Draft", "current"),
      ];
      render(<LifecycleProgress stages={stages} />);
      expect(screen.getByTestId("lifecycle-stage-intake")).toBeInTheDocument();
      expect(screen.getByTestId("lifecycle-stage-draft")).toBeInTheDocument();
    });
  });

  describe("single stage edge case", () => {
    it("renders one stage without crashing", () => {
      render(<LifecycleProgress stages={[stage("intake", "Intake", "complete")]} />);
      expect(screen.getByTestId("lifecycle-stage-intake")).toBeInTheDocument();
    });
  });

  describe("all stages complete", () => {
    it("marks no stage as aria-current when all are complete", () => {
      const allComplete = SIMPLE_STAGES.map((s) => ({
        ...s,
        status: "complete" as const,
      }));
      render(<LifecycleProgress stages={allComplete} />);
      for (const s of allComplete) {
        expect(screen.getByTestId(`lifecycle-stage-${s.id}`)).not.toHaveAttribute(
          "aria-current",
        );
      }
      const completedIcons = screen.getAllByRole("img", { name: /complete/i });
      expect(completedIcons.length).toBeGreaterThanOrEqual(allComplete.length);
    });
  });
});
