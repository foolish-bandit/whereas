import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import UploadReviewPanel from "../UploadReviewPanel";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";
import type {
  DuplicateContractCandidate,
  ExtractedContractMetadata,
} from "../../types/contractIntake";

const DEV_USER = "11111111-1111-4111-8111-111111111111";
const CONTRACT_ID = "contract-fresh-1";

const SAMPLE_METADATA: ExtractedContractMetadata = {
  suggested_title: "Mutual NDA Acme",
  likely_contract_type: "NDA",
  possible_counterparty_name: "Acme Corp",
  effective_date: "2026-05-01",
  warnings: ["effective_date_unknown"],
};

const SAMPLE_DUPLICATE: DuplicateContractCandidate = {
  contract_id: "contract-existing-1",
  title: "Mutual NDA — Acme",
  reason: "exact_file_hash",
  confidence: "exact",
  created_at: "2026-04-01T12:00:00Z",
  status: "ready",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPanel(props?: Partial<Parameters<typeof UploadReviewPanel>[0]>) {
  return render(
    <MemoryRouter>
      <UploadReviewPanel
        contract={{ id: CONTRACT_ID, title: "Acme NDA — countersigned" }}
        extractedMetadata={SAMPLE_METADATA}
        duplicateCandidates={[SAMPLE_DUPLICATE]}
        context="request_upload"
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("UploadReviewPanel", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("renders the review header + form fields prepopulated with the current/saved title", () => {
    renderPanel();
    expect(screen.getByTestId("upload-review-header")).toHaveTextContent(
      /Review upload/i,
    );
    expect(
      (screen.getByTestId("upload-review-title") as HTMLInputElement).value,
    ).toBe("Acme NDA — countersigned");
    // Counterparty / contract type / effective date are pre-filled from
    // the extracted suggestions because no "saved" view exists yet.
    expect(
      (screen.getByTestId("upload-review-counterparty") as HTMLInputElement)
        .value,
    ).toBe("Acme Corp");
    expect(
      (screen.getByTestId("upload-review-contract-type") as HTMLInputElement)
        .value,
    ).toBe("NDA");
    expect(
      (screen.getByTestId("upload-review-effective-date") as HTMLInputElement)
        .value,
    ).toBe("2026-05-01");
  });

  it("renders the duplicate-warning section with a deep link to Repository", () => {
    renderPanel();
    const link = screen.getByTestId("upload-review-duplicate-link");
    expect(link).toHaveAttribute(
      "href",
      `/demo/repository/${SAMPLE_DUPLICATE.contract_id}`,
    );
  });

  it("dismisses the duplicate warning when the user keeps the upload as new", () => {
    renderPanel();
    expect(
      screen.getByTestId("upload-review-duplicate-warning"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("upload-review-keep-as-new"));
    expect(
      screen.queryByTestId("upload-review-duplicate-warning"),
    ).toBeNull();
    expect(
      screen.getByTestId("upload-review-no-duplicates"),
    ).toHaveTextContent(/dismissed/i);
  });

  it("renders the quiet no-duplicates state when the list is empty", () => {
    renderPanel({ duplicateCandidates: [] });
    expect(
      screen.queryByTestId("upload-review-duplicate-warning"),
    ).toBeNull();
    expect(
      screen.getByTestId("upload-review-no-duplicates"),
    ).toHaveTextContent(/no obvious duplicates/i);
  });

  it("calls the metadata endpoint on save and reflects the saved state", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        contract_id: CONTRACT_ID,
        title: "Acme NDA — countersigned",
        counterparty_name: "Acme Corp",
        contract_type: "NDA",
        effective_date: "2026-05-01",
        updated_at: "2026-05-10T12:00:00Z",
        changed_fields: ["counterparty_name", "contract_type", "effective_date"],
      }),
    );
    const onSaved = vi.fn();
    renderPanel({ onSaved });

    fireEvent.click(screen.getByTestId("upload-review-save"));

    // Submit fires a PATCH with the right URL + body shape.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/api/contracts/${CONTRACT_ID}/metadata`);
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    // Empty user-entered strings normalize to "" so the server clears
    // the field; ``title`` honors the saved/initial value.
    expect(body.title).toBe("Acme NDA — countersigned");
    expect(body.counterparty_name).toBe("Acme Corp");
    expect(body.contract_type).toBe("NDA");
    expect(body.effective_date).toBe("2026-05-01");

    // Saved-state badge surfaces after the response lands.
    expect(
      await screen.findByTestId("upload-review-saved"),
    ).toHaveTextContent(/Saved 3 fields/i);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("sends empty strings to clear non-title fields when the user blanks them", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        contract_id: CONTRACT_ID,
        title: "Acme NDA — countersigned",
        counterparty_name: null,
        contract_type: null,
        effective_date: null,
        updated_at: "2026-05-10T12:00:00Z",
        changed_fields: ["counterparty_name"],
      }),
    );
    renderPanel();

    fireEvent.change(screen.getByTestId("upload-review-counterparty"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("upload-review-save"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    // Empty counterparty surfaces as "" so the server treats it as a
    // clear (vs missing key, which would leave it unchanged).
    expect(body.counterparty_name).toBe("");
  });

  it("renders an error banner when the PATCH fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: "Update failed: bad request." }, 400),
    );
    renderPanel();

    fireEvent.click(screen.getByTestId("upload-review-save"));

    expect(
      await screen.findByTestId("upload-review-error"),
    ).toHaveTextContent(/Update failed/i);
  });

  it("never surfaces storage internals in the DOM", () => {
    renderPanel();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("storage_key");
    expect(text).not.toContain("wrapped_dek");
    expect(text).not.toContain("s3_key");
  });

  it("uses request-upload copy when context='request_upload'", () => {
    renderPanel({ context: "request_upload" });
    expect(screen.getByTestId("upload-review-header")).toHaveTextContent(
      /linked to this request/i,
    );
  });

  it("uses repository-upload copy when context='repository_upload'", () => {
    renderPanel({ context: "repository_upload" });
    expect(screen.getByTestId("upload-review-header")).not.toHaveTextContent(
      /linked to this request/i,
    );
  });
});
