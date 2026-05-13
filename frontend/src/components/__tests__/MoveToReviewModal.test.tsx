import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import MoveToReviewModal, {
  type MoveToReviewValues,
} from "../MoveToReviewModal";
import { FORBIDDEN_DOM_TOKENS } from "../../test/forbiddenTokens";
import type { AgreementTemplate } from "../../types/agreementTemplates";

const SAMPLE_TEMPLATES: AgreementTemplate[] = [
  {
    id: "tpl-active",
    organization_id: "org-1",
    name: "Mutual NDA template",
    description: null,
    template_type: "NDA",
    status: "active",
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-15T10:00:00Z",
    metadata_json: null,
  },
  {
    id: "tpl-dpa",
    organization_id: "org-1",
    name: "Data Processing Addendum",
    description: null,
    template_type: null,
    status: "active",
    created_at: "2026-04-02T10:00:00Z",
    updated_at: "2026-04-15T10:00:00Z",
    metadata_json: { contract_type: "dpa" },
  },
  {
    id: "tpl-archived",
    organization_id: "org-1",
    name: "Archived legacy NDA",
    description: null,
    template_type: "NDA",
    status: "archived",
    created_at: "2024-01-01T10:00:00Z",
    updated_at: "2024-01-01T10:00:00Z",
    metadata_json: null,
  },
];

function setup(
  overrides: Partial<React.ComponentProps<typeof MoveToReviewModal>> = {},
) {
  const onCancel = vi.fn();
  const onSubmit = vi.fn();
  const utils = render(
    <MoveToReviewModal
      open
      itemTitle="Review: Acme MSA"
      selectedCount={1}
      demoMode={false}
      busy={false}
      templates={SAMPLE_TEMPLATES}
      templatesLoading={false}
      onCancel={onCancel}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onCancel, onSubmit, ...utils };
}

