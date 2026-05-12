import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ReviewRuleEditorModal from "../ReviewRuleEditorModal";
import { FORBIDDEN_DOM_TOKENS } from "../../test/forbiddenTokens";
import type { ReviewRuleInput } from "../../types/reviewRules";

function setup(
  overrides: Partial<React.ComponentProps<typeof ReviewRuleEditorModal>> = {},
) {
  const onCancel = vi.fn();
  const onSubmit = vi.fn();
  render(
    <ReviewRuleEditorModal
      open
      demoMode
      busy={false}
      onCancel={onCancel}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onCancel, onSubmit };
}

describe("ReviewRuleEditorModal", () => {
  it("renders as an accessible dialog with all fields", () => {
    setup();
    const modal = screen.getByTestId("review-rule-modal");
    expect(modal).toHaveAttribute("role", "dialog");
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(modal).toHaveAttribute("aria-labelledby");
    expect(screen.getByTestId("review-rule-modal-title")).toHaveTextContent(
      /add review rule/i,
    );
    expect(screen.getByTestId("review-rule-issue")).toBeInTheDocument();
    expect(screen.getByTestId("review-rule-contract-type")).toBeInTheDocument();
    expect(screen.getByTestId("review-rule-severity")).toBeInTheDocument();
    expect(screen.getByTestId("review-rule-standard")).toBeInTheDocument();
    expect(screen.getByTestId("review-rule-fallback")).toBeInTheDocument();
    expect(screen.getByTestId("review-rule-canned")).toBeInTheDocument();
    expect(screen.getByTestId("review-rule-example")).toBeInTheDocument();
    expect(screen.getByTestId("review-rule-status")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <ReviewRuleEditorModal
        open={false}
        demoMode
        busy={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.queryByTestId("review-rule-modal")).toBeNull();
  });

  it("requires Issue and Standard position", () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByTestId("review-rule-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("review-rule-issue-error")).toHaveTextContent(
      /required/i,
    );
    expect(screen.getByTestId("review-rule-standard-error")).toHaveTextContent(
      /required/i,
    );
  });

  it("submits trimmed values with optional fields normalized", () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByTestId("review-rule-issue"), {
      target: { value: "  Issue label  " },
    });
    fireEvent.change(screen.getByTestId("review-rule-contract-type"), {
      target: { value: "MSA" },
    });
    fireEvent.change(screen.getByTestId("review-rule-severity"), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByTestId("review-rule-standard"), {
      target: { value: "  Standard outcome  " },
    });
    fireEvent.change(screen.getByTestId("review-rule-fallback"), {
      target: { value: "  Fallback  " },
    });
    fireEvent.change(screen.getByTestId("review-rule-canned"), {
      target: { value: " Please change to … " },
    });
    fireEvent.change(screen.getByTestId("review-rule-example"), {
      target: { value: "  Sample clause text  " },
    });
    fireEvent.change(screen.getByTestId("review-rule-status"), {
      target: { value: "archived" },
    });
    fireEvent.click(screen.getByTestId("review-rule-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const values = onSubmit.mock.calls[0][0] as ReviewRuleInput;
    expect(values).toEqual({
      issue: "Issue label",
      contract_type: "MSA",
      severity: "high",
      standard_position: "Standard outcome",
      fallback_position: "Fallback",
      canned_response: "Please change to …",
      example_clause: "Sample clause text",
      status: "archived",
    });
  });

  it("calls onCancel from the Cancel button, Escape, and backdrop click", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByTestId("review-rule-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("review-rule-modal"));
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("disables actions and shows a busy label when busy", () => {
    setup({ busy: true });
    expect(screen.getByTestId("review-rule-cancel")).toBeDisabled();
    expect(screen.getByTestId("review-rule-submit")).toBeDisabled();
    expect(screen.getByTestId("review-rule-submit")).toHaveTextContent(
      /adding/i,
    );
  });

  it("renders the real-mode honest note only when demoMode=false", () => {
    setup({ demoMode: false });
    expect(screen.getByTestId("review-rule-real-note")).toHaveTextContent(
      /not persisted to the server/i,
    );
    expect(screen.getByTestId("review-rule-real-note")).toHaveTextContent(
      /clause manager integration is future work/i,
    );
  });

  it("hides the real-mode note in demo mode", () => {
    setup({ demoMode: true });
    expect(screen.queryByTestId("review-rule-real-note")).toBeNull();
  });

  it("does not surface storage internals, raw metadata, or DocuSeal secrets", () => {
    setup();
    const text = document.body.textContent ?? "";
    for (const needle of FORBIDDEN_DOM_TOKENS) {
      expect(text).not.toContain(needle);
    }
  });
});
