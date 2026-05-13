import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import KeyTermsPanel from "../KeyTermsPanel";
import type { KeyTermsPanelProps } from "../KeyTermsPanel";
import type { ContractArtifact, ContractDetail } from "../../types/contracts";
import type { ContractMetadataView } from "../../types/contractIntake";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function contract(overrides: Partial<ContractDetail> = {}): ContractDetail {
  return {
    id: "test-contract-id",
    title: "Test Agreement",
    status: "ready",
    mime_type: "application/pdf",
    file_hash_sha256: "abc123",
    page_count: 5,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    counterparty: null,
    effective_date: null,
    renewal_date: null,
    auto_renew: null,
    owner_user_id: null,
    owner_display_name: null,
    full_text: null,
    extracted_fields: [],
    clauses: [],
    ...overrides,
  };
}

function metadata(
  overrides: Partial<ContractMetadataView> = {},
): ContractMetadataView {
  return {
    contract_id: "test-contract-id",
    title: "Test Agreement",
    counterparty_name: null,
    contract_type: null,
    effective_date: null,
    updated_at: "2026-01-02T00:00:00Z",
    changed_fields: [],
    ...overrides,
  };
}

function artifact(
  overrides: Partial<ContractArtifact> = {},
): ContractArtifact {
  return {
    id: "artifact-1",
    contract_id: "test-contract-id",
    artifact_type: "original_upload",
    storage_backend: "minio",
    filename: "agreement.pdf",
    mime_type: "application/pdf",
    file_hash_sha256: null,
    size_bytes: null,
    source: "user_upload",
    is_official: true,
    created_at: "2026-01-01T00:00:00Z",
    metadata_json: null,
    ...overrides,
  };
}