describe("MoveToReviewModal", () => {
  it("renders as an accessible dialog with title, subtitle, and all form fields", () => {
    setup();
    const modal = screen.getByTestId("move-to-review-modal");
    expect(modal).toHaveAttribute("role", "dialog");
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(modal).toHaveAttribute("aria-labelledby");
    expect(screen.getByTestId("move-to-review-modal-title")).toHaveTextContent(
      "Move to Review",
    );
    expect(
      screen.getByText(/add the supporting information legal needs/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("move-to-review-name")).toBeInTheDocument();
    expect(
      screen.getByTestId("move-to-review-request-type"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("move-to-review-template")).toBeInTheDocument();
    expect(screen.getByTestId("move-to-review-priority")).toBeInTheDocument();
    expect(screen.getByTestId("move-to-review-owner")).toBeInTheDocument();
    expect(screen.getByTestId("move-to-review-department")).toBeInTheDocument();
    expect(
      screen.getByTestId("move-to-review-supporting-info"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("move-to-review-submit")).toBeInTheDocument();
    expect(screen.getByTestId("move-to-review-cancel")).toBeInTheDocument();
  });

  it("defaults the Request name to the selected item's title", () => {
    setup({ itemTitle: "Default name source" });
    expect(screen.getByTestId("move-to-review-name")).toHaveValue(
      "Default name source",
    );
  });

  it("renders only active templates in the template selector", () => {
    setup();
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options.some((o) => o.textContent === "Mutual NDA template")).toBe(
      true,
    );
    expect(
      options.some((o) => o.textContent === "Archived legacy NDA"),
    ).toBe(false);
    expect(
      options.some((o) => /no template \/ third-party paper/i.test(o.textContent ?? "")),
    ).toBe(true);
  });

  it("disables the template selector while templates are loading", () => {
    setup({ templates: [], templatesLoading: true });
    expect(screen.getByTestId("move-to-review-template")).toBeDisabled();
    expect(screen.getByText(/loading templates/i)).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <MoveToReviewModal
        open={false}
        itemTitle={null}
        selectedCount={0}
        demoMode={false}
        busy={false}
        templates={[]}
        templatesLoading={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.queryByTestId("move-to-review-modal")).toBeNull();
  });

  it("requires the Request name before submitting", () => {
    const { onSubmit } = setup({ itemTitle: "" });
    fireEvent.click(screen.getByTestId("move-to-review-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("move-to-review-name-error"),
    ).toHaveTextContent(/required/i);
  });

  it("submits trimmed values and includes only the captured form fields", () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByTestId("move-to-review-name"), {
      target: { value: "  Acme NDA review  " },
    });
    fireEvent.change(screen.getByTestId("move-to-review-request-type"), {
      target: { value: "nda_review" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-template"), {
      target: { value: "tpl-active" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-priority"), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-owner"), {
      target: { value: " jordan@example.com " },
    });
    fireEvent.change(screen.getByTestId("move-to-review-department"), {
      target: { value: " Sales " },
    });
    fireEvent.change(screen.getByTestId("move-to-review-supporting-info"), {
      target: { value: " deal value 50k " },
    });
    fireEvent.click(screen.getByTestId("move-to-review-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const values = onSubmit.mock.calls[0][0] as MoveToReviewValues;
    expect(values).toEqual({
      name: "Acme NDA review",
      requestType: "nda_review",
      templateId: "tpl-active",
      priority: "high",
      owner: "jordan@example.com",
      department: "Sales",
      supportingInfo: "deal value 50k",
    });
  });

  it("disables submit and shows an honest 'one item at a time' notice for multi-item selections", () => {
    const { onSubmit } = setup({ selectedCount: 3 });
    expect(screen.getByTestId("move-to-review-submit")).toBeDisabled();
    expect(
      screen.getByTestId("move-to-review-multi-notice"),
    ).toHaveTextContent(/one intake item at a time/i);
    // Form fields are not rendered at all in the multi-item state to
    // make it obvious to the user that nothing will be submitted.
    expect(screen.queryByTestId("move-to-review-name")).toBeNull();
    fireEvent.click(screen.getByTestId("move-to-review-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onCancel from the Cancel button, Escape key, and backdrop click", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByTestId("move-to-review-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    // Click on the backdrop (the modal's outer wrapper) but not on the
    // panel itself.
    fireEvent.click(screen.getByTestId("move-to-review-modal"));
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("disables all actions while busy", () => {
    setup({ busy: true });
    expect(screen.getByTestId("move-to-review-cancel")).toBeDisabled();
    expect(screen.getByTestId("move-to-review-submit")).toBeDisabled();
    expect(screen.getByTestId("move-to-review-submit")).toHaveTextContent(
      /routing/i,
    );
  });

  it("shows the demo subtitle without the real-mode note when demoMode=true", () => {
    setup({ demoMode: true });
    expect(screen.queryByTestId("move-to-review-real-note")).toBeNull();
  });

  it("renders the real-mode honest note when demoMode=false", () => {
    setup({ demoMode: false });
    expect(screen.getByTestId("move-to-review-real-note")).toHaveTextContent(
      /existing requests api/i,
    );
    expect(screen.getByTestId("move-to-review-real-note")).toHaveTextContent(
      /aren.?t sent to the server/i,
    );
  });

  it("does not surface storage internals, raw metadata, or DocuSeal secrets", () => {
    setup();
    const text = document.body.textContent ?? "";
    for (const needle of FORBIDDEN_DOM_TOKENS) {
      expect(text).not.toContain(needle);
    }
  });

  // ---------------------------------------------------------------------
  // PR #126 — Supporting questions inside the modal
  // ---------------------------------------------------------------------

  it("renders the NDA supporting-questions panel when request type is NDA review", () => {
    setup();
    // Default request type in setup() is "review_existing", which
    // falls back to "other". Switch to nda_review to see the NDA set.
    fireEvent.change(screen.getByTestId("move-to-review-request-type"), {
      target: { value: "nda_review" },
    });
    const panel = screen.getByTestId("move-to-review-supporting-questions");
    expect(panel.getAttribute("data-supporting-question-group")).toBe("nda");
    expect(panel.textContent).toMatch(/mutual or one-way/i);
  });

  it("switches the question set when the request type changes (vendor → employment)", () => {
    setup();
    fireEvent.change(screen.getByTestId("move-to-review-request-type"), {
      target: { value: "vendor_agreement" },
    });
    expect(
      screen
        .getByTestId("move-to-review-supporting-questions")
        .getAttribute("data-supporting-question-group"),
    ).toBe("vendor");
    fireEvent.change(screen.getByTestId("move-to-review-request-type"), {
      target: { value: "employment_agreement" },
    });
    expect(
      screen
        .getByTestId("move-to-review-supporting-questions")
        .getAttribute("data-supporting-question-group"),
    ).toBe("employment");
  });

  it("summarises supporting-question answers into supportingInfo on submit", () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByTestId("move-to-review-request-type"), {
      target: { value: "nda_review" },
    });
    const inputs = screen.getAllByTestId(
      "move-to-review-supporting-questions-input",
    );
    const direction = inputs.find(
      (el) =>
        el.getAttribute("data-supporting-question-input") === "nda_direction",
    )!;
    fireEvent.change(direction, { target: { value: "One-way (Acme discloses)" } });

    // Free-text supporting info remains available alongside the
    // structured panel.
    fireEvent.change(screen.getByTestId("move-to-review-supporting-info"), {
      target: { value: "Acme is a strategic prospect — turnaround Friday." },
    });

    fireEvent.click(screen.getByTestId("move-to-review-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0] as MoveToReviewValues;
    expect(submitted.requestType).toBe("nda_review");
    expect(submitted.supportingInfo).toContain(
      "Supporting questions (NDA review)",
    );
    expect(submitted.supportingInfo).toContain("One-way (Acme discloses)");
    expect(submitted.supportingInfo).toContain(
      "Acme is a strategic prospect",
    );
  });

  it("submits an unchanged supportingInfo when no structured answers are filled", () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByTestId("move-to-review-supporting-info"), {
      target: { value: "Just the freeform note." },
    });
    fireEvent.click(screen.getByTestId("move-to-review-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0] as MoveToReviewValues;
    expect(submitted.supportingInfo).toBe("Just the freeform note.");
  });

  it("hides the supporting-questions panel in the multi-select disabled state", () => {
    setup({ selectedCount: 2, itemTitle: null });
    expect(
      screen.queryByTestId("move-to-review-supporting-questions"),
    ).toBeNull();
    expect(
      screen.getByTestId("move-to-review-multi-notice"),
    ).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------
  // Template-Aware Supporting Questions
  // ---------------------------------------------------------------------

  it("switches the question set to NDA when an NDA template is selected, even with a generic request type", () => {
    setup();
    // Default request type is "review_existing", which would map to
    // the generic OTHER question set on its own.
    fireEvent.change(screen.getByTestId("move-to-review-template"), {
      target: { value: "tpl-active" },
    });
    const panel = screen.getByTestId("move-to-review-supporting-questions");
    expect(panel.getAttribute("data-supporting-question-group")).toBe("nda");
    // Helper hint surfaces only when the template drove the match.
    expect(
      screen.getByTestId("move-to-review-supporting-questions-hint"),
    ).toHaveTextContent(/tailored from the selected agreement template/i);
  });

  it("switches to DPA questions when a DPA template (via metadata.contract_type) is selected", () => {
    setup();
    fireEvent.change(screen.getByTestId("move-to-review-template"), {
      target: { value: "tpl-dpa" },
    });
    expect(
      screen
        .getByTestId("move-to-review-supporting-questions")
        .getAttribute("data-supporting-question-group"),
    ).toBe("dpa");
  });

  it("falls back to request-type matching when the template is cleared", () => {
    setup();
    fireEvent.change(screen.getByTestId("move-to-review-request-type"), {
      target: { value: "vendor_agreement" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-template"), {
      target: { value: "tpl-active" },
    });
    expect(
      screen
        .getByTestId("move-to-review-supporting-questions")
        .getAttribute("data-supporting-question-group"),
    ).toBe("nda");
    fireEvent.change(screen.getByTestId("move-to-review-template"), {
      target: { value: "" },
    });
    expect(
      screen
        .getByTestId("move-to-review-supporting-questions")
        .getAttribute("data-supporting-question-group"),
    ).toBe("vendor");
    // No template means no template-driven hint.
    expect(
      screen.queryByTestId("move-to-review-supporting-questions-hint"),
    ).toBeNull();
  });

  it("summarises template-derived answers with the template-aware label", () => {
    const { onSubmit } = setup();
    // Generic request type, NDA template — summary should still
    // carry the NDA heading.
    fireEvent.change(screen.getByTestId("move-to-review-template"), {
      target: { value: "tpl-active" },
    });
    const inputs = screen.getAllByTestId(
      "move-to-review-supporting-questions-input",
    );
    const direction = inputs.find(
      (el) =>
        el.getAttribute("data-supporting-question-input") === "nda_direction",
    )!;
    fireEvent.change(direction, { target: { value: "Mutual" } });
    fireEvent.click(screen.getByTestId("move-to-review-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0] as MoveToReviewValues;
    expect(submitted.supportingInfo).toContain(
      "Supporting questions (NDA review)",
    );
    expect(submitted.supportingInfo).toContain("Mutual");
    // The submitted values object MUST still only contain the
    // existing supported fields — no structured side-channel.
    expect(Object.keys(submitted).sort()).toEqual(
      [
        "department",
        "name",
        "owner",
        "priority",
        "requestType",
        "supportingInfo",
        "templateId",
      ].sort(),
    );
  });
});
