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
      expect(link.getAttribute("href")).toBe("/demo/repository/c-1");
    }
  });

  // -------------------------------------------------------------------------
  // PR #95 — Repository search (?q=...)
  // -------------------------------------------------------------------------

  it("renders an accessible search input", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findAllByText("Acme NDA");
    const input = screen.getByTestId("repository-search");
    expect(input).toHaveAttribute("type", "search");
    expect(input).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/search repository/i),
    );
  });

  it("seeds the search box from the ?q= URL param and includes q in the first fetch", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=Acme"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    const input = await screen.findByTestId("repository-search");
    expect(input).toHaveValue("Acme");
    await waitFor(() => {
      const firstCall = fetchMock.mock.calls[0]?.[0] as string;
      expect(firstCall).toContain("q=Acme");
    });
  });

  it("typing in the search box refetches with q after a short debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockResolvedValue(jsonResponse([row()]));
      renderPage();
      await screen.findAllByText("Acme NDA");
      fireEvent.change(screen.getByTestId("repository-search"), {
        target: { value: "msa" },
      });
      vi.advanceTimersByTime(300);
      await waitFor(() => {
        const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string;
        expect(lastCall).toContain("q=msa");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send q when the input is whitespace-only", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockResolvedValue(jsonResponse([row()]));
      renderPage();
      await screen.findAllByText("Acme NDA");
      fireEvent.change(screen.getByTestId("repository-search"), {
        target: { value: "   " },
      });
      vi.advanceTimersByTime(300);
      await waitFor(() => {
        const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string;
        expect(lastCall).not.toContain("q=");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a no-matches empty state when q narrows everything out", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      callCount += 1;
      // First (no q) returns rows so the page learns the repo is
      // non-empty; later calls with q=zzz return [].
      if (String(url).includes("q=zzz")) return jsonResponse([]);
      return jsonResponse([row()]);
    });
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=zzz"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(/no matches/i),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("repository-empty-clear-search"),
    ).toBeInTheDocument();
    expect(callCount).toBeGreaterThan(0);
  });

  it("renders the 'repository is empty' state when there are no records AND no active filter", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage();
    expect(
      await screen.findByText(/repository is empty/i),
    ).toBeInTheDocument();
  });

  it("clear search resets the input and URL and clears the no-matches state", async () => {
    let urls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("q=zzz")) return jsonResponse([]);
      return jsonResponse([row()]);
    });
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=zzz"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    const clear = await screen.findByTestId("repository-empty-clear-search");
    fireEvent.click(clear);
    await waitFor(() => {
      const lastCall = urls.at(-1) ?? "";
      expect(lastCall).not.toContain("q=zzz");
    });
    // Once cleared the seeded row shows up.
    await screen.findAllByText("Acme NDA");
    expect(
      (screen.getByTestId("repository-search") as HTMLInputElement).value,
    ).toBe("");
  });

  it("clear button inside the search box clears the URL", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockResolvedValue(jsonResponse([row()]));
      render(
        <MemoryRouter initialEntries={["/demo/repository?q=Acme"]}>
          <ContractsPage />
        </MemoryRouter>,
      );
      await screen.findAllByText("Acme NDA");
      const clear = await screen.findByTestId("repository-search-clear");
      fireEvent.click(clear);
      vi.advanceTimersByTime(300);
      await waitFor(() => {
        expect(
          (screen.getByTestId("repository-search") as HTMLInputElement).value,
        ).toBe("");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves status filter client-side while q hits the API", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockImplementation(async () =>
        jsonResponse([
          row({ id: "c-1", title: "Acme NDA", status: "ready" }),
          row({
            id: "c-2",
            title: "Acme MSA executed",
            status: "executed",
          }),
        ]),
      );
      renderPage();
      await screen.findAllByText("Acme NDA");
      // Apply status filter — purely client-side, no refetch needed.
      fireEvent.change(screen.getByTestId("repository-filter-status"), {
        target: { value: "executed" },
      });
      // Type a search; q reaches the server.
      fireEvent.change(screen.getByTestId("repository-search"), {
        target: { value: "Acme" },
      });
      vi.advanceTimersByTime(300);
      await waitFor(() => {
        const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string;
        expect(lastCall).toContain("q=Acme");
      });
      // Status filter narrows the on-screen rows to the executed row.
      // The other row's title is no longer present in the DOM.
      await waitFor(() => {
        expect(screen.queryAllByText("Acme NDA")).toHaveLength(0);
      });
      expect(screen.getAllByText("Acme MSA executed").length).toBeGreaterThan(
        0,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("Show merged stacks with search — both params reach the request URL", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockResolvedValue(jsonResponse([row()]));
      render(
        <MemoryRouter initialEntries={["/demo/repository?q=Acme"]}>
          <ContractsPage />
        </MemoryRouter>,
      );
      await screen.findAllByText("Acme NDA");
      fireEvent.click(screen.getByTestId("repository-include-merged"));
      vi.advanceTimersByTime(300);
      await waitFor(() => {
        const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string;
        expect(lastCall).toContain("q=Acme");
        expect(lastCall).toContain("include_merged=true");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not surface storage_key / wrapped_dek / metadata_json in search results", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        row({
          storage_key: "should-not-appear",
          wrapped_dek: "should-not-appear",
        } as Record<string, unknown>),
      ]),
    );
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=Acme"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    await screen.findAllByText("Acme NDA");
    const text = document.body.textContent ?? "";
    for (const needle of [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned",
      "should-not-appear",
    ]) {
      expect(text).not.toContain(needle);
    }
  });
});
