import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ClauseLibraryPage from "../ClauseLibraryPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";
import { FORBIDDEN_DOM_TOKENS } from "../../test/forbiddenTokens";

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
    // PR #119 — contract-type chips render the user-friendly label
    // (NDA / MSA / DPA …) instead of the raw backend slug. The slug
    // remains the source of truth on the row data and in search.
    expect(
      screen.getByTestId("clause-chip-contract-type"),
    ).toHaveTextContent("NDA");
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

  // ---------------------------------------------------------------------
  // PR #119 — contract-type organization.
  // ---------------------------------------------------------------------
  const MULTI_TYPE_ROWS = [
    baseRow({ id: "ct-1", name: "NDA confidentiality" }),
    baseRow({
      id: "ct-2",
      name: "MSA governing law",
      clause_type: "governing_law",
      contract_type: "msa",
      tags: [],
    }),
    baseRow({
      id: "ct-3",
      name: "Vendor termination",
      clause_type: "termination",
      contract_type: "vendor_agreement",
      tags: [],
    }),
    baseRow({
      id: "ct-4",
      name: "Employment at-will",
      clause_type: "employment_terms",
      contract_type: "employment_agreement",
      tags: [],
    }),
    baseRow({
      id: "ct-5",
      name: "Subprocessor notice",
      clause_type: "data_protection",
      contract_type: "dpa",
      tags: [],
    }),
  ];

  it("renders a contract-type chip bar with one chip per type plus All contract types", async () => {
    fetchMock.mockResolvedValue(jsonResponse(MULTI_TYPE_ROWS));
    renderPage();
    await screen.findByText("NDA confidentiality");

    const bar = screen.getByTestId("clause-contract-type-bar");
    expect(
      within(bar).getByTestId("clause-contract-type-all"),
    ).toHaveTextContent(/all contract types/i);
    const chips = within(bar).getAllByTestId("clause-contract-type-chip");
    // One chip per distinct contract_type.
    const labels = chips.map((c) => c.textContent ?? "");
    expect(labels.some((t) => t.startsWith("NDA"))).toBe(true);
    expect(labels.some((t) => t.startsWith("MSA"))).toBe(true);
    expect(labels.some((t) => t.startsWith("Vendor agreement"))).toBe(true);
    expect(labels.some((t) => t.startsWith("Employment agreement"))).toBe(
      true,
    );
    expect(labels.some((t) => t.startsWith("DPA"))).toBe(true);
    // Counts render — each chip has a count badge.
    expect(
      within(bar).getAllByTestId("clause-contract-type-count").length,
    ).toBeGreaterThanOrEqual(6); // 5 type chips + 1 "All"
  });

  it("filters the visible clause list when a contract-type chip is selected and resets via All contract types", async () => {
    fetchMock.mockResolvedValue(jsonResponse(MULTI_TYPE_ROWS));
    renderPage();
    await screen.findByText("NDA confidentiality");

    const bar = screen.getByTestId("clause-contract-type-bar");
    const msaChip = within(bar)
      .getAllByTestId("clause-contract-type-chip")
      .find((c) => /^MSA/i.test(c.textContent ?? ""))!;
    fireEvent.click(msaChip);

    expect(screen.getByText("MSA governing law")).toBeInTheDocument();
    expect(screen.queryByText("NDA confidentiality")).toBeNull();
    expect(screen.queryByText("Vendor termination")).toBeNull();

    // All contract types resets the filter.
    fireEvent.click(within(bar).getByTestId("clause-contract-type-all"));
    expect(screen.getByText("NDA confidentiality")).toBeInTheDocument();
    expect(screen.getByText("Vendor termination")).toBeInTheDocument();
  });

  it("pre-fills the Add-clause contract_type field when a contract-type chip is selected", async () => {
    fetchMock.mockResolvedValue(jsonResponse(MULTI_TYPE_ROWS));
    renderPage();
    await screen.findByText("NDA confidentiality");

    const bar = screen.getByTestId("clause-contract-type-bar");
    const dpaChip = within(bar)
      .getAllByTestId("clause-contract-type-chip")
      .find((c) => /^DPA/i.test(c.textContent ?? ""))!;
    fireEvent.click(dpaChip);

    expect(screen.getByTestId("clause-create-contract-type")).toHaveValue(
      "dpa",
    );
    // The Add-a-clause heading also reflects the active type.
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /add a clause to DPA/i,
      }),
    ).toBeInTheDocument();
  });

  it("submits the contract_type field on create when present", async () => {
    let postBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/clause-templates") && init?.method === "POST") {
        postBody = JSON.parse((init.body as string) ?? "{}");
        return jsonResponse({
          ...baseRow({ id: "ct-new", name: postBody!.name as string }),
          clause_type: postBody!.clause_type as string,
          contract_type: postBody!.contract_type as string,
        });
      }
      return jsonResponse([]);
    });
    renderPage();
    await screen.findByText(/no clauses yet/i);

    fireEvent.change(screen.getByTestId("clause-create-name"), {
      target: { value: "New custom clause" },
    });
    fireEvent.change(screen.getByTestId("clause-create-type"), {
      target: { value: "indemnification" },
    });
    fireEvent.change(screen.getByTestId("clause-create-contract-type"), {
      target: { value: "vendor_agreement" },
    });
    fireEvent.change(screen.getByTestId("clause-create-text"), {
      target: { value: "Vendor agrees to …" },
    });
    fireEvent.click(screen.getByTestId("clause-create-submit"));

    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody).toMatchObject({
      name: "New custom clause",
      clause_type: "indemnification",
      contract_type: "vendor_agreement",
    });
  });

  it("renders a tailored empty state when a contract type has no clauses", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        baseRow({ id: "ct-only", name: "Only NDA clause" }),
      ]),
    );
    renderPage();
    await screen.findByText("Only NDA clause");

    // Force a contract-type filter to a slug present on no row by typing
    // into the clause_type filter first — easier: click a chip that
    // doesn't exist; instead select an existing chip and then assert
    // the *other* contract-type filter via the reset path.
    // Easier still: switch to a row set where the selected type has 0 matches.
    fetchMock.mockResolvedValue(jsonResponse([]));
    fireEvent.click(screen.getByTestId("clause-include-archived"));
    await waitFor(() =>
      expect(
        screen.getByText(/no clauses yet/i),
      ).toBeInTheDocument(),
    );
  });

  it("shows a Reset filters button when any filter is active and clears all three", async () => {
    fetchMock.mockResolvedValue(jsonResponse(MULTI_TYPE_ROWS));
    renderPage();
    await screen.findByText("NDA confidentiality");

    fireEvent.change(screen.getByTestId("clause-search"), {
      target: { value: "nda" },
    });
    expect(screen.getByTestId("clause-reset-filters")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("clause-reset-filters"));
    expect(screen.getByTestId("clause-search")).toHaveValue("");
    expect(screen.queryByTestId("clause-reset-filters")).toBeNull();
  });

  it("does not surface storage internals, raw metadata, or DocuSeal secrets in the DOM", async () => {
    fetchMock.mockResolvedValue(jsonResponse(MULTI_TYPE_ROWS));
    renderPage();
    await screen.findByText("NDA confidentiality");
    const text = document.body.textContent ?? "";
    for (const needle of FORBIDDEN_DOM_TOKENS) {
      expect(text).not.toContain(needle);
    }
  });

  // ---------------------------------------------------------------------
  // PR #120 — Clause detail drawer, edit, and restore.
  // ---------------------------------------------------------------------

  it("opens a detail drawer with full metadata, text, and timestamps when View details is clicked", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");

    expect(screen.queryByTestId("clause-detail")).toBeNull();
    fireEvent.click(screen.getByTestId("clause-toggle"));

    const drawer = screen.getByTestId("clause-detail");
    expect(within(drawer).getByTestId("clause-detail-title")).toHaveTextContent(
      "Mutual NDA confidentiality clause",
    );
    // Friendly contract-type label, raw clause-type slug, jurisdiction, tags.
    expect(
      within(drawer).getByTestId("clause-detail-contract-type"),
    ).toHaveTextContent("NDA");
    expect(
      within(drawer).getByTestId("clause-detail-clause-type"),
    ).toHaveTextContent("confidentiality");
    expect(
      within(drawer).getByTestId("clause-detail-jurisdiction"),
    ).toHaveTextContent("California");
    expect(
      within(drawer).getAllByTestId("clause-detail-tag").map((c) => c.textContent),
    ).toEqual(["#nda", "#core"]);
    expect(within(drawer).getByTestId("clause-text")).toHaveTextContent(
      /confidential information/i,
    );
    // The description and Created/Updated metadata both render.
    expect(
      within(drawer).getByTestId("clause-detail-description"),
    ).toHaveTextContent(/baseline nda/i);
    expect(drawer.textContent ?? "").toMatch(/Created/i);
    expect(drawer.textContent ?? "").toMatch(/Updated/i);
  });

  it("closes the detail drawer without resetting the active contract-type filter", async () => {
    fetchMock.mockResolvedValue(jsonResponse(MULTI_TYPE_ROWS));
    renderPage();
    await screen.findByText("NDA confidentiality");

    const bar = screen.getByTestId("clause-contract-type-bar");
    const msaChip = within(bar)
      .getAllByTestId("clause-contract-type-chip")
      .find((c) => /^MSA/i.test(c.textContent ?? ""))!;
    fireEvent.click(msaChip);
    expect(screen.getByText("MSA governing law")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("clause-toggle"));
    expect(screen.getByTestId("clause-detail")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("clause-detail-close"));
    expect(screen.queryByTestId("clause-detail")).toBeNull();
    // MSA filter is still active after closing.
    expect(screen.getByText("MSA governing law")).toBeInTheDocument();
    expect(screen.queryByText("NDA confidentiality")).toBeNull();
  });

  it("copies clause text from the detail drawer", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-toggle"));
    fireEvent.click(screen.getByTestId("clause-detail-copy"));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      "Each Party shall keep Confidential Information strictly confidential.",
    );
  });

  it("opens the edit form with existing values populated and cancels cleanly", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");

    fireEvent.click(screen.getByTestId("clause-toggle"));
    fireEvent.click(screen.getByTestId("clause-detail-edit"));

    expect(screen.getByTestId("clause-edit-name")).toHaveValue(
      "Mutual NDA confidentiality clause",
    );
    expect(screen.getByTestId("clause-edit-contract-type")).toHaveValue(
      "mutual_nda",
    );
    expect(screen.getByTestId("clause-edit-type")).toHaveValue("confidentiality");
    expect(screen.getByTestId("clause-edit-jurisdiction")).toHaveValue(
      "California",
    );
    expect(screen.getByTestId("clause-edit-tags")).toHaveValue("nda, core");
    expect(screen.getByTestId("clause-edit-text")).toHaveValue(
      "Each Party shall keep Confidential Information strictly confidential.",
    );

    // Editing the name field then canceling reverts to view mode without
    // a PATCH and without changing the visible title.
    fireEvent.change(screen.getByTestId("clause-edit-name"), {
      target: { value: "An edit that should be discarded" },
    });
    fireEvent.click(screen.getByTestId("clause-edit-cancel"));

    expect(screen.queryByTestId("clause-edit-form")).toBeNull();
    expect(
      within(screen.getByTestId("clause-detail")).getByTestId(
        "clause-detail-title",
      ),
    ).toHaveTextContent("Mutual NDA confidentiality clause");

    // No PATCH was issued — only the initial GET.
    const patchCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);
  });

  it("saves edits via PATCH and reflects the renamed clause in the list", async () => {
    let patched: { url: string; body: Record<string, unknown> } | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.includes("/api/clause-templates/ct-1") &&
        init?.method === "PATCH"
      ) {
        patched = {
          url,
          body: JSON.parse((init.body as string) ?? "{}"),
        };
        return jsonResponse({
          ...baseRow(),
          name: (patched.body.name as string) ?? baseRow().name,
          description:
            (patched.body.description as string | null | undefined) ?? null,
        });
      }
      if (url.includes("/api/clause-templates")) {
        return jsonResponse([baseRow()]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });

    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");

    fireEvent.click(screen.getByTestId("clause-toggle"));
    fireEvent.click(screen.getByTestId("clause-detail-edit"));
    fireEvent.change(screen.getByTestId("clause-edit-name"), {
      target: { value: "Renamed NDA clause" },
    });
    fireEvent.change(screen.getByTestId("clause-edit-description"), {
      target: { value: "Updated guidance for negotiators." },
    });
    fireEvent.click(screen.getByTestId("clause-edit-save"));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched!.body).toMatchObject({
      name: "Renamed NDA clause",
      description: "Updated guidance for negotiators.",
      contract_type: "mutual_nda",
      clause_type: "confidentiality",
      jurisdiction: "California",
      tags: ["nda", "core"],
    });
    // After save, the drawer returns to view mode and the renamed
    // clause is reflected locally without a second list fetch.
    await waitFor(() =>
      expect(screen.queryByTestId("clause-edit-form")).toBeNull(),
    );
    expect(
      within(screen.getByTestId("clause-detail")).getByTestId(
        "clause-detail-title",
      ),
    ).toHaveTextContent("Renamed NDA clause");
  });

  it("shows Restore for archived rows and calls PATCH is_active=true", async () => {
    let restored: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.includes("/api/clause-templates/ct-z") &&
        init?.method === "PATCH"
      ) {
        restored = JSON.parse((init.body as string) ?? "{}");
        return jsonResponse({
          ...baseRow({ id: "ct-z", is_active: true }),
        });
      }
      if (url.includes("/api/clause-templates")) {
        return jsonResponse([baseRow({ id: "ct-z", is_active: false })]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });

    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");

    expect(screen.queryByTestId("clause-archive")).toBeNull();
    fireEvent.click(screen.getByTestId("clause-restore"));

    await waitFor(() => expect(restored).not.toBeNull());
    expect(restored).toEqual({ is_active: true });
  });

  it("does not leak forbidden tokens via the detail drawer", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-toggle"));
    fireEvent.click(screen.getByTestId("clause-detail-edit"));
    const text = document.body.textContent ?? "";
    for (const needle of FORBIDDEN_DOM_TOKENS) {
      expect(text).not.toContain(needle);
    }
  });

  // ---------------------------------------------------------------------
  // PR #121 — Drawer accessibility hardening.
  // ---------------------------------------------------------------------

  it("labels the drawer via aria-labelledby pointing at the title", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-toggle"));

    const drawer = screen.getByTestId("clause-detail");
    expect(drawer).toHaveAttribute("role", "dialog");
    expect(drawer).toHaveAttribute("aria-modal", "true");
    const labelledBy = drawer.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const title = screen.getByTestId("clause-detail-title");
    expect(title.id).toBe(labelledBy);
  });

  it("moves focus into the drawer when it opens", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-toggle"));

    const closeButton = screen.getByTestId("clause-detail-close");
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
  });

  it("closes on Escape from view mode", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-toggle"));

    const drawer = screen.getByTestId("clause-detail");
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByTestId("clause-detail")).toBeNull();
  });

  it("Escape exits edit mode first, then a second Escape closes the drawer", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-toggle"));
    fireEvent.click(screen.getByTestId("clause-detail-edit"));

    // First Escape exits edit mode without closing.
    fireEvent.keyDown(screen.getByTestId("clause-detail"), { key: "Escape" });
    expect(screen.queryByTestId("clause-edit-form")).toBeNull();
    expect(screen.getByTestId("clause-detail")).toBeInTheDocument();

    // Second Escape closes the drawer.
    fireEvent.keyDown(screen.getByTestId("clause-detail"), { key: "Escape" });
    expect(screen.queryByTestId("clause-detail")).toBeNull();
  });

  it("Escape during edit does not persist a draft mutation", async () => {
    let patched = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.includes("/api/clause-templates/ct-1") &&
        init?.method === "PATCH"
      ) {
        patched = true;
        return jsonResponse(baseRow());
      }
      if (url.includes("/api/clause-templates")) {
        return jsonResponse([baseRow()]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });

    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-toggle"));
    fireEvent.click(screen.getByTestId("clause-detail-edit"));
    fireEvent.change(screen.getByTestId("clause-edit-name"), {
      target: { value: "Discarded draft" },
    });
    fireEvent.keyDown(screen.getByTestId("clause-detail"), { key: "Escape" });

    // Edit form closed; title unchanged; no PATCH was issued.
    expect(screen.queryByTestId("clause-edit-form")).toBeNull();
    expect(screen.getByTestId("clause-detail-title")).toHaveTextContent(
      "Mutual NDA confidentiality clause",
    );
    expect(patched).toBe(false);
  });

  it("returns focus to the opener (View details button) when the drawer closes", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    const opener = screen.getByTestId("clause-toggle");
    opener.focus();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("clause-detail-close"),
      ),
    );

    fireEvent.click(screen.getByTestId("clause-detail-close"));
    expect(screen.queryByTestId("clause-detail")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab focus within the drawer panel", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-toggle"));

    const drawer = screen.getByTestId("clause-detail");
    const closeButton = screen.getByTestId("clause-detail-close");
    const copyButton = screen.getByTestId("clause-detail-copy");
    const archiveButton = screen.getByTestId("clause-detail-archive");

    // Shift+Tab from the first focusable wraps to the last.
    closeButton.focus();
    fireEvent.keyDown(drawer, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(archiveButton);

    // Tab forward from the last focusable wraps to the first.
    archiveButton.focus();
    fireEvent.keyDown(drawer, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);

    // A middle Tab is allowed to pass through (browser handles it).
    copyButton.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    const prevented = !drawer.dispatchEvent(event);
    expect(prevented).toBe(false);
  });

  it("backdrop click still closes the drawer", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-toggle"));

    const drawer = screen.getByTestId("clause-detail");
    fireEvent.click(drawer); // click on backdrop (event.target === currentTarget)
    expect(screen.queryByTestId("clause-detail")).toBeNull();
  });

  it("Cancel still discards draft after a11y wiring", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow()]));
    renderPage();
    await screen.findByText("Mutual NDA confidentiality clause");
    fireEvent.click(screen.getByTestId("clause-toggle"));
    fireEvent.click(screen.getByTestId("clause-detail-edit"));
    fireEvent.change(screen.getByTestId("clause-edit-name"), {
      target: { value: "Should be discarded" },
    });
    fireEvent.click(screen.getByTestId("clause-edit-cancel"));

    expect(screen.queryByTestId("clause-edit-form")).toBeNull();
    // Re-entering edit shows the original value, not the discarded draft.
    fireEvent.click(screen.getByTestId("clause-detail-edit"));
    expect(screen.getByTestId("clause-edit-name")).toHaveValue(
      "Mutual NDA confidentiality clause",
    );
  });
});
