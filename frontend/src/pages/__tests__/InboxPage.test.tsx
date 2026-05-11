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

  it("renders inbox items with item-type chip + status chip", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    expect(
      await screen.findByText("Review request: NDA with Acme"),
    ).toBeInTheDocument();
    // PR #84: the item_type becomes a small chip (snake_case rendered
    // as "request review" for legibility).
    expect(screen.getByTestId("inbox-row-type")).toHaveTextContent(
      /request review/i,
    );
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

  // -------------------------------------------------------------------------
  // PR #84 — deep links, overdue badge, type filter
  // -------------------------------------------------------------------------

  it("links rows with a request_id to the matching Request detail page", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");
    const openLink = screen.getByTestId("inbox-row-open");
    expect(openLink).toHaveAttribute("href", "/requests/req-1");
    const titleLink = screen.getByTestId("inbox-row-title-link");
    expect(titleLink).toHaveAttribute("href", "/requests/req-1");
  });

  it("links rows with only a contract_id to the Repository workspace", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          ...SAMPLE_ITEM,
          id: "inbox-2",
          title: "Signature follow-up",
          request_id: null,
          contract_id: "contract-7",
        },
      ]),
    );
    renderPage();
    await screen.findByText("Signature follow-up");
    expect(screen.getByTestId("inbox-row-open")).toHaveAttribute(
      "href",
      "/repository/contract-7",
    );
  });

  it("renders an Overdue badge when an open item is past its due date", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-01T12:00:00Z"));
    try {
      fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
      renderPage();
      await screen.findByText("Review request: NDA with Acme");
      expect(screen.getByTestId("inbox-row-overdue")).toHaveTextContent(
        /overdue/i,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not render an Overdue badge for future due dates", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    try {
      fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
      renderPage();
      await screen.findByText("Review request: NDA with Acme");
      expect(screen.queryByTestId("inbox-row-overdue")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes item_type as a server-side filter", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");
    fireEvent.change(screen.getByTestId("inbox-filter-type"), {
      target: { value: "signature_followup" },
    });
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1)?.[0] as string;
      expect(lastCall).toContain("item_type=signature_followup");
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
