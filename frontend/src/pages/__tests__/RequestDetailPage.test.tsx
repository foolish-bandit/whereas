import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RequestDetailPage from "../RequestDetailPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";
import type { RequestApprovalStatus } from "../../types/requestApprovalStatus";
import type { ContractRequest } from "../../types/requests";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const BASE_REQUEST: ContractRequest = {
  id: "req-1",
  organization_id: "org-1",
  title: "NDA with Acme",
  description: "Initial intake notes.",
  request_type: "new_contract",
  contract_type: "NDA",
  status: "open",
  priority: "high",
  requester_name: "Devon Reyes",
  requester_email: "devon@example.com",
  counterparty_name: "Acme",
  due_date: "2026-06-01",
  assigned_to: null,
  linked_contract_id: null,
  linked_template_id: "tpl-1",
  created_at: "2026-05-08T16:00:00Z",
  updated_at: "2026-05-09T16:00:00Z",
  created_by: null,
  metadata_json: {
    storage_key: "hidden-storage-key",
    private_url: "https://private.example/file",
    artifact_type: "generated_docx",
    document_bytes: "document bytes",
  },
};

const LINKED_REQUEST: ContractRequest = {
  ...BASE_REQUEST,
  status: "completed",
  linked_contract_id: "contract-1",
};

const CONTRACT_LIST = [
  {
    id: "contract-1",
    title: "NDA with Acme Repository record",
    status: "ready",
    mime_type: "application/pdf",
    file_hash_sha256: "0".repeat(64),
    page_count: 1,
    created_at: "2026-05-08T16:30:00Z",
    updated_at: "2026-05-08T16:30:00Z",
  },
];

