import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ApprovalWorkflowsPage from "../ApprovalWorkflowsPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const SAMPLE_RUN_LIST_ITEM = {
  id: "wf-1",
  organization_id: "org-1",
  name: "Legal approval",
  status: "active" as const,
  request_id: "req-1",
  contract_id: null,
  template_id: null,
  current_step_order: 1,
  started_at: "2026-05-08T16:00:00Z",
  completed_at: null,
  created_at: "2026-05-08T16:00:00Z",
  updated_at: "2026-05-08T16:00:00Z",
};

const SAMPLE_STEP_1 = {
  id: "step-1",
  organization_id: "org-1",
  workflow_run_id: "wf-1",
  step_order: 1,
  title: "Legal review",
  description: null,
  approver_name: null,
  approver_email: "legal@example.com",
  assigned_to: null,
  status: "pending" as const,
  decision_note: null,
  decided_at: null,
  due_date: "2026-05-20",
  inbox_item_id: "inbox-1",
  created_at: "2026-05-08T16:00:00Z",
  updated_at: "2026-05-08T16:00:00Z",
  metadata_json: null,
};

const SAMPLE_STEP_2 = {
  ...SAMPLE_STEP_1,
  id: "step-2",
  step_order: 2,
  title: "Finance review",
  approver_email: "finance@example.com",
  inbox_item_id: null,
  due_date: null,
};

