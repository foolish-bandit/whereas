import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import InboxPage from "../InboxPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const SAMPLE_ITEM = {
  id: "inbox-1",
  organization_id: "org-1",
  title: "Review request: NDA with Acme",
  description: null,
  item_type: "request_review",
  status: "open" as const,
  priority: "normal",
  assigned_to: null,
  due_date: "2026-06-01",
  request_id: "req-1",
  contract_id: null,
  template_id: null,
  created_at: "2026-05-08T16:00:00Z",
  updated_at: "2026-05-08T16:00:00Z",
  created_by: null,
  metadata_json: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/inbox"]}>
      <Routes>
        <Route path="/inbox" element={<InboxPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("InboxPage", () => {
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

  it("renders an inbox-zero empty state", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage();
    expect(await screen.findByText(/Inbox zero/i)).toBeInTheDocument();
  });

  it("renders inbox items", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    expect(
      await screen.findByText("Review request: NDA with Acme"),
    ).toBeInTheDocument();
    expect(screen.getByText(/request_review/)).toBeInTheDocument();
    expect(screen.getByTestId("inbox-status").textContent).toBe("open");
  });

  it("marks an item complete via the Mark complete button", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/api/inbox-items/inbox-1") && init?.method === "PATCH") {
        return jsonResponse({ ...SAMPLE_ITEM, status: "completed" });
      }
      if (url.includes("/api/inbox-items")) {
        return jsonResponse([SAMPLE_ITEM]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByRole("button", { name: /Mark complete/i }));

    await waitFor(() => {
      expect(screen.getByTestId("inbox-status").textContent).toBe("completed");
    });
  });

  it("dismisses an item, removing it from the default list", async () => {
    let listed = [SAMPLE_ITEM];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/api/inbox-items/inbox-1") && init?.method === "DELETE") {
        listed = [];
        return new Response(null, { status: 204 });
      }
      return jsonResponse(listed);
    });
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));

    await waitFor(() => {
      expect(screen.getByText(/Inbox zero/i)).toBeInTheDocument();
    });
  });
});