function approvalStatus(
  overrides: Partial<RequestApprovalStatus["summary"]> = {},
): RequestApprovalStatus {
  const linked = overrides.ready_for_signature !== undefined;
  return {
    request_id: "req-1",
    linked_contract_id: linked ? "contract-1" : null,
    matching_policy_ids: ["policy-1"],
    matching_policies: [
      {
        id: "policy-1",
        name: "High priority legal review",
        workflow_template_id: "template-1",
        auto_attach: true,
        applies_to_generated_contracts: true,
        request_type: null,
        contract_type: "NDA",
        priority: "high",
        agreement_template_id: null,
      },
    ],
    workflow_runs: [
      {
        id: "wf-1",
        name: "Legal review",
        status: overrides.has_completed_workflows ? "completed" : "active",
        current_step_order: overrides.has_active_workflows === false ? null : 1,
        started_at: "2026-05-08T16:05:00Z",
        completed_at: overrides.has_completed_workflows
          ? "2026-05-08T17:05:00Z"
          : null,
        source_approval_policy_id: "policy-1",
        source_approval_policy_name: "High priority legal review",
        steps: [
          {
            id: "step-1",
            step_order: 1,
            title: "Legal approval",
            status: overrides.has_completed_workflows ? "approved" : "pending",
            assigned_to: null,
            approver_name: "Legal",
            approver_email: null,
            due_date: null,
            decided_at: overrides.has_completed_workflows
              ? "2026-05-08T17:05:00Z"
              : null,
          },
        ],
      },
    ],
    summary: {
      has_required_policies: true,
      has_active_workflows: true,
      has_rejected_workflows: false,
      has_completed_workflows: false,
      all_required_policy_workflows_completed: false,
      ready_for_signature: null,
      blocking_reason: "active_approval_workflows",
      blocking_reason_text:
        "An approval workflow is still active and waiting on a decision.",
      ...overrides,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage(path = "/requests/req-1") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/requests/:id" element={<RequestDetailPage />} />
        <Route path="/requests" element={<div>Requests list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequestDetailPage", () => {
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

  function mockDetail(
    request: ContractRequest = BASE_REQUEST,
    status: RequestApprovalStatus = approvalStatus(),
    activityItems: unknown[] = [
      {
        id: "act-1",
        event_type: "approval.workflow.created",
        occurred_at: "2026-05-08T16:05:00Z",
        actor_user_id: null,
        title: "Approval workflow created: Legal review",
        description: null,
        request_id: "req-1",
        contract_id: null,
        workflow_run_id: "wf-1",
        approval_step_id: null,
        step_order: null,
        source: "policy",
      },
    ],
  ) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(status);
      }
      if (url.endsWith("/api/requests/req-1/activity")) {
        return jsonResponse({ items: activityItems });
      }
      if (url.endsWith("/api/agreement-templates/tpl-1/variables")) {
        return jsonResponse([]);
      }
      if (url.endsWith("/api/contracts")) {
        return jsonResponse(CONTRACT_LIST);
      }
      if (url.endsWith("/api/requests/req-1")) {
        return jsonResponse(request);
      }
      return jsonResponse({ detail: `unexpected ${url}` }, 500);
    });
  }

  it("renders the header, intake fields, approval status, activity, and export controls", async () => {
    mockDetail();
    renderPage();

    expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
    expect(screen.getByText("NDA with Acme")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Devon Reyes")).toBeInTheDocument();
    expect(screen.getByTestId("request-detail-conversion")).toBeInTheDocument();
    expect(await screen.findByTestId("request-approval-status")).toBeInTheDocument();
    expect(screen.getByTestId("request-approval-badge-pending")).toBeInTheDocument();
    expect(screen.getByText("High priority legal review")).toBeInTheDocument();
    expect(screen.getByText(/current step/i)).toBeInTheDocument();
    expect(await screen.findByTestId("activity-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("activity-export-csv")).toBeInTheDocument();
    expect(screen.getByTestId("activity-export-json")).toBeInTheDocument();

    const body = document.body.textContent ?? "";
    for (const forbidden of [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned",
      "document bytes",
      "generated_docx",
      "original_upload",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("renders the linked Repository button and hides conversion actions when linked", async () => {
    mockDetail(
      LINKED_REQUEST,
      approvalStatus({
        has_active_workflows: false,
        has_completed_workflows: true,
        all_required_policy_workflows_completed: true,
        ready_for_signature: true,
        blocking_reason: null,
        blocking_reason_text: null,
      }),
      [],
    );
    renderPage();

    expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
    expect(await screen.findByTestId("request-detail-repository-link")).toHaveAttribute(
      "href",
      "/repository/contract-1",
    );
    expect(screen.getByTestId("linked-repository-title")).toHaveTextContent(
      "NDA with Acme Repository record",
    );
    expect(screen.getByTestId("request-detail-conversion-disabled")).toBeInTheDocument();
    expect(screen.queryByTestId("request-convert-section")).toBeNull();
    expect(screen.queryByTestId("request-upload-convert-toggle")).toBeNull();
    expect(screen.getByTestId("request-approval-badge-ready")).toBeInTheDocument();
    expect(await screen.findByTestId("activity-timeline-empty")).toBeInTheDocument();
  });

  it("renders blocking approval state safely", async () => {
    mockDetail(
      LINKED_REQUEST,
      approvalStatus({
        ready_for_signature: false,
        has_active_workflows: false,
        has_rejected_workflows: true,
        blocking_reason: "rejected_approval_workflows",
        blocking_reason_text:
          "An approval workflow was rejected; resolve or restart before sending.",
      }),
    );
    renderPage();

    expect(await screen.findByTestId("request-lifecycle-blocking")).toHaveTextContent(
      /rejected/i,
    );
    expect(
      await screen.findByTestId("request-approval-badge-rejected"),
    ).toBeInTheDocument();
  });

  it("renders safe not-found and approval empty states", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse({
          ...approvalStatus({
            has_required_policies: false,
            has_active_workflows: false,
            blocking_reason: null,
            blocking_reason_text: null,
          }),
          matching_policy_ids: [],
          matching_policies: [],
          workflow_runs: [],
        });
      }
      if (url.endsWith("/api/requests/req-1/activity")) {
        return jsonResponse({ items: [] });
      }
      if (url.endsWith("/api/requests/req-1")) {
        return jsonResponse({ detail: "Not found." }, 404);
      }
      return jsonResponse([]);
    });
    renderPage();
    expect(await screen.findByTestId("request-detail-error")).toHaveTextContent(
      /not found/i,
    );

    mockDetail(
      BASE_REQUEST,
      {
        ...approvalStatus({
          has_required_policies: false,
          has_active_workflows: false,
          blocking_reason: null,
          blocking_reason_text: null,
        }),
        matching_policy_ids: [],
        matching_policies: [],
        workflow_runs: [],
      },
      [],
    );
    renderPage();
    expect(await screen.findByTestId("request-approval-none")).toBeInTheDocument();
    expect(await screen.findByTestId("activity-timeline-empty")).toBeInTheDocument();
  });
});
