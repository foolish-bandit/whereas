import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ApprovalTaskDetailPage from "../ApprovalTaskDetailPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "task-1";
const WF_ID = "wf-7";
const STEP_ID = "step-3";

const APPROVAL_TASK = {
  id: TASK_ID,
  organization_id: "org-1",
  title: "Legal review — NDA",
  description: "Approval step 1 of 2",
  item_type: "approval",
  status: "open",
  priority: "high",
  assigned_to: null,
  due_date: "2026-05-09",
  request_id: "req-7",
  contract_id: null,
  template_id: null,
  created_at: "2026-05-08T16:00:00Z",
  updated_at: "2026-05-08T16:00:00Z",
  created_by: null,
  metadata_json: {
    workflow_run_id: WF_ID,
    approval_step_id: STEP_ID,
  } as Record<string, unknown>,
};

const STEP_1 = {
  id: STEP_ID,
  organization_id: "org-1",
  workflow_run_id: WF_ID,
  step_order: 1,
  title: "Legal review",
  description: null,
  approver_name: "Alice Counsel",
  approver_email: "legal@example.com",
  assigned_to: null,
  status: "pending" as const,
  decision_note: null,
  decided_at: null,
  due_date: "2026-05-09",
  inbox_item_id: TASK_ID,
  created_at: "2026-05-08T16:00:00Z",
  updated_at: "2026-05-08T16:00:00Z",
  metadata_json: null,
};

const STEP_2 = {
  ...STEP_1,
  id: "step-4",
  step_order: 2,
  title: "Finance review",
  approver_name: null,
  approver_email: "finance@example.com",
  inbox_item_id: null,
  due_date: null,
};

