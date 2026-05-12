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

  it("opens the Repository classification modal from bulk actions", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-repository"));

    const modal = await screen.findByTestId("repository-classification-modal");
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveAttribute("role", "dialog");
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("repo-classify-name")).toBeInTheDocument();
    expect(screen.getByTestId("repo-classify-contract-type")).toBeInTheDocument();
    expect(screen.getByTestId("repo-classify-status")).toBeInTheDocument();
    expect(screen.getByTestId("repo-classify-owner")).toBeInTheDocument();
    expect(screen.getByTestId("repo-classify-folder")).toBeInTheDocument();
  });

  it("shows honest real-mode guidance and a link to Repository upload", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-repository"));

    await screen.findByTestId("repository-classification-modal");
    expect(screen.getByTestId("repo-classify-real-note")).toHaveTextContent(
      /existing repository upload/i,
    );
    expect(screen.getByTestId("repo-classify-open-upload")).toHaveAttribute(
      "href",
      "/upload",
    );
    // Demo-only submit must not be rendered in real mode — no fake mutation.
    expect(screen.queryByTestId("repo-classify-submit")).toBeNull();
  });

  it("prefixes the real-mode Upload link with /demo when mounted under /demo", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage("/demo/inbox");
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-repository"));

    await screen.findByTestId("repository-classification-modal");
    expect(screen.getByTestId("repo-classify-open-upload")).toHaveAttribute(
      "href",
      "/demo/upload",
    );
  });

  it("opens the Move to Review modal from bulk actions", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-review"));

    const modal = await screen.findByTestId("move-to-review-modal");
    expect(modal).toHaveAttribute("role", "dialog");
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("move-to-review-modal-title")).toHaveTextContent(
      /move to review/i,
    );
    // The name is pre-filled from the single selected item's title.
    expect(screen.getByTestId("move-to-review-name")).toHaveValue(
      "Review request: NDA with Acme",
    );
    expect(screen.getByTestId("move-to-review-request-type")).toBeInTheDocument();
    expect(screen.getByTestId("move-to-review-template")).toBeInTheDocument();
    expect(screen.getByTestId("move-to-review-priority")).toBeInTheDocument();
    expect(screen.getByTestId("move-to-review-supporting-info")).toBeInTheDocument();
  });

  it("disables the Move-to-Review action and shows honest copy when 2+ items are selected", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        SAMPLE_ITEM,
        { ...SAMPLE_ITEM, id: "inbox-2", title: "Second intake item" },
      ]),
    );
    renderPage();
    await screen.findByText("Second intake item");

    fireEvent.click(screen.getByTestId("inbox-select-all"));
    expect(screen.getByTestId("inbox-move-review")).toBeDisabled();
    expect(screen.getByTestId("inbox-multi-review-help")).toHaveTextContent(
      /one intake item at a time/i,
    );
    // Move to Repository remains multi-item friendly.
    expect(screen.getByTestId("inbox-move-repository")).not.toBeDisabled();
  });

  it("shows the honest real-mode note inside the Move to Review modal", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-review"));

    await screen.findByTestId("move-to-review-modal");
    expect(screen.getByTestId("move-to-review-real-note")).toHaveTextContent(
      /existing requests api/i,
    );
  });

  it("creates a Request via the existing API on submit and shows a mount-aware route notice", async () => {
    // Use a fresh-intake row (no linked request yet) so the modal
    // actually POSTs to /api/requests instead of reusing an existing
    // request_id.
    const FRESH_ITEM = { ...SAMPLE_ITEM, id: "inbox-fresh", request_id: null };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (
        url.includes("/api/agreement-templates") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([]);
      }
      if (url.includes("/api/inbox-items") && (!init?.method || init.method === "GET")) {
        return jsonResponse([FRESH_ITEM]);
      }
      if (url.endsWith("/api/requests") && init?.method === "POST") {
        return jsonResponse({
          ...SAMPLE_ITEM,
          id: "req-new-1",
          title: "Custom name",
          description: null,
          request_type: "vendor_agreement",
          contract_type: null,
          status: "open",
          priority: "high",
          requester_name: null,
          requester_email: null,
          counterparty_name: null,
          due_date: null,
          assigned_to: null,
          linked_contract_id: null,
          linked_template_id: null,
        });
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-review"));
    await screen.findByTestId("move-to-review-modal");

    fireEvent.change(screen.getByTestId("move-to-review-name"), {
      target: { value: "Custom name" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-request-type"), {
      target: { value: "vendor_agreement" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-priority"), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-owner"), {
      target: { value: "should-not-be-sent@example.com" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-department"), {
      target: { value: "Should-Not-Be-Sent Dept" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-supporting-info"), {
      target: { value: "deal value 50k, urgency: this week" },
    });
    fireEvent.click(screen.getByTestId("move-to-review-submit"));

    const notice = await screen.findByTestId("inbox-route-notice");
    expect(notice).toHaveTextContent(/routed "Custom name"/i);
    expect(notice).toHaveTextContent(/as vendor agreement/i);
    expect(screen.getByTestId("inbox-route-notice-link")).toHaveAttribute(
      "href",
      "/requests/req-new-1",
    );

    const postCall = calls.find(
      (c) => c.url.endsWith("/api/requests") && c.init?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall!.init!.body as string) ?? "{}");
    expect(body.title).toBe("Custom name");
    expect(body.request_type).toBe("vendor_agreement");
    expect(body.priority).toBe("high");
    expect(body.description).toBe("deal value 50k, urgency: this week");
    // Demo-only fields must NOT be sent to the server.
    expect(body).not.toHaveProperty("owner");
    expect(body).not.toHaveProperty("department");
    expect(body).not.toHaveProperty("requester_email");
    // The body should also not echo the workflow-convenience values.
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("should-not-be-sent");
    expect(bodyText).not.toContain("Should-Not-Be-Sent");
  });

  it("requires Request name before submit", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-review"));
    await screen.findByTestId("move-to-review-modal");

    fireEvent.change(screen.getByTestId("move-to-review-name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByTestId("move-to-review-submit"));

    expect(
      await screen.findByTestId("move-to-review-name-error"),
    ).toHaveTextContent(/required/i);
    expect(screen.queryByTestId("inbox-route-notice")).toBeNull();
  });

  it("cancels the Move to Review modal without creating a Request", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-review"));
    await screen.findByTestId("move-to-review-modal");
    fireEvent.click(screen.getByTestId("move-to-review-cancel"));

    expect(screen.queryByTestId("move-to-review-modal")).toBeNull();
    expect(screen.queryByTestId("inbox-route-notice")).toBeNull();
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

  it("routes selected intake items in demo mode via the classification modal", async () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
    renderPage("/demo/inbox");
    const intakeRowTitle = await screen.findByText(/new upload intake/i);
    const row = intakeRowTitle.closest("li");
    expect(row).not.toBeNull();
    const checkbox = within(row as HTMLElement).getByTestId("inbox-row-checkbox");

    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("inbox-move-repository"));

    await screen.findByTestId("repository-classification-modal");
    fireEvent.change(screen.getByTestId("repo-classify-name"), {
      target: { value: "Vendor MSA — Acme" },
    });
    fireEvent.change(screen.getByTestId("repo-classify-contract-type"), {
      target: { value: "MSA" },
    });
    fireEvent.click(screen.getByTestId("repo-classify-submit"));

    expect(await screen.findByTestId("inbox-route-notice")).toHaveTextContent(
      /routed 1 inbox item.*as MSA.*demo mode/i,
    );
    expect(within(row as HTMLElement).getByTestId("inbox-status")).toHaveTextContent(
      "completed",
    );
    // Modal closes after a successful demo route.
    expect(
      screen.queryByTestId("repository-classification-modal"),
    ).toBeNull();
  });

  it("validates the Repository name field in demo mode", async () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
    renderPage("/demo/inbox");
    const intakeRowTitle = await screen.findByText(/new upload intake/i);
    const row = intakeRowTitle.closest("li");
    const checkbox = within(row as HTMLElement).getByTestId("inbox-row-checkbox");

    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("inbox-move-repository"));
    await screen.findByTestId("repository-classification-modal");

    fireEvent.click(screen.getByTestId("repo-classify-submit"));

    expect(
      await screen.findByTestId("repo-classify-name-error"),
    ).toHaveTextContent(/repository name is required/i);
    // No route notice is shown when validation blocks submission.
    expect(screen.queryByTestId("inbox-route-notice")).toBeNull();
  });

  it("cancels out of the classification modal without routing", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-repository"));

    await screen.findByTestId("repository-classification-modal");
    fireEvent.click(screen.getByTestId("repo-classify-cancel"));

    expect(
      screen.queryByTestId("repository-classification-modal"),
    ).toBeNull();
    expect(screen.queryByTestId("inbox-route-notice")).toBeNull();
  });

  it("does not open the classification modal when approval tasks are selected", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_APPROVAL]));
    renderPage();
    await screen.findByText("Legal approval needed");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    // Move to Repository button is disabled — clicking it should not open
    // the modal even if the user manages to trigger the handler.
    expect(screen.getByTestId("inbox-move-repository")).toBeDisabled();
    fireEvent.click(screen.getByTestId("inbox-move-repository"));
    expect(
      screen.queryByTestId("repository-classification-modal"),
    ).toBeNull();
  });

  it("does not open the Move-to-Review modal when approval tasks are selected", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_APPROVAL]));
    renderPage();
    await screen.findByText("Legal approval needed");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    expect(screen.getByTestId("inbox-move-review")).toBeDisabled();
    fireEvent.click(screen.getByTestId("inbox-move-review"));
    expect(screen.queryByTestId("move-to-review-modal")).toBeNull();
    // The approval helper still surfaces the open-task link path.
    expect(screen.getByTestId("inbox-open-approval-task")).toHaveAttribute(
      "href",
      "/approvals/tasks/inbox-approval-1",
    );
  });

  it("routes a single intake item through Move to Review in demo mode with a mount-aware link", async () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
    renderPage("/demo/inbox");
    const intakeRowTitle = await screen.findByText(/new upload intake/i);
    const row = intakeRowTitle.closest("li");
    expect(row).not.toBeNull();
    const checkbox = within(row as HTMLElement).getByTestId("inbox-row-checkbox");

    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("inbox-move-review"));
    await screen.findByTestId("move-to-review-modal");

    fireEvent.change(screen.getByTestId("move-to-review-name"), {
      target: { value: "Acme MSA review" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-request-type"), {
      target: { value: "vendor_agreement" },
    });
    fireEvent.change(screen.getByTestId("move-to-review-supporting-info"), {
      target: { value: "deal value 50k, jurisdiction CA" },
    });
    fireEvent.click(screen.getByTestId("move-to-review-submit"));

    const notice = await screen.findByTestId("inbox-route-notice");
    expect(notice).toHaveTextContent(/routed "Acme MSA review"/i);
    expect(notice).toHaveTextContent(/as vendor agreement/i);
    expect(notice).toHaveTextContent(/in demo mode/i);
    const noticeLink = screen.getByTestId("inbox-route-notice-link");
    expect(noticeLink.getAttribute("href")).toMatch(/^\/demo\/requests\//);

    // The routed inbox row becomes completed.
    expect(within(row as HTMLElement).getByTestId("inbox-status")).toHaveTextContent(
      "completed",
    );
    // Modal closes after success.
    expect(screen.queryByTestId("move-to-review-modal")).toBeNull();
  });

  it("Escape closes the Move to Review modal", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_ITEM]));
    renderPage();
    await screen.findByText("Review request: NDA with Acme");

    fireEvent.click(screen.getByTestId("inbox-row-checkbox"));
    fireEvent.click(screen.getByTestId("inbox-move-review"));
    await screen.findByTestId("move-to-review-modal");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("move-to-review-modal")).toBeNull();
  });
});
