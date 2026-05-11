import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import UploadIntakeFeedback from "../UploadIntakeFeedback";
import type {
  DuplicateContractCandidate,
  ExtractedContractMetadata,
} from "../../types/contractIntake";

const SAMPLE_METADATA: ExtractedContractMetadata = {
  suggested_title: "Mutual NDA Acme 2026",
  likely_contract_type: "NDA",
  possible_counterparty_name: "Acme Corp",
  effective_date: "2026-05-01",
  warnings: [],
};

const SAMPLE_DUPLICATE: DuplicateContractCandidate = {
  contract_id: "contract-existing-1",
  title: "Mutual NDA — Acme",
  reason: "exact_file_hash",
  confidence: "exact",
  created_at: "2026-04-01T12:00:00Z",
  status: "ready",
};

function renderFeedback(props: Parameters<typeof UploadIntakeFeedback>[0]) {
  render(
    <MemoryRouter>
      <UploadIntakeFeedback {...props} />
    </MemoryRouter>,
  );
}

describe("UploadIntakeFeedback", () => {
  it("renders extracted metadata fields when present", () => {
    renderFeedback({ extracted: SAMPLE_METADATA });
    expect(
      screen.getByTestId("upload-extracted-metadata"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("upload-meta-contract-type").textContent).toMatch(
      /NDA/,
    );
    expect(screen.getByTestId("upload-meta-counterparty").textContent).toMatch(
      /Acme Corp/,
    );
    expect(
      screen.getByTestId("upload-meta-effective-date").textContent,
    ).toMatch(/2026-05-01/);
    expect(
      screen.getByTestId("upload-meta-suggested-title").textContent,
    ).toMatch(/Mutual NDA Acme 2026/);
  });

  it("renders nothing for an empty metadata + duplicates state (quiet by default)", () => {
    const { container } = render(
      <MemoryRouter>
        <UploadIntakeFeedback
          extracted={{
            suggested_title: null,
            likely_contract_type: null,
            possible_counterparty_name: null,
            effective_date: null,
            warnings: ["contract_type_unknown"],
          }}
          duplicates={[]}
        />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a duplicate warning with a link to the existing contract", () => {
    renderFeedback({ duplicates: [SAMPLE_DUPLICATE] });
    const warning = screen.getByTestId("upload-duplicate-warning");
    expect(warning).toBeInTheDocument();
    expect(warning.textContent ?? "").toMatch(/Possible duplicate/i);
    const link = screen.getByRole("link", {
      name: SAMPLE_DUPLICATE.title,
    });
    expect(link).toHaveAttribute(
      "href",
      `/demo/repository/${SAMPLE_DUPLICATE.contract_id}`,
    );
  });

  it("renders both warning and metadata blocks together when both have content", () => {
    renderFeedback({
      extracted: SAMPLE_METADATA,
      duplicates: [SAMPLE_DUPLICATE],
    });
    expect(screen.getByTestId("upload-duplicate-warning")).toBeInTheDocument();
    expect(
      screen.getByTestId("upload-extracted-metadata"),
    ).toBeInTheDocument();
  });

  it("never surfaces storage internals in the DOM", () => {
    renderFeedback({
      extracted: SAMPLE_METADATA,
      duplicates: [SAMPLE_DUPLICATE],
    });
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("storage_key");
    expect(body).not.toContain("wrapped_dek");
    expect(body).not.toContain("s3_key");
  });

  it("maps each known reason to a human-friendly string", () => {
    const reasons: DuplicateContractCandidate["reason"][] = [
      "exact_file_hash",
      "similar_title_and_counterparty",
      "similar_title",
    ];
    for (const reason of reasons) {
      const candidate = { ...SAMPLE_DUPLICATE, reason };
      const { unmount } = render(
        <MemoryRouter>
          <UploadIntakeFeedback duplicates={[candidate]} />
        </MemoryRouter>,
      );
      const text = screen.getByTestId("upload-duplicate-warning").textContent ?? "";
      // Every reason resolves to user-readable copy — the raw enum
      // tokens should not appear in the DOM.
      expect(text).not.toContain(reason);
      unmount();
    }
  });
});
