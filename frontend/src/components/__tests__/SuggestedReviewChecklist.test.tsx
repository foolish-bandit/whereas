import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import SuggestedReviewChecklist from "../SuggestedReviewChecklist";

function renderChecklist(
  contractType: string | null | undefined,
  onOpenReviewTab?: () => void,
  path = "/requests/req-1",
) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SuggestedReviewChecklist
        contractType={contractType}
        onOpenReviewTab={onOpenReviewTab}
      />
    </MemoryRouter>,
  );
}

describe("SuggestedReviewChecklist", () => {
  it("renders the section heading and disclaimer", () => {
    renderChecklist("NDA");
    expect(
      screen.getByTestId("suggested-review-checklist"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /suggested review checklist/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/workflow aid, not legal advice/i),
    ).toBeInTheDocument();
  });

  it("renders NDA checklist items", () => {
    renderChecklist("NDA");
    const labels = screen
      .getAllByTestId("checklist-item-label")
      .map((el) => el.textContent);
    expect(labels).toEqual([
      "Confidentiality scope",
      "Term / survival",
      "Residuals",
      "Governing law",
      "Return/destruction of materials",
    ]);
  });

  it("renders DPA checklist items", () => {
    renderChecklist("DPA");
    const labels = screen
      .getAllByTestId("checklist-item-label")
      .map((el) => el.textContent);
    expect(labels).toContain("Data categories");
    expect(labels).toContain("Subprocessors");
    expect(labels).toContain("Cross-border transfers");
  });

  it("renders default checklist for null contract type", () => {
    renderChecklist(null);
    const labels = screen
      .getAllByTestId("checklist-item-label")
      .map((el) => el.textContent);
    expect(labels).toEqual([
      "Parties",
      "Term",
      "Payment/consideration",
      "Liability",
      "Governing law",
    ]);
    expect(
      screen.getByText(/workflow aid, not legal advice/i),
    ).toBeInTheDocument();
  });

  it("renders default checklist for undefined contract type", () => {
    renderChecklist(undefined);
    const labels = screen
      .getAllByTestId("checklist-item-label")
      .map((el) => el.textContent);
    expect(labels[0]).toBe("Parties");
  });

  it("renders default checklist for unrecognized contract type", () => {
    renderChecklist("Software License");
    const labels = screen
      .getAllByTestId("checklist-item-label")
      .map((el) => el.textContent);
    expect(labels).toContain("Parties");
    expect(labels).toContain("Governing law");
  });

  it("checkboxes start unchecked (not reviewed)", () => {
    renderChecklist("NDA");
    const boxes = screen.getAllByTestId("checklist-item-checkbox");
    expect(boxes).toHaveLength(5);
    for (const box of boxes) {
      expect(box).not.toBeChecked();
    }
  });

  it("toggles a checkbox on click", () => {
    renderChecklist("NDA");
    const boxes = screen.getAllByTestId("checklist-item-checkbox");
    fireEvent.click(boxes[0]);
    expect(boxes[0]).toBeChecked();
    fireEvent.click(boxes[0]);
    expect(boxes[0]).not.toBeChecked();
  });

  it("renders Open Playbooks link pointing to /playbooks", () => {
    renderChecklist("NDA");
    const link = screen.getByTestId("checklist-link-playbooks");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/playbooks");
  });

  it("renders Open Clause Manager link pointing to /clause-manager", () => {
    renderChecklist("NDA");
    const link = screen.getByTestId("checklist-link-clause-manager");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/clause-manager");
  });

  it("renders links with /demo prefix when path is under /demo", () => {
    renderChecklist("NDA", undefined, "/demo/requests/req-1");
    expect(screen.getByTestId("checklist-link-playbooks")).toHaveAttribute(
      "href",
      "/demo/playbooks",
    );
    expect(screen.getByTestId("checklist-link-clause-manager")).toHaveAttribute(
      "href",
      "/demo/clause-manager",
    );
  });

  it("does not render Open Review tab button when onOpenReviewTab is not provided", () => {
    renderChecklist("NDA");
    expect(
      screen.queryByTestId("checklist-open-review-tab"),
    ).not.toBeInTheDocument();
  });

  it("renders and triggers Open Review tab button when callback is provided", () => {
    const onOpen = vi.fn();
    renderChecklist("NDA", onOpen);
    const btn = screen.getByTestId("checklist-open-review-tab");
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("renders all action links", () => {
    const onOpen = vi.fn();
    renderChecklist("MSA", onOpen);
    expect(screen.getByTestId("review-checklist-actions")).toBeInTheDocument();
    expect(screen.getByTestId("checklist-link-playbooks")).toBeInTheDocument();
    expect(
      screen.getByTestId("checklist-link-clause-manager"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("checklist-open-review-tab")).toBeInTheDocument();
  });
});
