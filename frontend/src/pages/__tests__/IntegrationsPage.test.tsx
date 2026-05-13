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
    expect(screen.getByText(/\"Available\" means the current shipped integration flow is present in this MVP/i)).toBeInTheDocument();
    expect(screen.getByText(/admin-controlled/i)).toBeInTheDocument();
  });

  it("renders all integration categories including local AI roadmap", () => {
    renderPage();
    const categories = screen.getByTestId("integrations-categories");
    expect(within(categories).getByTestId("integration-category-e-signature")).toBeInTheDocument();
    expect(within(categories).getByTestId("integration-category-document-editing")).toBeInTheDocument();
    expect(within(categories).getByTestId("integration-category-communication")).toBeInTheDocument();
    expect(within(categories).getByTestId("integration-category-crm-business-systems")).toBeInTheDocument();
    expect(within(categories).getByTestId("integration-category-storage")).toBeInTheDocument();
    expect(within(categories).getByTestId("integration-category-local-ai-providers")).toBeInTheDocument();
  });

  it("renders local model providers as planned and not connected", () => {
    renderPage();
    const card = screen.getByTestId("integration-card-local-model-providers");
    expect(within(card).getByText(/Local AI providers/i)).toBeInTheDocument();
    expect(within(card).getByText(/Future self-hosted\/local model configuration only/i)).toBeInTheDocument();
    expect(within(card).getByTestId("integration-caveat-local-model-providers")).toHaveTextContent(/Planned \/ Not connected/i);
  });

  it("renders DocuSeal as available with an active settings CTA", () => {
    renderPage();
    const card = screen.getByTestId("integration-card-docuseal");
    expect(within(card).getByTestId("integration-status-available")).toBeInTheDocument();
    const cta = within(card).getByTestId("integration-cta-docuseal");
    expect(cta).not.toBeDisabled();
    expect(cta).toHaveAttribute("href", "/demo/settings");
  });

  it("renders planned integrations with a disabled CTA", () => {
    renderPage();
    const plannedSlugs = ["microsoft-word", "google-docs", "outlook", "gmail", "slack", "microsoft-teams", "salesforce", "hubspot", "google-drive", "sharepoint-onedrive", "local-model-providers"];
    for (const slug of plannedSlugs) {
      const card = screen.getByTestId(`integration-card-${slug}`);
      expect(within(card).getByTestId("integration-status-planned")).toBeInTheDocument();
      const cta = within(card).getByTestId(`integration-cta-${slug}`);
      expect(cta).toBeDisabled();
    }
  });

  it("renders the roadmap caveat for every planned integration", () => {
    renderPage();
    const caveats = screen.getAllByText(/Roadmap item\. Planned \/ Not connected in this MVP\./i);
    expect(caveats.length).toBe(11);
  });

  it("does not render fake OAuth or live connection toggles", () => {
    renderPage();
    expect(screen.queryByRole("checkbox")).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/connect your account/i);
    expect(text).not.toMatch(/authorize/i);
    expect(text).not.toMatch(/oauth/i);
  });
});
