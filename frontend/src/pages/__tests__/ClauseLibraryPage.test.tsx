import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ClauseLibraryPage from "../ClauseLibraryPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ct-1",
    organization_id: "org-1",
    name: "Mutual NDA confidentiality clause",
    clause_type: "confidentiality",
    text: "Each Party shall keep Confidential Information strictly confidential.",
    description: "Baseline NDA confidentiality",
    jurisdiction: "California",
    contract_type: "mutual_nda",
    version: "1.0",
    source: "Firm standard",
    tags: ["nda", "core"],
    is_active: true,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
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
    <MemoryRouter initialEntries={["/demo/clause-manager"]}>
      <ClauseLibraryPage />
    </MemoryRouter>,
  );
}

describe("ClauseLibraryPage", () => {
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

  it("shows a loading skeleton then the list", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
    expect(
      await screen.findByText("Mutual NDA confidentiality clause"),
    ).toBeInTheDocument();
  });

  it("renders metadata chips and an Active status pill", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    expect(screen.getByTestId("clause-status-pill")).toHaveTextContent(/active/i);
    expect(screen.getByTestId("clause-chip-type")).toHaveTextContent(
      "confidentiality",
    );
    expect(
      screen.getByTestId("clause-chip-jurisdiction"),
    ).toHaveTextContent("California");
    expect(
      screen.getByTestId("clause-chip-contract-type"),
    ).toHaveTextContent("mutual_nda");
    const tagChips = screen.getAllByTestId("clause-chip-tag");
    expect(tagChips.map((c) => c.textContent)).toEqual(["#nda", "#core"]);
  });

  it("renders an Archived pill when is_active is false", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([baseRow({ id: "ct-z", is_active: false })]),
    );
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    expect(screen.getByTestId("clause-status-pill")).toHaveTextContent(
      /archived/i,
    );
    // Archive button should not appear on rows that are already archived.
    expect(screen.queryByTestId("clause-archive")).toBeNull();
  });

  it("toggles include_inactive on the list request when 'Show archived' is checked", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-include-archived"));
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string;
      expect(lastCall).toMatch(/include_inactive=true/);
    });
  });

  it("expands and shows the clause text on demand", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    // Text isn't visible until expand.
    expect(screen.queryByTestId("clause-text")).toBeNull();
    fireEvent.click(screen.getByTestId("clause-toggle"));
    expect(screen.getByTestId("clause-text")).toHaveTextContent(
      /confidential information/i,
    );
  });

  it("archives a clause only after explicit confirmation", async () => {
    let deleted = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/clause-templates/ct-1") && init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/api/clause-templates")) {
        if (deleted) return jsonResponse([]);
        return jsonResponse([baseRow()]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    // Single click on Archive opens confirm — does not call DELETE yet.
    fireEvent.click(screen.getByTestId("clause-archive"));
    expect(deleted).toBe(false);
    expect(screen.getByTestId("clause-cancel-archive")).toBeInTheDocument();
    // Confirm triggers the request.
    fireEvent.click(screen.getByTestId("clause-confirm-archive"));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it("cancels the archive confirm without calling DELETE", async () => {
    let deleted = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/clause-templates/ct-1") && init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url.includes("/api/clause-templates")) {
        return jsonResponse([baseRow()]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-archive"));
    fireEvent.click(screen.getByTestId("clause-cancel-archive"));
    expect(deleted).toBe(false);
    // Archive button should be back, no confirm visible.
    expect(screen.getByTestId("clause-archive")).toBeInTheDocument();
    expect(screen.queryByTestId("clause-confirm-archive")).toBeNull();
  });

  it("renders an error state when the list endpoint fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
    renderPage();
    expect(
      await screen.findByText(/could not load clauses/i),
    ).toBeInTheDocument();
  });

  it("renders an empty state when there are no clauses", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage();
    expect(await screen.findByText(/no clauses yet/i)).toBeInTheDocument();
  });

  it("filters via search across name, type, jurisdiction, tags, and text", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        baseRow(),
        baseRow({ id: "ct-2", name: "Assignment", clause_type: "assignment", tags: [] }),
      ]),
    );
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.change(screen.getByTestId("clause-search"), {
      target: { value: "assignment" },
    });
    await waitFor(() => {
      expect(
        screen.queryByText("Mutual NDA confidentiality clause"),
      ).toBeNull();
    });
    expect(screen.getByText("Assignment")).toBeInTheDocument();
  });

  it("sends clause_type as a server-side filter when the filter input is set", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.change(screen.getByTestId("clause-filter-type"), {
      target: { value: "governing_law" },
    });
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string;
      expect(lastCall).toMatch(/clause_type=governing_law/);
    });
  });
});
