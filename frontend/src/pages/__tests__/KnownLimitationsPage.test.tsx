import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import KnownLimitationsPage from "../KnownLimitationsPage";

describe("KnownLimitationsPage", () => {
  function renderPage() {
    render(
      <MemoryRouter>
        <KnownLimitationsPage />
      </MemoryRouter>,
    );
  }

  it("renders evaluator-facing limitation groups", () => {
    renderPage();
    for (const id of ["mvp-demo", "integrations", "review-ai", "small-model-ai-roadmap", "document-signature", "platform"]) {
      expect(
        screen.getByTestId(`known-limitations-${id}`),
      ).toBeInTheDocument();
    }
  });

  it("anchors groups with ids so deep links can target sections", () => {
    renderPage();
    expect(document.getElementById("mvp-demo")).toBeInTheDocument();
    expect(document.getElementById("small-model-ai-roadmap")).toBeInTheDocument();
    expect(document.getElementById("platform")).toBeInTheDocument();
  });

  it("states that Whereas does not provide legal advice", () => {
    renderPage();
    expect(
      screen.getByText(/whereas does not provide legal advice/i),
    ).toBeInTheDocument();
  });

  it("renders small-model roadmap boundaries without claiming active legal AI review", () => {
    renderPage();
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/local\/self-hostable models under 2B parameters by default/i);
    expect(text).toMatch(/Embeddings, extraction, reranking, and playbook-grounded explanations are planned/i);
    expect(text).toMatch(/No large-model legal review is enabled/i);
    expect(text).toMatch(/no cloud AI provider is enabled by default/i);
    expect(text).toMatch(/human review remains required/i);
    expect(text).toMatch(/AI outputs are workflow aids, not legal advice/i);
    expect(text).not.toMatch(/active AI legal review/i);
  });
});
