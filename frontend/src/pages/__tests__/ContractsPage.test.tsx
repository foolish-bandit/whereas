import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ContractsPage from "../ContractsPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    title: "Acme NDA",
    status: "ready",
    mime_type: "application/pdf",
    file_hash_sha256: "abcdef0123456789",
    page_count: 3,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    merged_into_contract_id: null,
    merged_at: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/demo/repository"]}>
      <ContractsPage />
    </MemoryRouter>,
  );
}

describe("ContractsPage (Repository list)", () => {
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

  it("includes 'Out for signature' and 'Executed' as filter options", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findAllByText("Acme NDA");
    const select = screen.getByTestId(
      "repository-filter-status",
    ) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(
      expect.arrayContaining(["sent_for_signature", "executed"]),
    );
  });

  it("filters the visible list by the selected status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        row({ id: "c-1", title: "Acme NDA", status: "ready" }),
        row({
          id: "c-2",
          title: "WidgetWorks MSA",
          status: "executed",
        }),
      ]),
    );
    renderPage();
    await screen.findAllByText("Acme NDA");
    fireEvent.change(screen.getByTestId("repository-filter-status"), {
      target: { value: "executed" },
    });
    await waitFor(() => {
      expect(screen.queryAllByText("Acme NDA")).toHaveLength(0);
    });
    expect(screen.getAllByText("WidgetWorks MSA").length).toBeGreaterThan(0);
  });

  it("sorts client-side by oldest first when selected", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        row({
          id: "c-newest",
          title: "Newest",
          created_at: "2026-05-10T00:00:00Z",
        }),
        row({
          id: "c-oldest",
          title: "Oldest",
          created_at: "2026-01-01T00:00:00Z",
        }),
      ]),
    );
    renderPage();
    await screen.findAllByText("Newest");
    fireEvent.change(screen.getByTestId("repository-sort"), {
      target: { value: "oldest" },
    });
    await waitFor(() => {
      const titles = screen
        .getAllByRole("link")
        .map((a) => a.textContent ?? "")
        .filter((t) => t === "Newest" || t === "Oldest");
      // First occurrence reflects the sort: Oldest should appear before Newest.
      expect(titles.indexOf("Oldest")).toBeLessThan(
        titles.indexOf("Newest"),
      );
    });
  });

  it("sorts client-side by title A→Z when selected", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        row({ id: "c-b", title: "Beta" }),
        row({ id: "c-a", title: "Alpha" }),
      ]),
    );
    renderPage();
    await screen.findAllByText("Beta");
    fireEvent.change(screen.getByTestId("repository-sort"), {
      target: { value: "title_asc" },
    });
    await waitFor(() => {
      const titles = screen
        .getAllByRole("link")
        .map((a) => a.textContent ?? "")
        .filter((t) => t === "Alpha" || t === "Beta");
      expect(titles.indexOf("Alpha")).toBeLessThan(titles.indexOf("Beta"));
    });
  });

  it("passes include_merged=true to the API when 'Show merged' is toggled on", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findAllByText("Acme NDA");
    expect(
      (fetchMock.mock.calls[0]?.[0] as string) ?? "",
    ).not.toContain("include_merged=true");
    fireEvent.click(screen.getByTestId("repository-include-merged"));
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string;
      expect(lastCall).toContain("include_merged=true");
    });
  });

  it("renders a Merged chip on rows where merged_into_contract_id is set", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        row({
          id: "c-merged",
          title: "Stale duplicate",
          merged_into_contract_id: "c-target",
          merged_at: "2026-05-09T00:00:00Z",
        }),
      ]),
    );
    renderPage();
    await screen.findAllByText("Stale duplicate");
    // Show-merged is required to get a merged row in the response, but
    // the chip rendering depends only on the row shape we mocked here.
    const chips = screen.getAllByTestId("repository-merged-chip");
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0]).toHaveTextContent(/merged/i);
  });

  it("does not surface storage internals or secrets on the row", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        row({
          // Fields that should never appear; the API client scrubs them
          // but assert defense-in-depth.
          storage_key: "should-not-appear",
          wrapped_dek: "should-not-appear",
          s3_key: "should-not-appear",
        } as Record<string, unknown>),
      ]),
    );
    renderPage();
    await screen.findAllByText("Acme NDA");
    const forbidden = [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "should-not-appear",
      "presigned",
      "private_url",
    ];
    for (const needle of forbidden) {
      expect(document.body.textContent ?? "").not.toContain(needle);
    }
  });

  it("renders a loading skeleton and an empty state correctly", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage();
    expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
    expect(
      await screen.findByText(/the repository is empty/i),
    ).toBeInTheDocument();
  });

  it("renders an error state when the list fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
    renderPage();
    expect(
      await screen.findByText(/could not load repository/i),
    ).toBeInTheDocument();
  });

  it("uses the desktop table layout to render rows when wide enough", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findAllByText("Acme NDA");
    const table = document.querySelector("table");
    expect(table).not.toBeNull();
    // Sanity check: title cell links to the demo contract route.
    if (table) {
      const link = within(table).getByRole("link", { name: "Acme NDA" });
      expect(link.getAttribute("href")).toBe("/demo/contracts/c-1");
    }
  });
});
