import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ApprovalWorkflowDetailPage from "../ApprovalWorkflowDetailPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";
const WF_ID = "wf-1";

const SAMPLE_STEP_1 = {
  id: "step-1",
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
  due_date: "2026-06-01",
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
  status: "pending" as const,
  approver_name: null,
  approver_email: "finance@example.com",
  inbox_item_id: null,
  due_date: null,
};

const ACTIVE_WORKFLOW = {
  id: WF_ID,
  organization_id: "org-1",
  name: "Legal approval",
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
  steps: [SAMPLE_STEP_1, SAMPLE_STEP_2],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderDetail(path: string = `/demo/approvals/workflows/${WF_ID}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/demo/approvals/workflows/:id"
          element={<ApprovalWorkflowDetailPage />}
        />
        <Route
          path="/approvals/workflows/:id"
          element={<ApprovalWorkflowDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ApprovalWorkflowDetailPage", () => {
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

  function setupActive(opts: { workflow?: object } = {}) {
    const workflow = opts.workflow ?? ACTIVE_WORKFLOW;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/approval-workflows/${WF_ID}`)) {
        return jsonResponse(workflow);
      }
      // ActivityTimeline fetches /api/requests/<id>/activity — return
      // an empty timeline so the section renders without errors.
      if (url.includes("/activity")) {
        return jsonResponse({ items: [] });
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
  }

  it("renders header with name, status pill, and breadcrumb (PR #98)", async () => {
    setupActive();
    renderDetail();
    await screen.findByTestId("approval-workflow-detail");
    expect(
      screen.getByRole("heading", { name: "Legal approval", level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("approval-workflow-status-pill"),
    ).toHaveTextContent(/active/i);
    expect(
      screen.getByTestId("approval-workflow-breadcrumb-workflows"),
    ).toHaveAttribute("href", "/demo/approvals/workflows");
  });

  it("renders a 'From template' source label when template_id is set", async () => {
    setupActive({
      workflow: { ...ACTIVE_WORKFLOW, template_id: "tpl-1" },
    });
    renderDetail();
    await screen.findByTestId("approval-workflow-detail");
    expect(
      screen.getByTestId("approval-workflow-source-label"),
    ).toHaveTextContent(/from template/i);
  });

  it("renders a 'From policy: <name>' source label from safe metadata", async () => {
    setupActive({
      workflow: {
        ...ACTIVE_WORKFLOW,
        metadata_json: {
          source_approval_policy_name: "NDA Legal Review policy",
        },
      },
    });
    renderDetail();
    expect(
      await screen.findByTestId("approval-workflow-source-label"),
    ).toHaveTextContent(/from policy: NDA Legal Review policy/i);
  });

  it("renders the related Request link when request_id is set (mount-aware)", async () => {
    setupActive();
    renderDetail();
    const link = await screen.findByTestId(
      "approval-workflow-related-request-link",
    );
    expect(link).toHaveAttribute("href", "/demo/requests/req-7");
    expect(
      screen.queryByTestId("approval-workflow-related-contract-link"),
    ).toBeNull();
  });

  it("renders the related Repository link when only contract_id is set", async () => {
    setupActive({
      workflow: {
        ...ACTIVE_WORKFLOW,
        request_id: null,
        contract_id: "ct-9",
      },
    });
    renderDetail();
    const link = await screen.findByTestId(
      "approval-workflow-related-contract-link",
    );
    expect(link).toHaveAttribute("href", "/demo/repository/ct-9");
  });

  it("renders 'Step N of M' progress for an active workflow", async () => {
    setupActive();
    renderDetail();
    expect(
      await screen.findByTestId("approval-workflow-progress-line"),
    ).toHaveTextContent(/Step 1 of 2/);
    expect(
      screen.getByTestId("approval-workflow-progress-current"),
    ).toHaveTextContent(/Legal review/);
  });

  it("highlights the current step in the timeline", async () => {
    setupActive();
    renderDetail();
    const list = await screen.findByTestId("approval-workflow-steps-list");
    const steps = within(list).getAllByTestId("approval-workflow-step");
    expect(steps).toHaveLength(2);
    expect(steps[0].getAttribute("data-current")).toBe("true");
    expect(steps[1].getAttribute("data-current")).toBe("false");
    // Approve / Reject buttons are only on the current step.
    expect(
      within(steps[0]).getByTestId("approval-workflow-step-approve"),
    ).toBeInTheDocument();
    expect(
      within(steps[1]).queryByTestId("approval-workflow-step-approve"),
    ).toBeNull();
  });

  it("approve POSTs and refreshes the workflow", async () => {
    let approved = false;
    const APPROVED_WORKFLOW = {
      ...ACTIVE_WORKFLOW,
      current_step_order: 2,
      steps: [
        {
          ...SAMPLE_STEP_1,
          status: "approved",
          decided_at: "2026-05-09T00:00:00Z",
        },
        SAMPLE_STEP_2,
      ],
    };
    fetchMock.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url.includes(`/api/approval-workflows/${WF_ID}/steps/step-1/approve`) &&
          init?.method === "POST"
        ) {
          approved = true;
          return jsonResponse(APPROVED_WORKFLOW);
        }
        if (url.endsWith(`/api/approval-workflows/${WF_ID}`)) {
          // Re-fetch returns the updated workflow once approve has
          // been called, matching the real backend behavior.
          return jsonResponse(approved ? APPROVED_WORKFLOW : ACTIVE_WORKFLOW);
        }
        if (url.includes("/activity")) return jsonResponse({ items: [] });
        return jsonResponse({ detail: "unexpected " + url }, 500);
      },
    );
    renderDetail();
    await screen.findByTestId("approval-workflow-steps-list");
    fireEvent.click(screen.getByTestId("approval-workflow-step-approve"));
    await waitFor(() => expect(approved).toBe(true));
    // After the refresh the second step becomes current.
    await waitFor(() => {
      const steps = within(
        screen.getByTestId("approval-workflow-steps-list"),
      ).getAllByTestId("approval-workflow-step");
      expect(steps[1].getAttribute("data-current")).toBe("true");
    });
  });

  it("cancels the workflow behind a two-step confirm", async () => {
    let cancelled = false;
    fetchMock.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url.endsWith(`/api/approval-workflows/${WF_ID}/cancel`) &&
          init?.method === "PATCH"
        ) {
          cancelled = true;
          return jsonResponse({ ...ACTIVE_WORKFLOW, status: "cancelled" });
        }
        if (url.endsWith(`/api/approval-workflows/${WF_ID}`)) {
          return jsonResponse(
            cancelled
              ? { ...ACTIVE_WORKFLOW, status: "cancelled" }
              : ACTIVE_WORKFLOW,
          );
        }
        if (url.includes("/activity")) return jsonResponse({ items: [] });
        return jsonResponse({ detail: "unexpected " + url }, 500);
      },
    );
    renderDetail();
    await screen.findByTestId("approval-workflow-action-area");
    fireEvent.click(screen.getByTestId("approval-workflow-cancel"));
    expect(cancelled).toBe(false);
    expect(
      screen.getByTestId("approval-workflow-confirm-cancel"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("approval-workflow-confirm-cancel"));
    await waitFor(() => expect(cancelled).toBe(true));
    // Action area becomes the "no further action" message after the
    // status flips to cancelled.
    await waitFor(() => {
      expect(
        screen.getByTestId("approval-workflow-action-area").textContent,
      ).toMatch(/no further action/i);
    });
  });

  it("renders the 'workflow is X' message on terminal workflows (no actions)", async () => {
    setupActive({
      workflow: { ...ACTIVE_WORKFLOW, status: "completed" },
    });
    renderDetail();
    expect(
      await screen.findByTestId("approval-workflow-action-area"),
    ).toHaveTextContent(/no further action/i);
    expect(
      screen.queryByTestId("approval-workflow-cancel"),
    ).toBeNull();
    expect(
      screen.queryByTestId("approval-workflow-step-approve"),
    ).toBeNull();
  });

  it("shows decision-note presence indicator without exposing the note text", async () => {
    setupActive({
      workflow: {
        ...ACTIVE_WORKFLOW,
        status: "completed",
        current_step_order: null,
        steps: [
          {
            ...SAMPLE_STEP_1,
            status: "approved",
            decided_at: "2026-05-09T00:00:00Z",
            decision_note: "internal note; should NOT leak to the page",
          },
          SAMPLE_STEP_2,
        ],
      },
    });
    renderDetail();
    await screen.findByTestId("approval-workflow-steps-list");
    expect(
      screen.getByTestId("approval-workflow-step-note-indicator"),
    ).toHaveTextContent(/decision note recorded/i);
    expect(document.body.textContent ?? "").not.toContain(
      "should NOT leak to the page",
    );
  });

  it("renders a not-found state when the workflow API returns 404", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "missing" }, 404));
    renderDetail();
    expect(
      await screen.findByText(/workflow not found/i),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("approval-workflow-detail-not-found-back"),
    ).toHaveAttribute("href", "/demo/approvals/workflows");
  });

  it("renders a loading skeleton before the workflow resolves", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    renderDetail();
    expect(
      screen.getByTestId("approval-workflow-detail-loading"),
    ).toBeInTheDocument();
    resolveFetch(jsonResponse(ACTIVE_WORKFLOW));
    await waitFor(() => {
      expect(
        screen.queryByTestId("approval-workflow-detail-loading"),
      ).toBeNull();
    });
  });

  it("renders an error state when the workflow API returns 500", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
    renderDetail();
    expect(
      await screen.findByText(/could not load this workflow/i),
    ).toBeInTheDocument();
  });

  it("does not surface storage internals or signer PII even with poisoned metadata", async () => {
    setupActive({
      workflow: {
        ...ACTIVE_WORKFLOW,
        metadata_json: {
          source_approval_policy_name: "Legal Review",
          storage_key: "should-not-appear",
          wrapped_dek: "should-not-appear",
          signer_email: "signer@example.com",
        } as Record<string, unknown>,
        steps: [
          {
            ...SAMPLE_STEP_1,
            metadata_json: {
              storage_key: "should-not-appear",
              s3_key: "should-not-appear",
            } as Record<string, unknown>,
          },
          SAMPLE_STEP_2,
        ],
      },
    });
    renderDetail();
    await screen.findByTestId("approval-workflow-detail");
    const text = document.body.textContent ?? "";
    for (const needle of [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned",
      "signer@example.com",
      "should-not-appear",
    ]) {
      expect(text).not.toContain(needle);
    }
  });

  it("supports the standalone /approvals/workflows/:id route (not demo-mounted)", async () => {
    setupActive();
    renderDetail(`/approvals/workflows/${WF_ID}`);
    await screen.findByTestId("approval-workflow-detail");
    // Mount-aware breadcrumb resolves to the bare path.
    expect(
      screen.getByTestId("approval-workflow-breadcrumb-workflows"),
    ).toHaveAttribute("href", "/approvals/workflows");
    expect(
      screen.getByTestId("approval-workflow-related-request-link"),
    ).toHaveAttribute("href", "/requests/req-7");
  });
});