const SAMPLE_RUN_DETAIL = {
  ...SAMPLE_RUN_LIST_ITEM,
  created_by: null,
  metadata_json: null,
  steps: [SAMPLE_STEP_1, SAMPLE_STEP_2],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage(initialEntry = "/approvals") {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/approvals" element={<ApprovalWorkflowsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ApprovalWorkflowsPage", () => {
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

  it("renders the create form and an empty state when no workflows exist", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage();
    expect(await screen.findByText(/No approval workflows yet/i)).toBeInTheDocument();
    expect(screen.getByTestId("approvals-create")).toBeInTheDocument();
  });

  it("renders the workflow list", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_RUN_LIST_ITEM]));
    renderPage();
    expect(await screen.findByText("Legal approval")).toBeInTheDocument();
    expect(screen.getByTestId("approval-status").textContent).toBe("active");
  });

  it("creates a workflow with steps and shows the first pending step", async () => {
    let listed: typeof SAMPLE_RUN_LIST_ITEM[] = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/approval-workflows") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        const created = {
          ...SAMPLE_RUN_DETAIL,
          name: body.name,
          request_id: body.request_id,
          steps: body.steps.map(
            (s: { title: string }, idx: number) => ({
              ...SAMPLE_STEP_1,
              id: `step-new-${idx + 1}`,
              step_order: idx + 1,
              title: s.title,
              inbox_item_id: idx === 0 ? "inbox-new" : null,
            }),
          ),
        };
        listed = [{ ...created, steps: undefined } as never, ...listed];
        return jsonResponse(created);
      }
      if (url.includes("/api/approval-workflows")) {
        return jsonResponse(listed);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText(/No approval workflows yet/i);

    fireEvent.change(screen.getByPlaceholderText(/Workflow name/i), {
      target: { value: "New flow" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Request ID/i), {
      target: { value: "req-99" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Step 1 title/i), {
      target: { value: "Legal review" },
    });

    fireEvent.click(screen.getByTestId("approvals-create-submit"));

    expect(await screen.findByText("New flow")).toBeInTheDocument();
    // The detail panel auto-expands on creation; the first step should
    // be visible as pending with approve/reject buttons.
    await waitFor(() => {
      expect(screen.getByTestId("approvals-approve")).toBeInTheDocument();
    });
  });

  it("approves the current pending step and updates status", async () => {
    const approved = {
      ...SAMPLE_RUN_DETAIL,
      current_step_order: 2,
      steps: [
        { ...SAMPLE_STEP_1, status: "approved", inbox_item_id: "inbox-1" },
        { ...SAMPLE_STEP_2, inbox_item_id: "inbox-2" },
      ],
    };
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (
        url.includes("/api/approval-workflows/wf-1/steps/step-1/approve") &&
        init?.method === "POST"
      ) {
        return jsonResponse(approved);
      }
      if (url.includes("/api/approval-workflows/wf-1") && init?.method !== "POST") {
        return jsonResponse(SAMPLE_RUN_DETAIL);
      }
      if (url.includes("/api/approval-workflows")) {
        return jsonResponse([SAMPLE_RUN_LIST_ITEM]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Legal approval");

    fireEvent.click(screen.getByTestId("approvals-toggle-detail"));
    const approveBtn = await screen.findByTestId("approvals-approve");
    fireEvent.click(approveBtn);

    await waitFor(() => {
      const detail = screen.getAllByTestId("approvals-step-detail");
      const statuses = detail.map(
        (el) =>
          within(el).getByTestId("approval-step-status").textContent ?? "",
      );
      expect(statuses).toEqual(["approved", "pending"]);
    });
  });

  it("rejects the current step and marks the workflow rejected", async () => {
    const rejected = {
      ...SAMPLE_RUN_DETAIL,
      status: "rejected",
      completed_at: "2026-05-09T09:00:00Z",
      steps: [
        {
          ...SAMPLE_STEP_1,
          status: "rejected",
          decision_note: null,
        },
        { ...SAMPLE_STEP_2, status: "skipped" },
      ],
    };
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (
        url.includes("/api/approval-workflows/wf-1/steps/step-1/reject") &&
        init?.method === "POST"
      ) {
        return jsonResponse(rejected);
      }
      if (url.includes("/api/approval-workflows/wf-1") && init?.method !== "POST") {
        return jsonResponse(SAMPLE_RUN_DETAIL);
      }
      if (url.includes("/api/approval-workflows")) {
        return jsonResponse([SAMPLE_RUN_LIST_ITEM]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Legal approval");

    fireEvent.click(screen.getByTestId("approvals-toggle-detail"));
    const rejectBtn = await screen.findByTestId("approvals-reject");
    fireEvent.click(rejectBtn);

    await waitFor(() => {
      expect(screen.getByTestId("approval-status").textContent).toBe("rejected");
    });
  });

  it("cancels an active workflow", async () => {
    const cancelled = {
      ...SAMPLE_RUN_DETAIL,
      status: "cancelled",
      completed_at: "2026-05-09T09:00:00Z",
      steps: [{ ...SAMPLE_STEP_1, status: "skipped" }, { ...SAMPLE_STEP_2, status: "skipped" }],
    };
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (
        url.includes("/api/approval-workflows/wf-1/cancel") &&
        init?.method === "PATCH"
      ) {
        return jsonResponse(cancelled);
      }
      if (url.includes("/api/approval-workflows")) {
        return jsonResponse([SAMPLE_RUN_LIST_ITEM]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Legal approval");

    fireEvent.click(screen.getByTestId("approvals-cancel"));

    await waitFor(() => {
      expect(screen.getByTestId("approval-status").textContent).toBe("cancelled");
    });
  });

  it("shows an error state when the list endpoint fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
    renderPage();
    expect(
      await screen.findByTestId("approvals-error"),
    ).toHaveTextContent(/boom|server failed/i);
  });

  // -------------------------------------------------------------------------
  // PR #61 — workflow_id deep-link
  // -------------------------------------------------------------------------

  it("auto-expands and highlights the deep-linked workflow_id row", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/approval-workflows/wf-1") && init?.method !== "POST") {
        return jsonResponse(SAMPLE_RUN_DETAIL);
      }
      if (url.includes("/api/approval-workflows")) {
        return jsonResponse([SAMPLE_RUN_LIST_ITEM]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage("/approvals?workflow_id=wf-1");
    await screen.findByText("Legal approval");
    // The detail panel mounted without a toggle click.
    await waitFor(() => {
      expect(screen.getByTestId("approvals-step-list")).toBeInTheDocument();
    });
    const row = screen.getByTestId("approvals-row");
    expect(row).toHaveAttribute("data-deep-link-target", "true");
    expect(row).toHaveAttribute("aria-label", expect.stringMatching(/linked approval workflow/i));
  });

  it("shows a not-found notice when the deep-linked workflow is missing", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_RUN_LIST_ITEM]));
    renderPage("/approvals?workflow_id=wf-missing");
    await screen.findByText("Legal approval");
    expect(
      await screen.findByTestId("approvals-deep-link-not-found"),
    ).toHaveTextContent("wf-missing");
  });

  it("does not render storage internals in the DOM", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_RUN_LIST_ITEM]));
    renderPage();
    await screen.findByText("Legal approval");
    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("wrapped_dek");
    expect(document.body.textContent ?? "").not.toContain("s3_key");
  });
});
