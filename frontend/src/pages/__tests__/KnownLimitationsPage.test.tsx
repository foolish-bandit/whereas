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

  it("renders four limitation groups (auth, playbooks, history, integrations)", () => {
    renderPage();
    for (const id of ["auth", "playbooks", "history", "integrations"]) {
      expect(
        screen.getByTestId(`known-limitations-${id}`),
      ).toBeInTheDocument();
    }
  });

  it("anchors each group with an id so the deep link from Settings reaches it", () => {
    renderPage();
    expect(
      document.getElementById("auth"),
    ).toBeInTheDocument();
  });

  it("does not pretend to give legal advice", () => {
    renderPage();
    expect(
      screen.getByText(/it does not provide legal advice/i),
    ).toBeInTheDocument();
  });
});
