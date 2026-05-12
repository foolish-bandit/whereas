import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import RepositoryClassificationModal, {
  type RepositoryClassificationValues,
} from "../RepositoryClassificationModal";
import { FORBIDDEN_DOM_TOKENS } from "../../test/forbiddenTokens";

function setup(
  overrides: Partial<React.ComponentProps<typeof RepositoryClassificationModal>> = {},
) {
  const onCancel = vi.fn();
  const onSubmit = vi.fn();
  const utils = render(
    <RepositoryClassificationModal
      open
      selectedCount={1}
      demoMode
      busy={false}
      onCancel={onCancel}
      onSubmit={onSubmit}
      {...overrides}
    />,
  );
  return { onCancel, onSubmit, ...utils };
}

describe("RepositoryClassificationModal", () => {
  it("renders all classification fields when open", () => {
    setup();
    const modal = screen.getByTestId("repository-classification-modal");
    expect(modal).toHaveAttribute("role", "dialog");
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("repo-classify-name")).toBeInTheDocument();
    expect(screen.getByTestId("repo-classify-contract-type")).toBeInTheDocument();
    expect(screen.getByTestId("repo-classify-status")).toBeInTheDocument();
    expect(screen.getByTestId("repo-classify-owner")).toBeInTheDocument();
    expect(screen.getByTestId("repo-classify-folder")).toBeInTheDocument();
    expect(screen.getByTestId("repo-classify-submit")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <RepositoryClassificationModal
        open={false}
        selectedCount={0}
        demoMode
        busy={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(
      screen.queryByTestId("repository-classification-modal"),
    ).toBeNull();
  });

  it("requires a Repository name in demo mode before submitting", () => {
    const { onSubmit } = setup();
    fireEvent.click(screen.getByTestId("repo-classify-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("repo-classify-name-error"),
    ).toHaveTextContent(/required/i);
  });

  it("submits the trimmed classification values on confirm", () => {
    const { onSubmit } = setup();
    fireEvent.change(screen.getByTestId("repo-classify-name"), {
      target: { value: "  Vendor MSA — Acme  " },
    });
    fireEvent.change(screen.getByTestId("repo-classify-contract-type"), {
      target: { value: " MSA " },
    });
    fireEvent.change(screen.getByTestId("repo-classify-status"), {
      target: { value: "In review" },
    });
    fireEvent.change(screen.getByTestId("repo-classify-owner"), {
      target: { value: " jordan@example.com " },
    });
    fireEvent.change(screen.getByTestId("repo-classify-folder"), {
      target: { value: "Sales / EMEA" },
    });
    fireEvent.click(screen.getByTestId("repo-classify-submit"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const values = onSubmit.mock.calls[0][0] as RepositoryClassificationValues;
    expect(values).toEqual({
      name: "Vendor MSA — Acme",
      contractType: "MSA",
      status: "In review",
      owner: "jordan@example.com",
      folder: "Sales / EMEA",
    });
  });

  it("hides the demo submit and shows honest guidance in real mode", () => {
    setup({
      demoMode: false,
      realModeActionSlot: (
        <a href="/upload" data-testid="repo-classify-open-upload">
          Open Repository upload
        </a>
      ),
    });
    expect(screen.queryByTestId("repo-classify-submit")).toBeNull();
    expect(screen.getByTestId("repo-classify-real-note")).toHaveTextContent(
      /existing repository upload/i,
    );
    expect(screen.getByTestId("repo-classify-open-upload")).toHaveAttribute(
      "href",
      "/upload",
    );
  });

  it("calls onCancel from the Cancel button and on Escape", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByTestId("repo-classify-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("disables actions while a route is in-flight", () => {
    setup({ busy: true });
    expect(screen.getByTestId("repo-classify-submit")).toBeDisabled();
    expect(screen.getByTestId("repo-classify-submit")).toHaveTextContent(
      /Routing/i,
    );
    expect(screen.getByTestId("repo-classify-cancel")).toBeDisabled();
  });

  it("does not surface storage internals or raw metadata tokens", () => {
    setup();
    const text = document.body.textContent ?? "";
    for (const needle of FORBIDDEN_DOM_TOKENS) {
      expect(text).not.toContain(needle);
    }
  });
});
