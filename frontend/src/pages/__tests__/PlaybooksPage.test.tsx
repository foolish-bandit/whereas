import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PlaybooksPage from "../PlaybooksPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";
import { FORBIDDEN_DOM_TOKENS } from "../../test/forbiddenTokens";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage(path = "/playbooks") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/playbooks" element={<PlaybooksPage />} />
        <Route path="/demo/playbooks" element={<PlaybooksPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PlaybooksPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    // YAML playbook list fetch — keep it empty so the secondary section
    // doesn't dominate; the grid is the test focus.
    fetchMock.mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "false");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearDevUserId();
  });

  // Mobile cards + desktop table both render in JSDOM (CSS hidden only).
  // Scope assertions to the table (`getByRole("table")`) when checking
  // for a single text occurrence; that keeps the test independent of
  // the responsive-duplication.
  function gridTable() {
    return within(screen.getByTestId("review-rules-grid")).getByRole("table");
  }

  it("renders the structured review-rules grid with Summize-style columns and seeded rows", () => {
    renderPage();
    expect(
      screen.getByRole("heading", { name: /^playbooks$/i, level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/review standards, fallback positions/i),
    ).toBeInTheDocument();
    const table = gridTable();
    // All grid columns are present.
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((c) => c.textContent ?? "");
    expect(headers).toEqual(
      expect.arrayContaining([
        "Issue",
        "Contract type",
        "Severity",
        "Standard position",
        "Fallback position",
        "Canned response",
        "Example clause",
        "Status",
      ]),
    );
    // Seeded rows render (scoped to the table to avoid the mobile-card duplicate).
    expect(
      within(table).getByText(/limitation of liability uncapped/i),
    ).toBeInTheDocument();
    expect(
      within(table).getByText(/confidentiality scope too broad/i),
    ).toBeInTheDocument();
    expect(
      within(table).getByText(/auto-renewal without notice/i),
    ).toBeInTheDocument();
    // Severity pills exist.
    expect(
      within(table).getAllByTestId("review-rule-severity-pill").length,
    ).toBeGreaterThan(0);
  });

  it("filters the grid by search text across issue/positions/canned/example", () => {
    renderPage();
    const search = screen.getByTestId("review-rules-search");
    fireEvent.change(search, { target: { value: "auto-renewal" } });
    const table = gridTable();
    expect(
      within(table).getByText(/auto-renewal without notice/i),
    ).toBeInTheDocument();
    expect(
      within(table).queryByText(/limitation of liability uncapped/i),
    ).toBeNull();
  });

  it("filters the grid by contract type", () => {
    renderPage();
    fireEvent.change(
      screen.getByTestId("review-rules-contract-type-filter"),
      { target: { value: "Employment agreement" } },
    );
    const table = gridTable();
    expect(
      within(table).getByText(/non-compete included/i),
    ).toBeInTheDocument();
    expect(
      within(table).queryByText(/limitation of liability uncapped/i),
    ).toBeNull();
  });

  it("filters the grid by severity", () => {
    renderPage();
    fireEvent.change(screen.getByTestId("review-rules-severity-filter"), {
      target: { value: "blocker" },
    });
    const table = gridTable();
    expect(
      within(table).getByText(/limitation of liability uncapped/i),
    ).toBeInTheDocument();
    expect(
      within(table).queryByText(/auto-renewal without notice/i),
    ).toBeNull();
  });

  it("shows a filtered-empty state and clears via Reset filters", () => {
    renderPage();
    fireEvent.change(screen.getByTestId("review-rules-search"), {
      target: { value: "nonsense-zzz-xyz" },
    });
    expect(
      screen.getByTestId("review-rules-empty-filtered"),
    ).toHaveTextContent(/no review rules match/i);
    fireEvent.click(screen.getByTestId("review-rules-reset-filters"));
    expect(screen.queryByTestId("review-rules-empty-filtered")).toBeNull();
    expect(screen.getByTestId("review-rules-search")).toHaveValue("");
  });

  it("opens the Add review rule modal, validates required fields, and appends to the grid in demo mode", () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
    renderPage("/demo/playbooks");

    fireEvent.click(screen.getByTestId("playbooks-add-rule"));
    const modal = screen.getByTestId("review-rule-modal");
    expect(modal).toHaveAttribute("role", "dialog");
    expect(modal).toHaveAttribute("aria-modal", "true");

    // Both required fields blank → blocked.
    fireEvent.click(screen.getByTestId("review-rule-submit"));
    expect(screen.getByTestId("review-rule-issue-error")).toHaveTextContent(
      /required/i,
    );
    expect(screen.getByTestId("review-rule-standard-error")).toHaveTextContent(
      /required/i,
    );

    // Fill in and submit.
    fireEvent.change(screen.getByTestId("review-rule-issue"), {
      target: { value: "Custom rule — payment terms" },
    });
    fireEvent.change(screen.getByTestId("review-rule-contract-type"), {
      target: { value: "Vendor agreement" },
    });
    fireEvent.change(screen.getByTestId("review-rule-severity"), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByTestId("review-rule-standard"), {
      target: { value: "Net 30 from invoice." },
    });
    fireEvent.change(screen.getByTestId("review-rule-fallback"), {
      target: { value: "Net 45 with discount." },
    });
    fireEvent.click(screen.getByTestId("review-rule-submit"));

    expect(screen.queryByTestId("review-rule-modal")).toBeNull();
    expect(screen.getByTestId("playbooks-add-notice")).toHaveTextContent(
      /added "custom rule — payment terms" to the demo Playbooks grid/i,
    );
    const table = gridTable();
    expect(
      within(table).getByText(/custom rule — payment terms/i),
    ).toBeInTheDocument();
  });

  it("renders an honest real-mode note inside the editor modal (no fake server persistence)", () => {
    // Real mode is the beforeEach default.
    renderPage();
    fireEvent.click(screen.getByTestId("playbooks-add-rule"));
    expect(screen.getByTestId("review-rule-real-note")).toHaveTextContent(
      /not persisted to the server/i,
    );
  });

  it("Escape closes the editor modal without adding a rule", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("playbooks-add-rule"));
    expect(screen.getByTestId("review-rule-modal")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("review-rule-modal")).toBeNull();
    expect(screen.queryByTestId("playbooks-add-notice")).toBeNull();
  });

  it("renders the legacy YAML playbook files section and primary sidebar header", () => {
    renderPage();
    // Both sections exist.
    expect(screen.getByTestId("review-rules-section")).toBeInTheDocument();
    expect(screen.getByTestId("playbook-files-section")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /yaml playbook files/i, level: 2 }),
    ).toBeInTheDocument();
  });

  it("/demo/playbooks also renders the structured grid (smoke check for the demo mount)", () => {
    renderPage("/demo/playbooks");
    expect(screen.getByTestId("playbooks-page")).toBeInTheDocument();
    expect(screen.getByTestId("review-rules-grid")).toBeInTheDocument();
  });

  it("does not leak storage internals, raw metadata, or DocuSeal secrets in the DOM", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("review-rules-grid")).toBeInTheDocument(),
    );
    const text = document.body.textContent ?? "";
    for (const needle of FORBIDDEN_DOM_TOKENS) {
      expect(text).not.toContain(needle);
    }
  });
});
