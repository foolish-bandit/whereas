import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import SettingsPage from "../SettingsPage";
import { expectNoForbiddenTokens } from "../../test/forbiddenTokens";

describe("SettingsPage", () => {
  function renderPage() {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
  }

  it("renders AI and local intelligence section with roadmap statuses", () => {
    renderPage();

    expect(screen.getByTestId("settings-ai-local-intelligence")).toBeInTheDocument();
    expect(screen.getByText("Embeddings")).toBeInTheDocument();
    expect(screen.getByText("Planned / Disabled")).toBeInTheDocument();
    expect(screen.getByText("Clause similarity")).toBeInTheDocument();
    expect(screen.getByText("Entity extraction")).toBeInTheDocument();
    expect(screen.getByText("Playbook-grounded findings")).toBeInTheDocument();
    expect(screen.getByText("Small-model explanation writer")).toBeInTheDocument();
    expect(screen.getByText("Cloud AI providers")).toBeInTheDocument();
    expect(screen.getByText("Not enabled")).toBeInTheDocument();
  });

  it("states cloud AI is not used by default", () => {
    renderPage();

    expect(
      screen.getByText(/No contract text is sent to cloud AI providers by default\./i),
    ).toBeInTheDocument();
  });

  it("does not leak forbidden internal tokens", () => {
    renderPage();
    expect(() => expectNoForbiddenTokens(document.body.textContent)).not.toThrow();
  });
});
