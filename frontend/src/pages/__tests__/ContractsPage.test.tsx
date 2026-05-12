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

  it("renders 'Matched title' chip when search_match_source=title (PR #101)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([row({ search_match_source: "title" })]),
    );
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=Acme"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    // ContractTable renders both the mobile card list and the
    // desktop table (CSS media queries don't apply in jsdom). Both
    // chips carry the same data-source value, so test the first.
    const chips = await screen.findAllByTestId(
      "repository-match-source-chip",
    );
    expect(chips[0]).toHaveTextContent(/matched title/i);
    expect(chips[0]).not.toHaveTextContent(/text preview/i);
    expect(chips[0]).toHaveAttribute("data-source", "title");
  });

  it("renders 'Matched Text preview' chip when search_match_source=text_preview", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([row({ search_match_source: "text_preview" })]),
    );
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=indem"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    const chips = await screen.findAllByTestId(
      "repository-match-source-chip",
    );
    expect(chips[0]).toHaveTextContent(/matched text preview/i);
    expect(chips[0]).toHaveAttribute("data-source", "text_preview");
  });

  it("renders 'Matched title + Text preview' chip when both matched", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([row({ search_match_source: "title_and_text_preview" })]),
    );
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=acme"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    const chips = await screen.findAllByTestId(
      "repository-match-source-chip",
    );
    expect(chips[0]).toHaveTextContent(/matched title \+ text preview/i);
    expect(chips[0]).toHaveAttribute(
      "data-source",
      "title_and_text_preview",
    );
  });

  it("does NOT render any match-source chip when q is absent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([row({ search_match_source: null })]),
    );
    renderPage();
    await screen.findAllByText("Acme NDA");
    expect(
      screen.queryAllByTestId("repository-match-source-chip"),
    ).toHaveLength(0);
  });

  it("does not surface raw text or storage internals when chip is rendered", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([row({ search_match_source: "text_preview" })]),
    );
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=indem"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("repository-match-source-chip");
    const text = document.body.textContent ?? "";
    for (const needle of [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "metadata_json",
      "markdown_text",
      "private_url",
      "presigned",
      "docuseal_secret",
    ]) {
      expect(text).not.toContain(needle);
    }
  });

  it("placeholder + no-matches copy mention Text preview content (PR #100)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("q=zzz")) return jsonResponse([]);
      return jsonResponse([row()]);
    });
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=zzz"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    const input = await screen.findByTestId("repository-search");
    expect(input).toHaveAttribute(
      "placeholder",
      expect.stringMatching(/text preview/i),
    );
    await screen.findByText(/no matches/i);
    expect(document.body.textContent ?? "").toMatch(/text preview content/i);
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

  // -------------------------------------------------------------------------
  // PR #104 — Built-in Repository views / presets
  // -------------------------------------------------------------------------

  it("renders the Views control with the default active preset", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    const views = await screen.findByTestId("repository-views");
    expect(views).toBeInTheDocument();
    // Default (no URL params) lands on the "All active" preset.
    expect(
      screen.getByTestId("repository-view-active"),
    ).toHaveAttribute("data-active", "true");
    expect(
      screen.getByTestId("repository-view-active-label"),
    ).toHaveTextContent(/active: all active/i);
  });

  it("selecting Executed pushes status=executed to the URL and refilters", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        row({ id: "c-1", title: "Acme NDA", status: "ready" }),
        row({ id: "c-2", title: "Acme MSA", status: "executed" }),
      ]),
    );
    renderPage();
    await screen.findAllByText("Acme NDA");
    fireEvent.click(screen.getByTestId("repository-view-executed"));
    await waitFor(() => {
      expect(
        screen.getByTestId("repository-view-executed"),
      ).toHaveAttribute("data-active", "true");
    });
    expect(
      (screen.getByTestId("repository-filter-status") as HTMLSelectElement)
        .value,
    ).toBe("executed");
  });

  it("selecting Out for signature applies sent_for_signature filter", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findAllByText("Acme NDA");
    fireEvent.click(screen.getByTestId("repository-view-out_for_signature"));
    await waitFor(() => {
      expect(
        (screen.getByTestId("repository-filter-status") as HTMLSelectElement)
          .value,
      ).toBe("sent_for_signature");
    });
    expect(
      screen.getByTestId("repository-view-active-label"),
    ).toHaveTextContent(/active: out for signature/i);
  });

  it("selecting Merged toggles include_merged=true and reflects in the API call", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findAllByText("Acme NDA");
    fireEvent.click(screen.getByTestId("repository-view-merged"));
    await waitFor(() => {
      const lastUrl = String(fetchMock.mock.calls.at(-1)?.[0] ?? "");
      expect(lastUrl).toContain("include_merged=true");
    });
    expect(
      (screen.getByTestId("repository-include-merged") as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("selecting Recently updated applies the updated_desc sort", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        row({
          id: "c-old",
          title: "Old update",
          updated_at: "2025-12-01T00:00:00Z",
        }),
        row({
          id: "c-new",
          title: "New update",
          updated_at: "2026-05-09T00:00:00Z",
        }),
      ]),
    );
    renderPage();
    await screen.findAllByText("Old update");
    fireEvent.click(screen.getByTestId("repository-view-recently_updated"));
    await waitFor(() => {
      expect(
        (screen.getByTestId("repository-sort") as HTMLSelectElement).value,
      ).toBe("updated_desc");
    });
  });

  it("manually changing status away from the active preset switches to Custom view", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findAllByText("Acme NDA");
    // Pick a preset first so we have a known active view.
    fireEvent.click(screen.getByTestId("repository-view-executed"));
    await waitFor(() =>
      expect(
        screen.getByTestId("repository-view-active-label"),
      ).toHaveTextContent(/active: executed/i),
    );
    // Manually change the status to something that doesn't match any
    // built-in preset (ready) — label switches to "Custom view".
    fireEvent.change(screen.getByTestId("repository-filter-status"), {
      target: { value: "ready" },
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("repository-view-active-label"),
      ).toHaveTextContent(/custom view/i),
    );
  });

  it("preset selection preserves the active q search", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=Acme"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    await screen.findByDisplayValue("Acme");
    fireEvent.click(screen.getByTestId("repository-view-executed"));
    await waitFor(() => {
      const lastUrl = String(fetchMock.mock.calls.at(-1)?.[0] ?? "");
      expect(lastUrl).toContain("q=Acme");
    });
    // The search box still shows the q.
    expect(screen.getByTestId("repository-search")).toHaveValue("Acme");
  });

  it("hydrates from URL params on deep link (?status=executed)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([row({ status: "executed", title: "Done deal" })]),
    );
    render(
      <MemoryRouter initialEntries={["/demo/repository?status=executed"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("repository-views");
    expect(
      (screen.getByTestId("repository-filter-status") as HTMLSelectElement)
        .value,
    ).toBe("executed");
    expect(
      screen.getByTestId("repository-view-active-label"),
    ).toHaveTextContent(/active: executed/i);
  });

  it("hydrates from URL params on deep link (?merged=true)", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    render(
      <MemoryRouter initialEntries={["/demo/repository?merged=true"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("repository-views");
    expect(
      (screen.getByTestId("repository-include-merged") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      screen.getByTestId("repository-view-active-label"),
    ).toHaveTextContent(/active: merged/i);
  });

  // -------------------------------------------------------------------------
  // PR #105 — Advanced filters panel
  // -------------------------------------------------------------------------

  it("renders the Advanced filters toggle (PR #105)", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findByTestId("repository-views");
    expect(
      screen.getByTestId("repository-advanced-toggle"),
    ).toBeInTheDocument();
    // No active filter chip when defaults are in effect.
    expect(
      screen.queryByTestId("repository-advanced-active-count"),
    ).toBeNull();
  });

  it("active filter count reflects q + status + sort + merged", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    render(
      <MemoryRouter
        initialEntries={[
          "/demo/repository?q=Acme&status=executed&sort=oldest&merged=true",
        ]}
      >
        <ContractsPage />
      </MemoryRouter>,
    );
    const chip = await screen.findByTestId("repository-advanced-active-count");
    expect(chip).toHaveTextContent("4");
  });

  it("collapses the panel when toggled and hides filter controls", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findByTestId("repository-views");
    expect(
      screen.getByTestId("repository-advanced-panel"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("repository-advanced-toggle"));
    expect(
      screen.queryByTestId("repository-advanced-panel"),
    ).toBeNull();
    expect(
      screen.queryByTestId("repository-filter-status"),
    ).toBeNull();
    // Toggle button copy flips.
    expect(
      screen.getByTestId("repository-advanced-toggle"),
    ).toHaveTextContent(/advanced filters/i);
  });

  it("clear-search in the panel removes q from URL + state", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=Acme"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("repository-advanced-search-summary");
    fireEvent.click(
      screen.getByTestId("repository-advanced-clear-search"),
    );
    await waitFor(() => {
      expect(
        (screen.getByTestId("repository-search") as HTMLInputElement).value,
      ).toBe("");
    });
    expect(
      screen.queryByTestId("repository-advanced-search-summary"),
    ).toBeNull();
  });

  it("reset all filters clears q/status/sort/merged + returns to All active", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    render(
      <MemoryRouter
        initialEntries={[
          "/demo/repository?q=Acme&status=executed&sort=oldest&merged=true",
        ]}
      >
        <ContractsPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("repository-advanced-active-count");
    fireEvent.click(screen.getByTestId("repository-advanced-reset-all"));
    await waitFor(() => {
      expect(
        (screen.getByTestId("repository-filter-status") as HTMLSelectElement)
          .value,
      ).toBe("all");
    });
    expect(
      (screen.getByTestId("repository-sort") as HTMLSelectElement).value,
    ).toBe("newest");
    expect(
      (screen.getByTestId("repository-include-merged") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (screen.getByTestId("repository-search") as HTMLInputElement).value,
    ).toBe("");
    // Active preset chip + label restore to the default "All active".
    expect(
      screen.getByTestId("repository-view-active"),
    ).toHaveAttribute("data-active", "true");
    expect(
      screen.getByTestId("repository-view-active-label"),
    ).toHaveTextContent(/active: all active/i);
    // Filter count chip disappears once everything is back to defaults.
    expect(
      screen.queryByTestId("repository-advanced-active-count"),
    ).toBeNull();
  });

  it("reset all is disabled when no filters are active", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findByTestId("repository-advanced-panel");
    expect(
      screen.getByTestId("repository-advanced-reset-all"),
    ).toBeDisabled();
  });

  it("Quick Views still work after changes from the advanced panel", async () => {
    fetchMock.mockResolvedValue(jsonResponse([row()]));
    renderPage();
    await screen.findByTestId("repository-views");
    // Change the status from the panel select first.
    fireEvent.change(screen.getByTestId("repository-filter-status"), {
      target: { value: "ready" },
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("repository-view-active-label"),
      ).toHaveTextContent(/custom view/i),
    );
    // Now click a Quick View — it should override the panel state.
    fireEvent.click(screen.getByTestId("repository-view-executed"));
    await waitFor(() => {
      expect(
        (screen.getByTestId("repository-filter-status") as HTMLSelectElement)
          .value,
      ).toBe("executed");
    });
    expect(
      screen.getByTestId("repository-view-active-label"),
    ).toHaveTextContent(/active: executed/i);
  });

  it("no-matches empty state offers Clear search AND Reset filters", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("q=zzz")) return jsonResponse([]);
      return jsonResponse([row()]);
    });
    render(
      <MemoryRouter initialEntries={["/demo/repository?q=zzz"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    await screen.findByText(/no matches/i);
    expect(
      screen.getByTestId("repository-empty-clear-search"),
    ).toBeInTheDocument();
    const reset = screen.getByTestId("repository-empty-reset-filters");
    fireEvent.click(reset);
    await waitFor(() =>
      expect(
        (screen.getByTestId("repository-search") as HTMLInputElement).value,
      ).toBe(""),
    );
  });

  it("does not leak storage internals in the DOM with a preset active", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        row({
          status: "executed",
          search_match_source: "text_preview",
        }),
      ]),
    );
    render(
      <MemoryRouter initialEntries={["/demo/repository?status=executed"]}>
        <ContractsPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("repository-views");
    const text = document.body.textContent ?? "";
    for (const needle of [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned",
      "docuseal_secret",
    ]) {
      expect(text).not.toContain(needle);
    }
  });
});