const ACTIVE_WORKFLOW = {
  id: WF_ID,
  organization_id: "org-1",
  name: "NDA approval",
  status: "active" as const,
  request_id: "req-7",
  contract_id: null,
  template_id: null,
  current_step_order: 1,
  started_at: "2026-05-08T16:00:00Z",
  completed_at: null,
  created_at: "2026-05-08T16:00:00Z",
  updated_at: "2026-05-08T16:00:00Z",
  created_by: null,
  metadata_json: null,
  steps: [STEP_1, STEP_2],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderDetail(path: string = `/demo/approvals/tasks/${TASK_ID}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/demo/approvals/tasks/:id"
          element={<ApprovalTaskDetailPage />}
        />
        <Route
          path="/approvals/tasks/:id"
          element={<ApprovalTaskDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ApprovalTaskDetailPage", () => {
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

  function setupHappy(opts: { task?: object; workflow?: object | null } = {}) {
    const task = opts.task ?? APPROVAL_TASK;
    const workflow =
      opts.workflow === undefined ? ACTIVE_WORKFLOW : opts.workflow;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(`/api/inbox-items/${TASK_ID}`)) {
        return jsonResponse(task);
      }
      if (url.includes(`/api/approval-workflows/${WF_ID}`)) {
        if (workflow === null)
          return jsonResponse({ detail: "missing" }, 404);
        return jsonResponse(workflow);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
  }

  it("renders header, status pill, and mount-aware back link", async () => {
    setupHappy();
    renderDetail();
    await screen.findByTestId("approval-task-detail");
    expect(
      screen.getByRole("heading", { name: "Legal review — NDA", level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("approval-task-detail-status-pill"),
    ).toHaveTextContent(/open/i);
    expect(
      screen.getByTestId("approval-task-breadcrumb-tasks"),
    ).toHaveAttribute("href", "/demo/approvals/tasks");
  });

  it("renders the overdue indicator when due_date is past today", async () => {
    setupHappy();
    renderDetail();
    expect(
      await screen.findByTestId("approval-task-detail-overdue"),
    ).toHaveTextContent(/overdue/i);
  });

  it("does NOT render overdue indicator for non-overdue task", async () => {
    setupHappy({ task: { ...APPROVAL_TASK, due_date: "2026-12-31" } });
    renderDetail();
    await screen.findByTestId("approval-task-detail");
    expect(
      screen.queryByTestId("approval-task-detail-overdue"),
    ).toBeNull();
  });

  it("links to the related Request, Repository, and Workflow", async () => {
    setupHappy({
      task: { ...APPROVAL_TASK, contract_id: "ct-2" },
    });
    renderDetail();
    await screen.findByTestId("approval-task-detail");
    expect(
      screen.getByTestId("approval-task-detail-request-link"),
    ).toHaveAttribute("href", "/demo/requests/req-7");
    expect(
      screen.getByTestId("approval-task-detail-contract-link"),
    ).toHaveAttribute("href", "/demo/repository/ct-2");
    expect(
      screen.getByTestId("approval-task-detail-workflow-link"),
    ).toHaveAttribute("href", `/demo/approvals/workflows/${WF_ID}`);
  });

  it("explains the current step title and order", async () => {
    setupHappy();
    renderDetail();
    expect(
      await screen.findByTestId("approval-task-detail-explanation"),
    ).toHaveTextContent(/step 1 of 2.*Legal review/i);
  });

  it("renders workflow context card with progress", async () => {
    setupHappy();
    renderDetail();
    expect(
      await screen.findByTestId(
        "approval-task-detail-context-workflow-progress",
      ),
    ).toHaveTextContent(/NDA approval.*active.*Step 1 of 2/i);
  });

  it("shows approve/reject controls only for an actionable approval task", async () => {
    setupHappy();
    renderDetail();
    expect(
      await screen.findByTestId("approval-task-detail-approve"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("approval-task-detail-reject"),
    ).toBeInTheDocument();
    // Mark complete / dismiss are NOT shown for approval-type items
    // (backend rejects status PATCH on approval items).
    expect(
      screen.queryByTestId("approval-task-detail-complete"),
    ).toBeNull();
    expect(
      screen.queryByTestId("approval-task-detail-dismiss"),
    ).toBeNull();
  });

  it("hides approve/reject when task is completed (read-only state)", async () => {
    setupHappy({ task: { ...APPROVAL_TASK, status: "completed" } });
    renderDetail();
    expect(
      await screen.findByTestId("approval-task-detail-resolved"),
    ).toHaveTextContent(/no further action/i);
    expect(
      screen.queryByTestId("approval-task-detail-approve"),
    ).toBeNull();
    expect(
      screen.queryByTestId("approval-task-detail-reject"),
    ).toBeNull();
  });

  it("hides approve/reject when task is dismissed (read-only state)", async () => {
    setupHappy({ task: { ...APPROVAL_TASK, status: "dismissed" } });
    renderDetail();
    await screen.findByTestId("approval-task-detail-resolved");
    expect(
      screen.queryByTestId("approval-task-detail-approve"),
    ).toBeNull();
  });

  it("approve POSTs to the step and refreshes the task + workflow", async () => {
    let approved = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.includes(
          `/api/approval-workflows/${WF_ID}/steps/${STEP_ID}/approve`,
        ) &&
        init?.method === "POST"
      ) {
        approved = true;
        return jsonResponse({ ...ACTIVE_WORKFLOW });
      }
      if (url.includes(`/api/inbox-items/${TASK_ID}`)) {
        return jsonResponse(
          approved ? { ...APPROVAL_TASK, status: "completed" } : APPROVAL_TASK,
        );
      }
      if (url.includes(`/api/approval-workflows/${WF_ID}`)) {
        return jsonResponse(ACTIVE_WORKFLOW);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderDetail();
    await screen.findByTestId("approval-task-detail-approve");
    fireEvent.click(screen.getByTestId("approval-task-detail-approve"));
    await waitFor(() => expect(approved).toBe(true));
    await waitFor(() =>
      expect(
        screen.queryByTestId("approval-task-detail-resolved"),
      ).toBeInTheDocument(),
    );
  });

  it("approve sends decision_note from the textarea when present", async () => {
    let captured: string | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.includes(
          `/api/approval-workflows/${WF_ID}/steps/${STEP_ID}/approve`,
        ) &&
        init?.method === "POST"
      ) {
        captured = init.body as string;
        return jsonResponse(ACTIVE_WORKFLOW);
      }
      if (url.includes(`/api/inbox-items/${TASK_ID}`))
        return jsonResponse(APPROVAL_TASK);
      if (url.includes(`/api/approval-workflows/${WF_ID}`))
        return jsonResponse(ACTIVE_WORKFLOW);
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderDetail();
    const note = await screen.findByTestId(
      "approval-task-detail-decision-note",
    );
    fireEvent.change(note, { target: { value: "Looks good." } });
    fireEvent.click(screen.getByTestId("approval-task-detail-approve"));
    await waitFor(() => expect(captured).not.toBeNull());
    expect(JSON.parse(captured ?? "{}")).toEqual({
      decision_note: "Looks good.",
    });
  });

  it("renders an error state on approve failure without crashing", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.includes(
          `/api/approval-workflows/${WF_ID}/steps/${STEP_ID}/approve`,
        ) &&
        init?.method === "POST"
      ) {
        return jsonResponse({ detail: "policy blocked" }, 409);
      }
      if (url.includes(`/api/inbox-items/${TASK_ID}`))
        return jsonResponse(APPROVAL_TASK);
      if (url.includes(`/api/approval-workflows/${WF_ID}`))
        return jsonResponse(ACTIVE_WORKFLOW);
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderDetail();
    await screen.findByTestId("approval-task-detail-approve");
    fireEvent.click(screen.getByTestId("approval-task-detail-approve"));
    await waitFor(() =>
      expect(
        screen.getByTestId("approval-task-detail-action-error"),
      ).toBeInTheDocument(),
    );
  });

  it("explains when the workflow API fails — falls back gracefully", async () => {
    setupHappy({ workflow: null });
    renderDetail();
    await screen.findByTestId("approval-task-detail");
    // Approve/reject hidden because no workflow context loaded.
    expect(
      screen.queryByTestId("approval-task-detail-approve"),
    ).toBeNull();
    expect(
      screen.getByTestId("approval-task-detail-no-actionable-step"),
    ).toHaveTextContent(/no matching approval workflow/i);
  });

  it("offers mark-complete / dismiss on non-approval task types", async () => {
    setupHappy({
      task: {
        ...APPROVAL_TASK,
        item_type: "contract_review",
        metadata_json: null,
      },
      workflow: null,
    });
    renderDetail();
    expect(
      await screen.findByTestId("approval-task-detail-complete"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("approval-task-detail-dismiss"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("approval-task-detail-approve"),
    ).toBeNull();
  });

  it("renders a not-found state when the inbox item is 404", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(`/api/inbox-items/${TASK_ID}`)) {
        return jsonResponse({ detail: "missing" }, 404);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderDetail();
    expect(
      await screen.findByText(/approval task not found/i),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("approval-task-detail-not-found-back"),
    ).toHaveAttribute("href", "/demo/approvals/tasks");
  });

  it("renders a loading skeleton before the task resolves", async () => {
    let resolveTask: (value: Response) => void = () => {};
    fetchMock.mockImplementation((url: string) => {
      if (url.includes(`/api/inbox-items/${TASK_ID}`)) {
        return new Promise<Response>((resolve) => {
          resolveTask = resolve;
        });
      }
      return Promise.resolve(jsonResponse(ACTIVE_WORKFLOW));
    });
    renderDetail();
    expect(
      screen.getByTestId("approval-task-detail-loading"),
    ).toBeInTheDocument();
    resolveTask(
      jsonResponse({
        ...APPROVAL_TASK,
        metadata_json: null,
        request_id: null,
        contract_id: null,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("approval-task-detail-loading"),
      ).toBeNull(),
    );
  });

  it("renders an error state when the inbox API returns 500", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(`/api/inbox-items/${TASK_ID}`))
        return jsonResponse({ detail: "boom" }, 500);
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderDetail();
    expect(
      await screen.findByText(/could not load this approval task/i),
    ).toBeInTheDocument();
  });

  it("supports standalone /approvals/tasks/:id (non-demo mount)", async () => {
    setupHappy();
    renderDetail(`/approvals/tasks/${TASK_ID}`);
    await screen.findByTestId("approval-task-detail");
    expect(
      screen.getByTestId("approval-task-breadcrumb-tasks"),
    ).toHaveAttribute("href", "/approvals/tasks");
    expect(
      screen.getByTestId("approval-task-detail-request-link"),
    ).toHaveAttribute("href", "/requests/req-7");
    expect(
      screen.getByTestId("approval-task-detail-workflow-link"),
    ).toHaveAttribute("href", `/approvals/workflows/${WF_ID}`);
  });

  it("does not surface storage internals or signer PII even with poisoned metadata", async () => {
    setupHappy({
      task: {
        ...APPROVAL_TASK,
        metadata_json: {
          workflow_run_id: WF_ID,
          approval_step_id: STEP_ID,
          storage_key: "should-not-appear-storage",
          wrapped_dek: "should-not-appear-dek",
          s3_key: "should-not-appear-s3",
          private_url: "should-not-appear-url",
          docuseal_secret: "should-not-appear-docuseal",
          signer_email: "signer@example.com",
        } as Record<string, unknown>,
      },
      workflow: {
        ...ACTIVE_WORKFLOW,
        metadata_json: {
          storage_key: "should-not-appear",
          presigned: "should-not-appear",
        } as Record<string, unknown>,
      },
    });
    renderDetail();
    await screen.findByTestId("approval-task-detail");
    const text = document.body.textContent ?? "";
    for (const needle of [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned",
      "signer@example.com",
      "docuseal_secret",
      "should-not-appear-storage",
      "should-not-appear-dek",
      "should-not-appear-s3",
      "should-not-appear-url",
      "should-not-appear-docuseal",
    ]) {
      expect(text).not.toContain(needle);
    }
  });
});
