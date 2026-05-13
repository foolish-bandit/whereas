import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import IntegrationsPage from "../IntegrationsPage";

function renderPage() {
  render(
    <MemoryRouter>
      <IntegrationsPage />
    </MemoryRouter>,
  );
}

describe("IntegrationsPage", () => {
  it("renders the page root", () => {
    renderPage();
    expect(screen.getByTestId("integrations-page")).toBeInTheDocument();
  });

  it("renders the integration availability explanation", () => {
    renderPage();
    expect(screen.getByText(/\"Available\" means you can configure it now/i)).toBeInTheDocument();
    expect(screen.getByText(/admin-controlled/i)).toBeInTheDocument();
  });

  it("renders all four integration categories", () => {
    renderPage();
    const categories = screen.getByTestId("integrations-categories");
    expect(
      within(categories).getByTestId("integration-category-e-signature"),
    ).toBeInTheDocument();
    expect(
      within(categories).getByTestId("integration-category-document-editing"),
    ).toBeInTheDocument();
    expect(
      within(categories).getByTestId("integration-category-communication"),
    ).toBeInTheDocument();
    expect(
      within(categories).getByTestId("integration-category-crm-business-systems"),
    ).toBeInTheDocument();
    expect(
      within(categories).getByTestId("integration-category-storage"),
    ).toBeInTheDocument();
  });

  it("renders DocuSeal as available with an active settings CTA", () => {
    renderPage();
    const card = screen.getByTestId("integration-card-docuseal");
    expect(within(card).getByTestId("integration-status-available")).toBeInTheDocument();
    const cta = within(card).getByTestId("integration-cta-docuseal");
    expect(cta).not.toBeDisabled();
    expect(cta).toHaveAttribute("href", "/demo/settings");
  });

  it("renders DocuSeal without the planned-item caveat", () => {
    renderPage();
    const card = screen.getByTestId("integration-card-docuseal");
    expect(
      within(card).queryByTestId("integration-caveat-docuseal"),
    ).toBeNull();
  });

  it("renders planned integrations with a disabled CTA", () => {
    renderPage();
    const plannedSlugs = [
      "microsoft-word",
      "google-docs",
      "outlook",
      "gmail",
      "slack",
      "microsoft-teams",
      "salesforce",
      "hubspot",
      "google-drive",
      "sharepoint-onedrive",
    ];
    for (const slug of plannedSlugs) {
      const card = screen.getByTestId(`integration-card-${slug}`);
      expect(
        within(card).getByTestId("integration-status-planned"),
        `${slug} should have a Planned status pill`,
      ).toBeInTheDocument();
      const cta = within(card).getByTestId(`integration-cta-${slug}`);
      expect(cta, `${slug} CTA should be disabled`).toBeDisabled();
    }
  });

  it("renders the roadmap caveat for every planned integration", () => {
    renderPage();
    const caveats = screen.getAllByText(/Roadmap item\. Not connected in this MVP\./i);
    // 10 planned integrations
    expect(caveats.length).toBe(10);
  });

  it("renders all expected integration cards", () => {
    renderPage();
    const expectedSlugs = [
      "docuseal",
      "microsoft-word",
      "google-docs",
      "outlook",
      "gmail",
      "slack",
      "microsoft-teams",
      "salesforce",
      "hubspot",
      "google-drive",
      "sharepoint-onedrive",
    ];
    for (const slug of expectedSlugs) {
      expect(
        screen.getByTestId(`integration-card-${slug}`),
        `card for ${slug} should be present`,
      ).toBeInTheDocument();
    }
  });

  it("does not render fake OAuth or live connection toggles", () => {
    renderPage();
    // No inputs of type checkbox or toggle-style controls should appear
    expect(screen.queryByRole("checkbox")).toBeNull();
    // No text suggesting OAuth flow or live connection
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/connect your account/i);
    expect(text).not.toMatch(/authorize/i);
    expect(text).not.toMatch(/oauth/i);
  });
});