function renderPanel(props: Partial<KeyTermsPanelProps> = {}) {
  return render(
    <KeyTermsPanel
      contract={contract()}
      metadata={null}
      artifacts={[]}
      {...props}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KeyTermsPanel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the section heading", () => {
    renderPanel();
    expect(
      screen.getByRole("heading", { name: /key terms/i }),
    ).toBeInTheDocument();
  });

  it("renders 'Not set' for all missing fields when no data is provided", () => {
    renderPanel();
    const notSetCells = screen.getAllByText("Not set");
    // Counterparty, contract type, effective date, renewal date, owner,
    // current document, approval status should all show "Not set".
    expect(notSetCells.length).toBeGreaterThanOrEqual(5);
  });

  it("renders counterparty from metadata when available", () => {
    renderPanel({
      metadata: metadata({ counterparty_name: "Globex Corp" }),
    });
    expect(screen.getByTestId("key-term-counterparty")).toHaveTextContent(
      "Globex Corp",
    );
  });

  it("falls back to contract.counterparty when metadata is null", () => {
    renderPanel({
      contract: contract({ counterparty: "Acme Ltd" }),
      metadata: null,
    });
    expect(screen.getByTestId("key-term-counterparty")).toHaveTextContent(
      "Acme Ltd",
    );
  });

  it("renders contract type from metadata", () => {
    renderPanel({
      metadata: metadata({ contract_type: "NDA" }),
    });
    expect(screen.getByTestId("key-term-contract-type")).toHaveTextContent(
      "NDA",
    );
  });

  it("renders effective date formatted when available", () => {
    renderPanel({
      metadata: metadata({ effective_date: "2026-01-15" }),
    });
    // formatDate renders locale-specific; check it's not 'Not set'
    const cell = screen.getByTestId("key-term-effective-date");
    expect(cell).not.toHaveTextContent("Not set");
    expect(cell).toHaveTextContent(/2026|Jan/);
  });

  it("renders renewal date from contract", () => {
    renderPanel({
      contract: contract({ renewal_date: "2027-06-01" }),
    });
    const cell = screen.getByTestId("key-term-renewal-date");
    expect(cell).not.toHaveTextContent("Not set");
    expect(cell).toHaveTextContent(/2027|Jun/);
  });

  it("renders owner display name from contract", () => {
    renderPanel({
      contract: contract({ owner_display_name: "Rachel Vega" }),
    });
    expect(screen.getByTestId("key-term-owner")).toHaveTextContent(
      "Rachel Vega",
    );
  });

  it("renders current document label from artifacts", () => {
    renderPanel({
      artifacts: [artifact({ artifact_type: "original_upload", source: "user_upload" })],
    });
    expect(screen.getByTestId("key-term-current-document")).toHaveTextContent(
      "Source file",
    );
  });

  it("renders signed PDF as current document when present", () => {
    renderPanel({
      artifacts: [
        artifact({ id: "a1", artifact_type: "original_upload" }),
        artifact({ id: "a2", artifact_type: "signed_pdf", source: "docuseal" }),
      ],
    });
    expect(screen.getByTestId("key-term-current-document")).toHaveTextContent(
      "Signed PDF",
    );
  });

  it("renders signature status pill as 'Not sent' for ready contracts", () => {
    renderPanel({ contract: contract({ status: "ready" }) });
    expect(screen.getByTestId("key-term-signature-status")).toHaveTextContent(
      "Not sent",
    );
  });

  it("renders signature status pill as 'Out for signature' when sent", () => {
    renderPanel({
      contract: contract({ status: "sent_for_signature" }),
    });
    expect(screen.getByTestId("key-term-signature-status")).toHaveTextContent(
      "Out for signature",
    );
  });

  it("renders signature status pill as 'Signed PDF received' when executed with signed artifact", () => {
    renderPanel({
      contract: contract({ status: "executed" }),
      artifacts: [artifact({ artifact_type: "signed_pdf", source: "docuseal" })],
    });
    expect(screen.getByTestId("key-term-signature-status")).toHaveTextContent(
      "Signed PDF received",
    );
  });

  it("renders executed status pill as 'Executed' for executed contracts", () => {
    renderPanel({ contract: contract({ status: "executed" }) });
    expect(screen.getByTestId("key-term-executed-status")).toHaveTextContent(
      "Executed",
    );
  });

  it("renders executed status pill as 'Awaiting execution' when sent for signature", () => {
    renderPanel({ contract: contract({ status: "sent_for_signature" }) });
    expect(screen.getByTestId("key-term-executed-status")).toHaveTextContent(
      "Awaiting execution",
    );
  });

  it("renders source file as 'Available' when original_upload artifact exists", () => {
    renderPanel({
      artifacts: [artifact({ artifact_type: "original_upload" })],
    });
    expect(screen.getByTestId("key-term-source-file")).toHaveTextContent(
      "Available",
    );
  });

  it("renders source file as 'Not set' when no artifacts", () => {
    renderPanel({ artifacts: [] });
    expect(screen.getByTestId("key-term-source-file")).toHaveTextContent(
      "Not set",
    );
  });

  it("shows 'Review metadata' action for missing counterparty when callback provided", () => {
    const onReview = vi.fn();
    renderPanel({ onReviewMetadata: onReview });
    const btn = screen.getByTestId("key-term-counterparty-review-action");
    expect(btn).toHaveTextContent("Review metadata");
    fireEvent.click(btn);
    expect(onReview).toHaveBeenCalledOnce();
  });

  it("does not show 'Review metadata' action when counterparty is set", () => {
    renderPanel({
      metadata: metadata({ counterparty_name: "Acme" }),
      onReviewMetadata: vi.fn(),
    });
    expect(
      screen.queryByTestId("key-term-counterparty-review-action"),
    ).not.toBeInTheDocument();
  });

  it("does not show 'Review metadata' action when no callback is provided", () => {
    renderPanel({ onReviewMetadata: undefined });
    expect(
      screen.queryByText("Review metadata"),
    ).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Obligations subsection
  // -------------------------------------------------------------------------

  it("renders the obligations section heading", () => {
    renderPanel();
    expect(screen.getByTestId("key-terms-obligations")).toBeInTheDocument();
  });

  it("renders the obligations empty state in non-demo mode", () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "false");
    renderPanel();
    expect(
      screen.getByTestId("key-terms-obligations-empty"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("key-terms-obligations-empty")).toHaveTextContent(
      /no obligations have been captured yet/i,
    );
  });

  it("renders the obligations empty state for an unknown contract in demo mode", () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
    renderPanel({
      contract: contract({ id: "unknown-id" }),
    });
    expect(
      screen.getByTestId("key-terms-obligations-empty"),
    ).toBeInTheDocument();
  });

  it("renders demo obligations for a known contract id in demo mode", () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
    renderPanel({
      contract: contract({ id: "00000000-0000-4000-8000-000000000001" }),
    });
    expect(
      screen.queryByTestId("key-terms-obligations-empty"),
    ).not.toBeInTheDocument();
    const rows = screen.getAllByTestId("key-terms-obligation-row");
    expect(rows.length).toBeGreaterThan(0);
    // Demo label should be present
    expect(screen.getByText(/demo data/i)).toBeInTheDocument();
  });
});
