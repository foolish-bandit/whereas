import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DuplicateMergePanel from "../DuplicateMergePanel";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const SAMPLE_CANDIDATE = {
  contract_id: "00000000-0000-4000-8000-000000000002",
  title: "Acme MSA 2026",
  reason: "exact_file_hash" as const,
  confidence: "exact" as const,
  created_at: "2026-05-01T10:00:00Z",
  status: "ready",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("DuplicateMergePanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("renders nothing when there are no candidates", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [] }));
    const { container } = render(
      <DuplicateMergePanel targetContractId="00000000-0000-4000-8000-000000000001" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector("[data-testid='duplicate-merge-panel']")).toBeNull();
  });

  it("renders candidates and the merge action when present", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ candidates: [SAMPLE_CANDIDATE] }),
    );
    render(
      <DuplicateMergePanel targetContractId="00000000-0000-4000-8000-000000000001" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("duplicate-merge-panel")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("duplicate-merge-row-title")).toHaveTextContent(
      "Acme MSA 2026",
    );
    expect(screen.getByTestId("duplicate-merge-action")).toHaveTextContent(
      /merge into this repository record/i,
    );
  });

  it("shows a confirmation modal that explains files are NOT deleted", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ candidates: [SAMPLE_CANDIDATE] }),
    );
    render(
      <DuplicateMergePanel targetContractId="00000000-0000-4000-8000-000000000001" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("duplicate-merge-action")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("duplicate-merge-action"));

    const modal = screen.getByTestId("duplicate-merge-modal");
    expect(modal).toBeInTheDocument();
    const body = screen.getByTestId("duplicate-merge-modal-body").textContent ?? "";
    expect(body.toLowerCase()).toContain("document history");
    expect(body.toLowerCase()).toContain("no files are deleted");
    expect(body.toLowerCase()).toContain("hidden from normal repository results");
    expect(body.toLowerCase()).not.toContain("docuseal will be contacted");
  });

  it("calls the merge API and refreshes candidates on confirm", async () => {
    let mergeCalled = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/duplicate-candidates") &&
        (!init || init.method === undefined || init.method === "GET")
      ) {
        return jsonResponse({
          candidates: mergeCalled ? [] : [SAMPLE_CANDIDATE],
        });
      }
      if (url.endsWith("/merge-duplicate") && init?.method === "POST") {
        mergeCalled = true;
        return jsonResponse({
          target_contract_id: "00000000-0000-4000-8000-000000000001",
          source_contract_id: SAMPLE_CANDIDATE.contract_id,
          artifacts_moved: 2,
          merged_at: "2026-05-11T12:00:00Z",
          merged_by_user_id: DEV_USER,
          workflow_runs_attached_to_source: 0,
          requests_attached_to_source: 0,
        });
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });

    const onMerged = vi.fn();
    render(
      <DuplicateMergePanel
        targetContractId="00000000-0000-4000-8000-000000000001"
        onMerged={onMerged}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("duplicate-merge-action")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("duplicate-merge-action"));
    fireEvent.click(screen.getByTestId("duplicate-merge-modal-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("duplicate-merge-success")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("duplicate-merge-success")).toHaveTextContent(
      /merged\. 2 files moved/i,
    );
    expect(onMerged).toHaveBeenCalled();
    // After refresh, the panel disappears because candidates is empty.
    await waitFor(() =>
      expect(screen.queryByTestId("duplicate-merge-panel")).toBeNull(),
    );
  });

  it("renders a safe error state when the merge API errors", async () => {
    let firstCall = true;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/duplicate-candidates") && firstCall) {
        firstCall = false;
        return jsonResponse({ candidates: [SAMPLE_CANDIDATE] });
      }
      if (url.endsWith("/merge-duplicate") && init?.method === "POST") {
        return jsonResponse(
          { detail: "This Repository record has already been merged." },
          409,
        );
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });

    render(
      <DuplicateMergePanel targetContractId="00000000-0000-4000-8000-000000000001" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("duplicate-merge-action")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("duplicate-merge-action"));
    fireEvent.click(screen.getByTestId("duplicate-merge-modal-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("duplicate-merge-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("duplicate-merge-error")).toHaveTextContent(
      /already been merged/i,
    );
  });

  it("does not render storage internals in the DOM", async () => {
    // Even if the server returned forbidden keys, scrubSecrets drops
    // them. This is the regression net for that.
    fetchMock.mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            ...SAMPLE_CANDIDATE,
            storage_key: "bucket/leaky/key",
            wrapped_dek: "AAAA",
            s3_key: "x",
          },
        ],
      }),
    );
    render(
      <DuplicateMergePanel targetContractId="00000000-0000-4000-8000-000000000001" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("duplicate-merge-panel")).toBeInTheDocument(),
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("storage_key");
    expect(text).not.toContain("wrapped_dek");
    expect(text).not.toContain("s3_key");
  });

  it("cancels without calling the merge API", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ candidates: [SAMPLE_CANDIDATE] }),
    );
    render(
      <DuplicateMergePanel targetContractId="00000000-0000-4000-8000-000000000001" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("duplicate-merge-action")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("duplicate-merge-action"));
    expect(screen.getByTestId("duplicate-merge-modal")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("duplicate-merge-modal-cancel"));
    expect(screen.queryByTestId("duplicate-merge-modal")).toBeNull();
    // Only the candidates GET was issued; no POST.
    const calls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(calls).toHaveLength(0);
  });
});
