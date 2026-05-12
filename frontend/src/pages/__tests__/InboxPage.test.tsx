import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const SAMPLE_APPROVAL = {
  ...SAMPLE_ITEM,
  id: "inbox-approval-1",
  title: "Legal approval needed",
  item_type: "approval",
  request_id: "req-2",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage(path = "/inbox") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/demo/inbox" element={<InboxPage />} />
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
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "false");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearDevUserId();
  });

  it("renders an inbox-clear empty state", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage();
    expect(await screen.findByText(/your inbox is clear/i)).toBeInTheDocument();
    expect(
      screen.getByText(/^new uploads and review work appear here\.$/i),
    ).toBeInTheDocument();
  });

  it("renders inbox items with item-type chip + status chip", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    expect(
      await screen.findByText("Review request: NDA with Acme"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("inbox-row-type")).toHaveTextContent(
      /request review/i,
    );
    expect(screen.getByTestId("inbox-status").textContent).toBe("open");
  });

  it("supports row selection, selected count, and clear selection", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    expect(screen.getByTestId("inbox-selected-count")).toHaveTextContent(
      "1 selected",
    );
    expect(screen.getByTestId("inbox-bulk-actions")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("inbox-clear-selection"));
    expect(screen.getByTestId("inbox-selected-count")).toHaveTextContent(
      "0 selected",
    );
    expect(screen.queryByTestId("inbox-bulk-actions")).toBeNull();
  });

  it("supports select-all for visible rows", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        SAMPLE_ITEM,
        { ...SAMPLE_ITEM, id: "inbox-2", title: "Follow up signature packet" },
      ]),
    );
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-select-all"));
    expect(screen.getByTestId("inbox-selected-count")).toHaveTextContent(
      "2 selected",
    );

    fireEvent.click(screen.getByTestId("inbox-select-all"));
    expect(screen.getByTestId("inbox-selected-count")).toHaveTextContent(
      "0 selected",
    );
  });

  it("opens the Move to Repository panel from bulk actions", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-repository"));

    expect(await screen.findByTestId("inbox-repository-panel")).toBeInTheDocument();
  });

  it("opens the Move to Review panel from bulk actions", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-review"));

    expect(await screen.findByTestId("inbox-review-panel")).toBeInTheDocument();
  });

  it("disables generic routing actions when approval tasks are selected", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_APPROVAL]));
    renderPage();
    await screen.findByText("Legal approval needed");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));

    expect(screen.getByTestId("inbox-move-repository")).toBeDisabled();
    expect(screen.getByTestId("inbox-move-review")).toBeDisabled();
    expect(
      screen.getByTestId("inbox-approval-selection-help"),
    ).toHaveTextContent(
      /approval tasks must be completed from the approval task detail page/i,
    );
    expect(screen.getByTestId("inbox-open-approval-task")).toHaveAttribute(
      "href",
      "/approvals/tasks/inbox-approval-1",
    );
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

  it("links rows with a request_id to the matching Request detail page", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");
    const openLink = screen.getByTestId("inbox-row-open");
    expect(openLink).toHaveAttribute("href", "/requests/req-1");
    const titleLink = screen.getByTestId("inbox-row-title-link");
    expect(titleLink).toHaveAttribute("href", "/requests/req-1");
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
      expect(screen.getByText(/your inbox is clear/i)).toBeInTheDocument();
    });
  });

  it("does not surface storage internals or raw metadata in the DOM", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          ...SAMPLE_ITEM,
          metadata_json: {
            storage_key: "should-not-appear",
            wrapped_dek: "should-not-appear",
            s3_key: "should-not-appear",
            private_url: "https://private.example/file",
          } as Record<string, unknown>,
        },
      ]),
    );
    renderPage();
    await screen.findByText("Review request: NDA with Acme");
    const forbidden = [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned",
      "should-not-appear",
    ];
    for (const needle of forbidden) {
      expect(document.body.textContent ?? "").not.toContain(needle);
    }
  });

  it("routes selected intake items in demo mode", async () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
    renderPage("/demo/inbox");
    const intakeRowTitle = await screen.findByText(/new upload intake/i);
    const row = intakeRowTitle.closest("li");
    expect(row).not.toBeNull();
    const checkbox = within(row as HTMLElement).getByTestId("inbox-row-checkbox");

    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("inbox-move-repository"));
    fireEvent.click(await screen.findByTestId("inbox-repo-route-demo"));

    expect(await screen.findByTestId("inbox-route-notice")).toHaveTextContent(
      /routed 1 inbox item/i,
    );
    expect(within(row as HTMLElement).getByTestId("inbox-status")).toHaveTextContent(
      "completed",
    );
  });
});
