import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import ContractWorkspacePage from "../ContractWorkspacePage";
import { setDevUserId, clearDevUserId } from "../../lib/devUser";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const CONTRACT_ID = "22222222-2222-4222-8222-222222222222";

const CONTRACT_DETAIL = {
  id: CONTRACT_ID,
  title: "Test MSA",
  status: "ready",
  mime_type: "application/pdf",
  file_hash_sha256: "0".repeat(64),
  page_count: 3,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:01Z",
  full_text: "Some plain text body.",
  extracted_fields: [],
  clauses: [],
};

const SNAPSHOT = {
  id: "33333333-3333-4333-8333-333333333333",
  contract_id: CONTRACT_ID,
  markdown_text: "# Workspace markdown\n\nFast working preview.\n",
  source_kind: "original_upload",
  converter_name: "markitdown",
  converter_version: null,
  conversion_status: "ready",
  conversion_warnings: null,
  created_at: "2026-05-08T00:00:00Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setupFetch(
  fetchMock: Mock,
  options: { snapshot?: object | null } = {},
) {
  const snapshot =
    "snapshot" in options ? options.snapshot ?? null : SNAPSHOT;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
      return snapshot
        ? jsonResponse(snapshot)
        : jsonResponse({ detail: "not found" }, 404);
    }
    if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
      return jsonResponse(CONTRACT_DETAIL);
    }
    return jsonResponse({ detail: "unexpected" }, 500);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/contracts/${CONTRACT_ID}`]}>
      <Routes>
        <Route
          path="/contracts/:id"
          element={<ContractWorkspacePage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ContractWorkspacePage markdown integration", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(VALID_UUID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("defaults to the markdown preview and shows the toggle + Download original action", async () => {
    setupFetch(fetchMock);
    renderPage();

    await screen.findByRole("heading", {
      level: 1,
      name: "Workspace markdown",
    });

    const group = screen.getByRole("group", { name: /document view/i });
    const buttons = group.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    expect(buttons[0].textContent).toMatch(/markdown preview/i);
    expect(buttons[1]).toHaveAttribute("aria-pressed", "false");
    expect(buttons[1].textContent).toMatch(/view original/i);

    // The header still exposes the original-artifact action.
    expect(
      screen.getByRole("button", { name: /download original/i }),
    ).toBeInTheDocument();
  });

  it("switches to the original document text viewer when 'View original' is clicked", async () => {
    setupFetch(fetchMock);
    renderPage();
    await screen.findByRole("heading", {
      level: 1,
      name: "Workspace markdown",
    });

    const viewOriginal = screen
      .getByRole("group", { name: /document view/i })
      .querySelectorAll("button")[1];
    fireEvent.click(viewOriginal);

    expect(
      screen.getByRole("heading", { name: /original document text/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Some plain text body.")).toBeInTheDocument();
  });

  it("shows the empty state when the contract has no markdown snapshot", async () => {
    setupFetch(fetchMock, { snapshot: null });
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByTestId("markdown-empty-state"),
      ).toBeInTheDocument();
    });
    // The toggle still renders so the user can switch to the original.
    expect(
      screen.getByRole("group", { name: /document view/i }),
    ).toBeInTheDocument();
  });
});
