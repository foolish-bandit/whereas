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
    for (const id of ["mvp-demo", "integrations", "review-ai", "document-signature", "platform"]) {
      expect(
        screen.getByTestId(`known-limitations-${id}`),
      ).toBeInTheDocument();
    }
  });

  it("anchors groups with ids so deep links can target sections", () => {
    renderPage();
    expect(document.getElementById("mvp-demo")).toBeInTheDocument();
    expect(document.getElementById("platform")).toBeInTheDocument();
  });

  it("states that Whereas does not provide legal advice", () => {
    renderPage();
    expect(
      screen.getByText(/whereas does not provide legal advice/i),
    ).toBeInTheDocument();
  });
});
