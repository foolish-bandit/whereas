import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ApprovalTasksPage from "../ApprovalTasksPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderAt(pathname: string) {
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route path="/approvals/tasks" element={<ApprovalTasksPage />} />
        <Route path="/demo/approvals/tasks" element={<ApprovalTasksPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function baseRow(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "task-1",
    organization_id: "org-1",
    title: "Legal review — NDA",
    description: "Step 1 of NDA review.",
    item_type: "approval",
    status: "open",
    priority: "high",
    assigned_to: null,
    due_date: "2026-05-09",
    request_id: "req-1",
    contract_id: null,
    template_id: null,
    created_at: "2026-05-08T12:00:00Z",
    updated_at: "2026-05-08T12:00:00Z",
    created_by: null,
    metadata_json: null,
    ...overrides,
  };
}

describe("ApprovalTasksPage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("filters inbox items to item_type=approval and renders rows", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow({})]));
    renderAt("/approvals/tasks");
    expect(
      await screen.findByText("Legal review — NDA"),
    ).toBeInTheDocument();
    // Confirm the request URL included the approval filter.
    const url = fetchMock.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain("item_type=approval");
  });

  it("renders an empty state when there are no approval tasks", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderAt("/approvals/tasks");
    expect(
      await screen.findByText(/inbox zero for approvals/i),
    ).toBeInTheDocument();
  });

  it("links tasks with a request_id to the matching Request detail (mount-aware)", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow({})]));
    renderAt("/demo/approvals/tasks");
    const link = await screen.findByTestId("approval-task-request-link");
    expect(link).toHaveAttribute("href", "/demo/requests/req-1");
    // Review CTA points to the same destination.
    expect(screen.getByTestId("approval-task-review")).toHaveAttribute(
      "href",
      "/demo/requests/req-1",
    );
  });

  it("links contract-only tasks to the Repository record (top-level mount)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        baseRow({ request_id: null, contract_id: "contract-7" }),
      ]),
    );
    renderAt("/approvals/tasks");
    const link = await screen.findByTestId("approval-task-contract-link");
    expect(link).toHaveAttribute("href", "/repository/contract-7");
    expect(screen.getByTestId("approval-task-review")).toHaveAttribute(
      "href",
      "/repository/contract-7",
    );
  });

  it("falls back to the workflows page when no request or contract is linked", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        baseRow({ request_id: null, contract_id: null }),
      ]),
    );
    renderAt("/approvals/tasks");
    const link = await screen.findByTestId("approval-task-workflows-link");
    expect(link).toHaveAttribute("href", "/approvals/workflows");
  });

  it("shows an overdue badge when the due date is in the past", async () => {
    fetchMock.mockResolvedValue(jsonResponse([baseRow({})]));
    renderAt("/approvals/tasks");
    expect(
      await screen.findByTestId("approval-task-overdue"),
    ).toHaveTextContent(/overdue/i);
  });

  it("does not show an overdue badge for future due dates", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([baseRow({ due_date: "2026-06-01" })]),
    );
    renderAt("/approvals/tasks");
    await screen.findByText("Legal review — NDA");
    expect(screen.queryByTestId("approval-task-overdue")).toBeNull();
  });

  it("does not surface storage internals or raw metadata in the DOM", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        baseRow({
          metadata_json: {
            storage_key: "should-not-appear",
            wrapped_dek: "should-not-appear",
            s3_key: "should-not-appear",
            private_url: "https://private.example/file",
          } as Record<string, unknown>,
        }),
      ]),
    );
    renderAt("/approvals/tasks");
    await screen.findByText("Legal review — NDA");
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

  it("shows an error state when the inbox endpoint fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
    renderAt("/approvals/tasks");
    expect(
      await screen.findByTestId("approval-tasks-error"),
    ).toBeInTheDocument();
  });
});
