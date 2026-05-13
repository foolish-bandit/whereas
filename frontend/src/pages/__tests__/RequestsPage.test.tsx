import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RequestsPage from "../RequestsPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const SAMPLE_REQUEST = {
  id: "req-1",
  organization_id: "org-1",
  title: "NDA with Acme",
  description: null,
  request_type: "new_contract",
  contract_type: "NDA",
  status: "open" as const,
  priority: "normal",
  requester_name: null,
  requester_email: null,
  counterparty_name: "Acme",
  due_date: "2026-06-01",
  assigned_to: null,
  linked_contract_id: null,
  linked_template_id: null,
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

function renderPage(initialEntry = "/requests") {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/requests" element={<RequestsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequestsPage", () => {
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

  it("renders an empty state when no requests exist", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage();
    expect(await screen.findByText(/No requests yet/i)).toBeInTheDocument();
  });

  it("renders the request list", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage();
    expect(await screen.findByText("NDA with Acme")).toBeInTheDocument();
    expect(screen.getByTestId("request-status").textContent).toBe("open");
    expect(screen.getByText(/Counterparty: Acme/)).toBeInTheDocument();
  });

  it("clarifies workspace boundaries in the header copy", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage();
    expect(await screen.findByText(/Requests is for intake and triage/i)).toBeInTheDocument();
    expect(screen.getByText(/Inbox is for mixed operational follow-up/i)).toBeInTheDocument();
  });

  it("links each request title and View action to the detail route", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage();
    expect(await screen.findByTestId("request-title-link")).toHaveAttribute(
      "href",
      "/requests/req-1",
    );
    expect(screen.getByTestId("request-view-link")).toHaveAttribute(
      "href",
      "/requests/req-1",
    );
  });

  it("creates a request through the form", async () => {
    let listed = [SAMPLE_REQUEST];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/requests") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        const created = {
          ...SAMPLE_REQUEST,
          id: "req-2",
          title: body.title,
          contract_type: body.contract_type,
        };
        listed = [created, ...listed];
        return jsonResponse(created);
      }
      if (url.includes("/api/requests")) {
        return jsonResponse(listed);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");

    fireEvent.change(screen.getByPlaceholderText(/Title/i), {
      target: { value: "MSA renewal" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/Contract type/i),
      { target: { value: "MSA" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /Create request/i }));

    expect(await screen.findByText("MSA renewal")).toBeInTheDocument();
  });

  it("marks a request in_progress via the Start button", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/api/requests/req-1") && init?.method === "PATCH") {
        return jsonResponse({ ...SAMPLE_REQUEST, status: "in_progress" });
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");

    fireEvent.click(screen.getByRole("button", { name: /Start/i }));

    await waitFor(() => {
      const row = screen.getByTestId("requests-row");
      expect(within(row).getByTestId("request-status").textContent).toBe(
        "in_progress",
      );
    });
  });

  it("hides cancelled requests by default and reveals them via toggle", async () => {
    const cancelled = { ...SAMPLE_REQUEST, id: "req-c", status: "cancelled" };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("include_cancelled=true")) {
        return jsonResponse([SAMPLE_REQUEST, cancelled]);
      }
      return jsonResponse([SAMPLE_REQUEST]);
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    expect(screen.getAllByTestId("requests-row")).toHaveLength(1);

    fireEvent.click(screen.getByLabelText(/Show cancelled/i));
    await waitFor(() => {
      expect(screen.getAllByTestId("requests-row")).toHaveLength(2);
    });
    const statuses = screen
      .getAllByTestId("request-status")
      .map((el) => el.textContent);
    expect(statuses).toContain("cancelled");
  });

  // -------------------------------------------------------------------------
  // PR #48 — request -> contract conversion
  // -------------------------------------------------------------------------

  const TEMPLATE_ID = "tmpl-1";
  const REQ_WITH_TEMPLATE = {
    ...SAMPLE_REQUEST,
    id: "req-tmpl",
    title: "NDA via template",
    linked_template_id: TEMPLATE_ID,
    linked_contract_id: null,
  };
  const REQ_NO_TEMPLATE = {
    ...SAMPLE_REQUEST,
    id: "req-no-tmpl",
    title: "NDA without template",
    linked_template_id: null,
    linked_contract_id: null,
  };
  const REQ_ALREADY_CONVERTED = {
    ...SAMPLE_REQUEST,
    id: "req-done",
    title: "Already converted",
    status: "completed" as const,
    linked_template_id: TEMPLATE_ID,
    linked_contract_id: "contract-xyz",
  };

  const SAMPLE_VARIABLE = {
    id: "var-1",
    template_id: TEMPLATE_ID,
    key: "counterparty_name",
    label: "Counterparty Name",
    variable_type: "text",
    required: true,
    default_value: null,
    help_text: null,
    sort_order: 0,
    metadata_json: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
  };

  const CONVERT_RESPONSE = {
    request: {
      ...REQ_WITH_TEMPLATE,
      status: "completed",
      linked_contract_id: "contract-new",
    },
    contract: {
      id: "contract-new",
      title: "NDA with Acme",
      status: "ready",
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      file_hash_sha256: "0".repeat(64),
      page_count: null,
      created_at: "2026-05-08T16:00:00Z",
      updated_at: "2026-05-08T16:00:00Z",
    },
    artifact: {
      id: "art-1",
      contract_id: "contract-new",
      artifact_type: "generated_docx",
      storage_backend: "s3",
      filename: "nda.docx",
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      file_hash_sha256: null,
      size_bytes: 12345,
      source: "template_generation",
      is_official: true,
      created_at: "2026-05-08T16:00:00Z",
      metadata_json: { template_id: TEMPLATE_ID },
    },
    markdown_snapshot: null,
    variables_used: ["counterparty_name"],
  };

  it("shows the convert section when a request has a linked template", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/api/agreement-templates/") && url.includes("/variables")) {
        return jsonResponse([SAMPLE_VARIABLE]);
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([REQ_WITH_TEMPLATE]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA via template");

    expect(
      await screen.findByTestId("request-convert-section"),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("request-convert-input-counterparty_name"),
    ).toBeInTheDocument();
  });

  it("hides the convert section and shows a hint when no template is linked", async () => {
    fetchMock.mockResolvedValue(jsonResponse([REQ_NO_TEMPLATE]));
    renderPage();
    await screen.findByText("NDA without template");
    expect(screen.queryByTestId("request-convert-section")).toBeNull();
    expect(
      screen.getByTestId("request-no-template-hint"),
    ).toBeInTheDocument();
  });

  it("shows a link to the existing contract when the request is already converted", async () => {
    fetchMock.mockResolvedValue(jsonResponse([REQ_ALREADY_CONVERTED]));
    renderPage();
    await screen.findByText("Already converted");
    expect(screen.queryByTestId("request-convert-section")).toBeNull();
    const link = await screen.findByTestId("request-convert-contract-link");
    expect(link).toHaveAttribute("href", "/repository/contract-xyz");
  });

  it("converts a request and swaps the row state in place", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/api/agreement-templates/") && url.includes("/variables")) {
        return jsonResponse([SAMPLE_VARIABLE]);
      }
      if (
        url.includes("/api/requests/req-tmpl/convert-to-contract") &&
        init?.method === "POST"
      ) {
        return jsonResponse(CONVERT_RESPONSE);
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([REQ_WITH_TEMPLATE]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA via template");

    const input = await screen.findByTestId(
      "request-convert-input-counterparty_name",
    );
    fireEvent.change(input, { target: { value: "Acme" } });

    fireEvent.click(screen.getByTestId("request-convert-submit"));

    // After the conversion, the request row should reflect the new
    // ``completed`` status and surface a link to the generated
    // contract.
    await waitFor(() => {
      const row = screen.getByTestId("requests-row");
      expect(within(row).getByTestId("request-status").textContent).toBe(
        "completed",
      );
    });
    const link = await screen.findByTestId("request-convert-contract-link");
    expect(link).toHaveAttribute("href", "/repository/contract-new");

    // The DOM must not contain any storage internals — the API client
    // scrubs them, but this checks end-to-end at the rendered surface.
    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("wrapped_dek");
  });

  // -------------------------------------------------------------------------
  // PR #56 — request approval visibility
  // -------------------------------------------------------------------------

  const APPROVAL_POLICY = {
    id: "apol-1",
    name: "Standard NDA Policy",
    workflow_template_id: "wftpl-legal",
    auto_attach: true,
    applies_to_generated_contracts: true,
    request_type: null,
    contract_type: "NDA",
    priority: null,
    agreement_template_id: null,
  };

  function approvalStatus(overrides: Record<string, unknown> = {}) {
    return {
      request_id: "req-1",
      linked_contract_id: null,
      matching_policy_ids: [],
      matching_policies: [],
      workflow_runs: [],
      summary: {
        has_required_policies: false,
        has_active_workflows: false,
        has_rejected_workflows: false,
        has_completed_workflows: false,
        all_required_policy_workflows_completed: true,
        ready_for_signature: null,
        blocking_reason: null,
        blocking_reason_text: null,
      },
      ...overrides,
    };
  }

  it("shows the approval status section on toggle and renders matching policy", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      // PR #58: expanding the approval section also fires
      // GET /api/requests/{id}/activity. Stub it out so these older
      // tests don't fall through to the 500 default.
      if (url.includes("/activity")) return jsonResponse({ items: [] });
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(
          approvalStatus({
            matching_policy_ids: [APPROVAL_POLICY.id],
            matching_policies: [APPROVAL_POLICY],
            summary: {
              has_required_policies: true,
              has_active_workflows: false,
              has_rejected_workflows: false,
              has_completed_workflows: false,
              all_required_policy_workflows_completed: false,
              ready_for_signature: null,
              blocking_reason: "required_approval_policy_unmet",
              blocking_reason_text:
                "A required approval policy has not been satisfied.",
            },
          }),
        );
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");

    // Section is hidden until the user opens it.
    expect(screen.queryByTestId("request-approval-status")).toBeNull();

    fireEvent.click(screen.getByTestId("request-approval-toggle"));

    expect(
      await screen.findByTestId("request-approval-status"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("request-approval-policy"),
    ).toHaveTextContent("Standard NDA Policy");
    expect(
      screen.getByTestId("request-approval-blocking-reason"),
    ).toHaveTextContent(/required approval policy/i);
  });

  it("renders an active workflow with the current step", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      // PR #58: expanding the approval section also fires
      // GET /api/requests/{id}/activity. Stub it out so these older
      // tests don't fall through to the 500 default.
      if (url.includes("/activity")) return jsonResponse({ items: [] });
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(
          approvalStatus({
            workflow_runs: [
              {
                id: "wf-1",
                name: "Standard NDA Policy - NDA with Acme",
                status: "active",
                current_step_order: 1,
                started_at: "2026-05-08T16:00:00Z",
                completed_at: null,
                source_approval_policy_id: APPROVAL_POLICY.id,
                source_approval_policy_name: APPROVAL_POLICY.name,
                steps: [
                  {
                    id: "step-1",
                    step_order: 1,
                    title: "Legal review",
                    status: "pending",
                    assigned_to: null,
                    approver_name: null,
                    approver_email: "legal@example.com",
                    due_date: null,
                    decided_at: null,
                  },
                ],
              },
            ],
            summary: {
              has_required_policies: false,
              has_active_workflows: true,
              has_rejected_workflows: false,
              has_completed_workflows: false,
              all_required_policy_workflows_completed: true,
              ready_for_signature: null,
              blocking_reason: "active_approval_workflows",
              blocking_reason_text:
                "An approval workflow is still active and waiting on a decision.",
            },
          }),
        );
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.click(screen.getByTestId("request-approval-toggle"));

    expect(
      await screen.findByTestId("request-approval-current-step"),
    ).toHaveTextContent("1. Legal review");
    expect(
      screen.getByTestId("request-approval-workflow-status"),
    ).toHaveTextContent("active");
    expect(
      screen.getByTestId("request-approval-badge-pending"),
    ).toBeInTheDocument();
  });

  it("renders a ready-for-signature badge when the gate allows", async () => {
    const linked = { ...SAMPLE_REQUEST, linked_contract_id: "contract-1" };
    fetchMock.mockImplementation(async (url: string) => {
      // PR #58: expanding the approval section also fires
      // GET /api/requests/{id}/activity. Stub it out so these older
      // tests don't fall through to the 500 default.
      if (url.includes("/activity")) return jsonResponse({ items: [] });
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(
          approvalStatus({
            linked_contract_id: "contract-1",
            workflow_runs: [
              {
                id: "wf-2",
                name: "Approved",
                status: "completed",
                current_step_order: 1,
                started_at: "2026-05-08T16:00:00Z",
                completed_at: "2026-05-09T08:00:00Z",
                source_approval_policy_id: null,
                source_approval_policy_name: null,
                steps: [],
              },
            ],
            summary: {
              has_required_policies: false,
              has_active_workflows: false,
              has_rejected_workflows: false,
              has_completed_workflows: true,
              all_required_policy_workflows_completed: true,
              ready_for_signature: true,
              blocking_reason: null,
              blocking_reason_text: null,
            },
          }),
        );
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([linked]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.click(screen.getByTestId("request-approval-toggle"));

    expect(
      await screen.findByTestId("request-approval-badge-ready"),
    ).toBeInTheDocument();
    const link = screen.getByTestId("request-approval-contract-link");
    expect(link).toHaveAttribute("href", "/repository/contract-1");
  });

  it("renders a rejected/blocked badge with the gate reason text", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      // PR #58: expanding the approval section also fires
      // GET /api/requests/{id}/activity. Stub it out so these older
      // tests don't fall through to the 500 default.
      if (url.includes("/activity")) return jsonResponse({ items: [] });
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(
          approvalStatus({
            workflow_runs: [
              {
                id: "wf-3",
                name: "Legal",
                status: "rejected",
                current_step_order: 1,
                started_at: "2026-05-08T16:00:00Z",
                completed_at: "2026-05-08T17:00:00Z",
                source_approval_policy_id: null,
                source_approval_policy_name: null,
                steps: [],
              },
            ],
            summary: {
              has_required_policies: false,
              has_active_workflows: false,
              has_rejected_workflows: true,
              has_completed_workflows: false,
              all_required_policy_workflows_completed: true,
              ready_for_signature: null,
              blocking_reason: "rejected_approval_workflows",
              blocking_reason_text:
                "An approval workflow was rejected; resolve or restart before sending.",
            },
          }),
        );
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.click(screen.getByTestId("request-approval-toggle"));

    expect(
      await screen.findByTestId("request-approval-badge-rejected"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("request-approval-blocking-reason"),
    ).toHaveTextContent(/rejected/i);
  });

  it("shows a no-approval-required state when nothing applies", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      // PR #58: expanding the approval section also fires
      // GET /api/requests/{id}/activity. Stub it out so these older
      // tests don't fall through to the 500 default.
      if (url.includes("/activity")) return jsonResponse({ items: [] });
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(approvalStatus());
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.click(screen.getByTestId("request-approval-toggle"));

    expect(
      await screen.findByTestId("request-approval-badge-none"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("request-approval-none"),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // PR #61 — gate remediation deep-link
  // -------------------------------------------------------------------------

  it("auto-expands and highlights the deep-linked request_id row", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/activity")) return jsonResponse({ items: [] });
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(approvalStatus());
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage("/requests?request_id=req-1");
    // Approval status is auto-expanded by the deep link (no toggle click).
    await screen.findByTestId("request-approval-status");
    const row = screen.getByTestId("requests-row");
    expect(row).toHaveAttribute("data-deep-link-target", "true");
    expect(row).toHaveAttribute("aria-label", expect.stringMatching(/linked request/i));
  });

  it("shows a not-found notice when the deep-linked request is missing", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage("/requests?request_id=req-missing");
    await screen.findByText("NDA with Acme");
    const notice = await screen.findByTestId("requests-deep-link-not-found");
    expect(notice).toHaveTextContent("req-missing");
    // No row should be highlighted.
    expect(
      screen.queryByTestId("requests-row")?.getAttribute("data-deep-link-target"),
    ).toBeFalsy();
  });

  it("does not surface storage internals on the deep-linked row", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/activity")) return jsonResponse({ items: [] });
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(approvalStatus());
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage("/requests?request_id=req-1");
    await screen.findByTestId("request-approval-status");
    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("wrapped_dek");
  });

  it("renders a safe error state when the approval-status fetch fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      // PR #58: expanding the approval section also fires
      // GET /api/requests/{id}/activity. Stub it out so these older
      // tests don't fall through to the 500 default.
      if (url.includes("/activity")) return jsonResponse({ items: [] });
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse({ detail: "boom" }, 500);
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.click(screen.getByTestId("request-approval-toggle"));

    expect(
      await screen.findByTestId("request-approval-status-error"),
    ).toHaveTextContent(/boom|server failed/i);
  });

  it("does not render storage internals when approval status renders", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      // PR #58: expanding the approval section also fires
      // GET /api/requests/{id}/activity. Stub it out so these older
      // tests don't fall through to the 500 default.
      if (url.includes("/activity")) return jsonResponse({ items: [] });
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(
          approvalStatus({
            matching_policies: [APPROVAL_POLICY],
            matching_policy_ids: [APPROVAL_POLICY.id],
            workflow_runs: [
              {
                id: "wf-1",
                name: "Workflow",
                status: "active",
                current_step_order: 1,
                started_at: "2026-05-08T16:00:00Z",
                completed_at: null,
                source_approval_policy_id: APPROVAL_POLICY.id,
                source_approval_policy_name: APPROVAL_POLICY.name,
                steps: [
                  {
                    id: "step-1",
                    step_order: 1,
                    title: "Legal review",
                    status: "pending",
                    assigned_to: null,
                    approver_name: null,
                    approver_email: "legal@example.com",
                    due_date: null,
                    decided_at: null,
                  },
                ],
              },
            ],
          }),
        );
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.click(screen.getByTestId("request-approval-toggle"));
    await screen.findByTestId("request-approval-status");

    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("wrapped_dek");
    expect(document.body.textContent ?? "").not.toContain("s3_key");
  });

  it("surfaces a backend error in the convert form", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/api/agreement-templates/") && url.includes("/variables")) {
        return jsonResponse([SAMPLE_VARIABLE]);
      }
      if (
        url.includes("/api/requests/req-tmpl/convert-to-contract") &&
        init?.method === "POST"
      ) {
        return jsonResponse(
          { detail: "Missing required variable: counterparty_name." },
          400,
        );
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([REQ_WITH_TEMPLATE]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA via template");

    // Force-submit by stuffing the value the form would normally
    // require, then having the backend reject it. This exercises the
    // error rendering path independent of the client-side disabled
    // gating.
    const input = await screen.findByTestId(
      "request-convert-input-counterparty_name",
    );
    fireEvent.change(input, { target: { value: "Acme" } });
    fireEvent.click(screen.getByTestId("request-convert-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("request-convert-error").textContent).toMatch(
        /Missing required variable/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // PR #65 — request → Repository conversion via uploaded file
  // -------------------------------------------------------------------------

  const REQ_OPEN_NO_LINK = {
    ...SAMPLE_REQUEST,
    id: "req-upload",
    title: "Upload-eligible request",
    counterparty_name: "Acme",
    contract_type: "NDA",
    linked_template_id: null,
    linked_contract_id: null,
  };

  const REQ_CANCELLED = {
    ...SAMPLE_REQUEST,
    id: "req-cancel",
    title: "Cancelled request",
    status: "cancelled" as const,
  };

  const REQ_ALREADY_LINKED = {
    ...SAMPLE_REQUEST,
    id: "req-linked",
    title: "Already linked",
    status: "completed" as const,
    linked_contract_id: "contract-existing",
  };

  const UPLOAD_RESPONSE = {
    request: {
      ...REQ_OPEN_NO_LINK,
      status: "completed",
      linked_contract_id: "contract-new",
    },
    contract: {
      id: "contract-new",
      title: "Acme NDA — countersigned",
      status: "ready",
      mime_type: "application/pdf",
      file_hash_sha256: "0".repeat(64),
      page_count: 1,
      created_at: "2026-05-10T16:00:00Z",
      updated_at: "2026-05-10T16:00:00Z",
    },
    artifact: {
      id: "art-upload-1",
      contract_id: "contract-new",
      artifact_type: "original_upload",
      storage_backend: "s3",
      filename: "counterparty.pdf",
      mime_type: "application/pdf",
      file_hash_sha256: "0".repeat(64),
      size_bytes: 42,
      source: "request_upload",
      is_official: true,
      created_at: "2026-05-10T16:00:00Z",
      metadata_json: {
        request_id: "req-upload",
        upload_source: "request_conversion",
        counterparty_name: "Acme",
        contract_type: "NDA",
      },
    },
    markdown_snapshot: null,
  };

  function fakePdfFile(name = "counterparty.pdf"): File {
    return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
      type: "application/pdf",
    });
  }

  it("renders the upload-convert toggle for an eligible request", async () => {
    fetchMock.mockResolvedValue(jsonResponse([REQ_OPEN_NO_LINK]));
    renderPage();
    await screen.findByText("Upload-eligible request");
    expect(
      screen.getByTestId("request-upload-convert-toggle"),
    ).toBeInTheDocument();
  });

  it("hides the upload-convert section for cancelled requests", async () => {
    fetchMock.mockResolvedValue(jsonResponse([REQ_CANCELLED]));
    // Cancelled rows aren't shown by default; toggle to surface them.
    renderPage();
    fireEvent.click(screen.getByLabelText(/Show cancelled/i));
    await waitFor(() => {
      expect(
        screen.queryByTestId("request-upload-convert-toggle"),
      ).toBeNull();
    });
  });

  it("hides the upload-convert section once a contract is already linked", async () => {
    fetchMock.mockResolvedValue(jsonResponse([REQ_ALREADY_LINKED]));
    renderPage();
    await screen.findByText("Already linked");
    expect(
      screen.queryByTestId("request-upload-convert-toggle"),
    ).toBeNull();
    // The existing "Linked contract" affordance still renders.
    expect(
      screen.getByTestId("request-converted-link"),
    ).toBeInTheDocument();
  });

  it("uploads a file, swaps the row to completed, and surfaces the Repository link", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (
        url.includes("/api/requests/req-upload/convert-upload") &&
        init?.method === "POST"
      ) {
        // The body must be a FormData with the file part attached.
        expect(init.body).toBeInstanceOf(FormData);
        return jsonResponse(UPLOAD_RESPONSE, 201);
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([REQ_OPEN_NO_LINK]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Upload-eligible request");

    fireEvent.click(screen.getByTestId("request-upload-convert-toggle"));

    const fileInput = screen.getByTestId(
      "request-upload-convert-file",
    ) as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [fakePdfFile()] },
    });

    fireEvent.click(screen.getByTestId("request-upload-convert-submit"));

    await waitFor(() => {
      const row = screen.getByTestId("requests-row");
      expect(within(row).getByTestId("request-status").textContent).toBe(
        "completed",
      );
    });
    const link = await screen.findByTestId(
      "request-convert-contract-link",
    );
    expect(link).toHaveAttribute("href", "/repository/contract-new");
    // Storage internals never make it into the rendered DOM.
    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("wrapped_dek");
  });

  it("renders a safe error state when the backend rejects the upload", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (
        url.includes("/api/requests/req-upload/convert-upload") &&
        init?.method === "POST"
      ) {
        return jsonResponse(
          { detail: "Uploaded file is empty." },
          400,
        );
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([REQ_OPEN_NO_LINK]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Upload-eligible request");

    fireEvent.click(screen.getByTestId("request-upload-convert-toggle"));
    const fileInput = screen.getByTestId(
      "request-upload-convert-file",
    ) as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [fakePdfFile("empty.pdf")] },
    });
    fireEvent.click(screen.getByTestId("request-upload-convert-submit"));

    expect(
      await screen.findByTestId("request-upload-convert-error"),
    ).toHaveTextContent(/empty/i);
    // The row's status did NOT flip — the failure preserved state.
    expect(screen.getByTestId("request-status").textContent).toBe("open");
  });

  it("renders the workspace card pointing at uploading third-party agreements", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage();
    const card = await screen.findByTestId("requests-card-upload");
    expect(card).toBeInTheDocument();
    expect(card.textContent ?? "").toMatch(/third-party agreement/i);
  });

  // -------------------------------------------------------------------------
  // PR #66 — upload-intake feedback (extracted metadata + duplicates)
  // -------------------------------------------------------------------------

  const UPLOAD_RESPONSE_WITH_INTAKE = {
    ...UPLOAD_RESPONSE,
    extracted_metadata: {
      suggested_title: "Mutual NDA Acme",
      likely_contract_type: "NDA",
      possible_counterparty_name: "Acme",
      effective_date: "2026-05-01",
      warnings: [],
    },
    duplicate_candidates: [
      {
        contract_id: "contract-existing-1",
        title: "Acme NDA — original draft",
        reason: "exact_file_hash" as const,
        confidence: "exact" as const,
        created_at: "2026-04-01T12:00:00Z",
        status: "ready",
      },
    ],
  };

  it("surfaces the review panel with extracted metadata + duplicate warning after upload", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (
        url.includes("/api/requests/req-upload/convert-upload") &&
        init?.method === "POST"
      ) {
        return jsonResponse(UPLOAD_RESPONSE_WITH_INTAKE, 201);
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([REQ_OPEN_NO_LINK]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Upload-eligible request");

    fireEvent.click(screen.getByTestId("request-upload-convert-toggle"));
    const fileInput = screen.getByTestId(
      "request-upload-convert-file",
    ) as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [fakePdfFile()] },
    });
    fireEvent.click(screen.getByTestId("request-upload-convert-submit"));

    // PR #67 — the review panel lands once the upload completes,
    // pre-filled with extracted suggestions and warning about the
    // matching duplicate.
    const feedback = await screen.findByTestId("request-upload-feedback");
    expect(feedback).toBeInTheDocument();
    expect(
      within(feedback).getByTestId("upload-review-duplicate-warning"),
    ).toBeInTheDocument();
    expect(
      (within(feedback).getByTestId(
        "upload-review-contract-type",
      ) as HTMLInputElement).value,
    ).toBe("NDA");
    // Storage internals never appear anywhere in the DOM.
    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("wrapped_dek");
  });

  it("still renders the review panel when no duplicates/metadata are detected, with quiet state", async () => {
    const quietResponse = {
      ...UPLOAD_RESPONSE,
      extracted_metadata: {
        suggested_title: null,
        likely_contract_type: null,
        possible_counterparty_name: null,
        effective_date: null,
        warnings: ["contract_type_unknown"],
      },
      duplicate_candidates: [],
    };
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (
        url.includes("/api/requests/req-upload/convert-upload") &&
        init?.method === "POST"
      ) {
        return jsonResponse(quietResponse, 201);
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([REQ_OPEN_NO_LINK]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("Upload-eligible request");
    fireEvent.click(screen.getByTestId("request-upload-convert-toggle"));
    const fileInput = screen.getByTestId(
      "request-upload-convert-file",
    ) as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [fakePdfFile()] },
    });
    fireEvent.click(screen.getByTestId("request-upload-convert-submit"));

    // Wait until the row flips so we know the upload returned.
    await waitFor(() => {
      const row = screen.getByTestId("requests-row");
      expect(within(row).getByTestId("request-status").textContent).toBe(
        "completed",
      );
    });

    // The review panel always renders post-upload (PR #67) — the
    // duplicate section just shows the quiet "no obvious duplicates"
    // line when the list is empty.
    const feedback = screen.getByTestId("request-upload-feedback");
    expect(
      within(feedback).getByTestId("upload-review-no-duplicates"),
    ).toBeInTheDocument();
    expect(
      within(feedback).queryByTestId("upload-review-duplicate-warning"),
    ).toBeNull();
  });

  // ---------------------------------------------------------------------
  // PR #126 — Supporting questions in the create form
  // ---------------------------------------------------------------------

  it("shows the 'pick a type' pending state when no request_type or contract_type is set", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage();
    await screen.findByText("NDA with Acme");
    expect(
      screen.getByTestId("requests-create-supporting-questions-pending"),
    ).toBeInTheDocument();
  });

  it("renders the NDA question set when contract_type contains 'NDA'", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.change(screen.getByPlaceholderText(/Contract type/i), {
      target: { value: "NDA" },
    });
    const panel = screen.getByTestId("requests-create-supporting-questions");
    expect(panel.getAttribute("data-supporting-question-group")).toBe("nda");
    expect(panel.textContent).toMatch(/mutual or one-way/i);
  });

  it("switches the question set when contract_type changes from NDA to Vendor", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.change(screen.getByPlaceholderText(/Contract type/i), {
      target: { value: "NDA" },
    });
    expect(
      screen
        .getByTestId("requests-create-supporting-questions")
        .getAttribute("data-supporting-question-group"),
    ).toBe("nda");
    fireEvent.change(screen.getByPlaceholderText(/Contract type/i), {
      target: { value: "Vendor agreement" },
    });
    const panel = screen.getByTestId("requests-create-supporting-questions");
    expect(panel.getAttribute("data-supporting-question-group")).toBe(
      "vendor",
    );
    expect(panel.textContent).toMatch(/product or service/i);
  });

  it("falls back to the general 'other' question set for an unrecognized type", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.change(screen.getByPlaceholderText(/Contract type/i), {
      target: { value: "Statement of work" },
    });
    expect(
      screen
        .getByTestId("requests-create-supporting-questions")
        .getAttribute("data-supporting-question-group"),
    ).toBe("other");
  });

  it("summarises supporting-question answers into description on submit, without sending unsupported fields", async () => {
    let postBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/requests") && init?.method === "POST") {
        postBody = JSON.parse(init.body as string);
        return jsonResponse({
          ...SAMPLE_REQUEST,
          id: "req-new",
          title: postBody!.title as string,
          description: postBody!.description as string | null,
          contract_type: postBody!.contract_type as string | null,
        });
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");

    fireEvent.change(screen.getByPlaceholderText(/Title/i), {
      target: { value: "NDA with Globex" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Contract type/i), {
      target: { value: "NDA" },
    });
    // Fill one structured answer …
    const inputs = screen.getAllByTestId(
      "requests-create-supporting-questions-input",
    );
    const directionInput = inputs.find(
      (el) =>
        el.getAttribute("data-supporting-question-input") === "nda_direction",
    )!;
    fireEvent.change(directionInput, { target: { value: "Mutual, 3 years" } });
    // … plus a free-text description.
    fireEvent.change(screen.getByTestId("requests-create-description"), {
      target: { value: "Counterparty asked for quick turnaround." },
    });

    fireEvent.click(screen.getByTestId("requests-create-submit"));

    await waitFor(() => expect(postBody).not.toBeNull());
    // The payload uses only fields the existing POST /api/requests endpoint
    // accepts.
    const allowedKeys = new Set([
      "title",
      "description",
      "contract_type",
      "request_type",
      "priority",
      "counterparty_name",
      "due_date",
    ]);
    for (const key of Object.keys(postBody!)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    expect(postBody).toMatchObject({
      title: "NDA with Globex",
      contract_type: "NDA",
    });
    const description = postBody!.description as string;
    expect(description).toContain("Supporting questions (NDA review)");
    expect(description).toContain("Mutual, 3 years");
    expect(description).toContain("Counterparty asked for quick turnaround.");
    // No structured side-channel: no top-level `supporting_answers`,
    // `metadata_json`, or similar field.
    expect(postBody).not.toHaveProperty("supporting_answers");
    expect(postBody).not.toHaveProperty("metadata_json");
  });

  it("submits description as null when neither free-text nor structured answers are provided", async () => {
    let postBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/requests") && init?.method === "POST") {
        postBody = JSON.parse(init.body as string);
        return jsonResponse({
          ...SAMPLE_REQUEST,
          id: "req-new",
          title: postBody!.title as string,
          description: postBody!.description as string | null,
        });
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.change(screen.getByPlaceholderText(/Title/i), {
      target: { value: "Empty body request" },
    });
    fireEvent.click(screen.getByTestId("requests-create-submit"));
    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody!.description).toBeNull();
  });

  it("does not leak forbidden tokens via the supporting-questions panel", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage();
    await screen.findByText("NDA with Acme");
    fireEvent.change(screen.getByPlaceholderText(/Contract type/i), {
      target: { value: "DPA" },
    });
    const text = document.body.textContent ?? "";
    for (const needle of [
      "storage_key",
      "wrapped_dek",
      "wrapped_master_key",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned_url",
      "presigned_uri",
      "docuseal_webhook_secret",
      "docuseal_api_token",
    ]) {
      expect(text).not.toContain(needle);
    }
  });

  // ---------------------------------------------------------------------
  // Template-Aware Supporting Questions
  // ---------------------------------------------------------------------

  const SAMPLE_TEMPLATES = [
    {
      id: "tpl-nda",
      organization_id: "org-1",
      name: "Mutual NDA template",
      description: null,
      template_type: "NDA",
      status: "active",
      created_at: "2026-04-01T10:00:00Z",
      updated_at: "2026-04-15T10:00:00Z",
      metadata_json: null,
    },
    {
      id: "tpl-dpa",
      organization_id: "org-1",
      name: "Data Processing Addendum",
      description: null,
      template_type: null,
      status: "active",
      created_at: "2026-04-02T10:00:00Z",
      updated_at: "2026-04-15T10:00:00Z",
      metadata_json: { contract_type: "dpa" },
    },
  ];

  function mockWithTemplates(handler?: (url: string, init: RequestInit) => Response | undefined) {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const custom = handler?.(url, init);
      if (custom) return custom;
      if (url.includes("/api/agreement-templates")) {
        return jsonResponse(SAMPLE_TEMPLATES);
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
  }

  it("switches the supporting-question set when an NDA template is selected (even with no request_type)", async () => {
    mockWithTemplates();
    renderPage();
    await screen.findByText("NDA with Acme");
    // Wait for templates to load into the selector.
    await waitFor(() => {
      const opts = Array.from(
        screen
          .getByTestId("requests-create-template")
          .querySelectorAll("option"),
      ).map((o) => o.textContent ?? "");
      expect(opts).toContain("Mutual NDA template");
    });

    fireEvent.change(screen.getByTestId("requests-create-template"), {
      target: { value: "tpl-nda" },
    });
    const panel = screen.getByTestId("requests-create-supporting-questions");
    expect(panel.getAttribute("data-supporting-question-group")).toBe("nda");
    expect(
      screen.getByTestId("requests-create-supporting-questions-hint"),
    ).toHaveTextContent(/tailored from the selected agreement template/i);
  });

  it("switches to DPA questions when a DPA template (via metadata.contract_type) is selected", async () => {
    mockWithTemplates();
    renderPage();
    await screen.findByText("NDA with Acme");
    await waitFor(() => {
      const opts = Array.from(
        screen
          .getByTestId("requests-create-template")
          .querySelectorAll("option"),
      ).map((o) => o.textContent ?? "");
      expect(opts).toContain("Data Processing Addendum");
    });
    fireEvent.change(screen.getByTestId("requests-create-template"), {
      target: { value: "tpl-dpa" },
    });
    expect(
      screen
        .getByTestId("requests-create-supporting-questions")
        .getAttribute("data-supporting-question-group"),
    ).toBe("dpa");
  });

  it("falls back to request/contract type behavior when the template is cleared", async () => {
    mockWithTemplates();
    renderPage();
    await screen.findByText("NDA with Acme");
    await waitFor(() => {
      const opts = Array.from(
        screen
          .getByTestId("requests-create-template")
          .querySelectorAll("option"),
      ).map((o) => o.textContent ?? "");
      expect(opts).toContain("Mutual NDA template");
    });

    // Set vendor in contract type first, then pick an NDA template
    // (template should win), then clear template (should revert to
    // vendor).
    fireEvent.change(screen.getByPlaceholderText(/Contract type/i), {
      target: { value: "Vendor agreement" },
    });
    fireEvent.change(screen.getByTestId("requests-create-template"), {
      target: { value: "tpl-nda" },
    });
    expect(
      screen
        .getByTestId("requests-create-supporting-questions")
        .getAttribute("data-supporting-question-group"),
    ).toBe("nda");

    fireEvent.change(screen.getByTestId("requests-create-template"), {
      target: { value: "" },
    });
    expect(
      screen
        .getByTestId("requests-create-supporting-questions")
        .getAttribute("data-supporting-question-group"),
    ).toBe("vendor");
    expect(
      screen.queryByTestId("requests-create-supporting-questions-hint"),
    ).toBeNull();
  });

  it("submits the template-derived summary label without leaking linked_template_id or other unsupported fields", async () => {
    let postBody: Record<string, unknown> | null = null;
    mockWithTemplates((url, init) => {
      if (url.endsWith("/api/requests") && init?.method === "POST") {
        postBody = JSON.parse(init.body as string);
        return jsonResponse({
          ...SAMPLE_REQUEST,
          id: "req-new",
          title: postBody!.title as string,
          description: postBody!.description as string | null,
        });
      }
      return undefined;
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    await waitFor(() => {
      const opts = Array.from(
        screen
          .getByTestId("requests-create-template")
          .querySelectorAll("option"),
      ).map((o) => o.textContent ?? "");
      expect(opts).toContain("Mutual NDA template");
    });
    fireEvent.change(screen.getByPlaceholderText(/Title/i), {
      target: { value: "NDA with Globex" },
    });
    fireEvent.change(screen.getByTestId("requests-create-template"), {
      target: { value: "tpl-nda" },
    });
    const inputs = screen.getAllByTestId(
      "requests-create-supporting-questions-input",
    );
    const directionInput = inputs.find(
      (el) =>
        el.getAttribute("data-supporting-question-input") === "nda_direction",
    )!;
    fireEvent.change(directionInput, { target: { value: "Mutual" } });
    fireEvent.click(screen.getByTestId("requests-create-submit"));
    await waitFor(() => expect(postBody).not.toBeNull());
    // Existing allowed-key set — `linked_template_id` is intentionally
    // not included because the template here drives only supporting
    // questions, not the request's linked template.
    const allowedKeys = new Set([
      "title",
      "description",
      "contract_type",
      "request_type",
      "priority",
      "counterparty_name",
      "due_date",
    ]);
    for (const key of Object.keys(postBody!)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    expect(postBody).not.toHaveProperty("linked_template_id");
    expect(postBody).not.toHaveProperty("supporting_answers");
    expect(postBody).not.toHaveProperty("metadata_json");
    expect(postBody!.description as string).toContain(
      "Supporting questions (NDA review)",
    );
    expect(postBody!.description as string).toContain("Mutual");
  });

  it("preserves the existing free-text supporting info alongside template-driven questions", async () => {
    let postBody: Record<string, unknown> | null = null;
    mockWithTemplates((url, init) => {
      if (url.endsWith("/api/requests") && init?.method === "POST") {
        postBody = JSON.parse(init.body as string);
        return jsonResponse({
          ...SAMPLE_REQUEST,
          id: "req-new",
          description: postBody!.description as string | null,
        });
      }
      return undefined;
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    await waitFor(() => {
      const opts = Array.from(
        screen
          .getByTestId("requests-create-template")
          .querySelectorAll("option"),
      ).map((o) => o.textContent ?? "");
      expect(opts).toContain("Mutual NDA template");
    });
    fireEvent.change(screen.getByPlaceholderText(/Title/i), {
      target: { value: "NDA with Globex" },
    });
    fireEvent.change(screen.getByTestId("requests-create-template"), {
      target: { value: "tpl-nda" },
    });
    fireEvent.change(screen.getByTestId("requests-create-description"), {
      target: { value: "Counterparty wants quick turnaround." },
    });
    fireEvent.click(screen.getByTestId("requests-create-submit"));
    await waitFor(() => expect(postBody).not.toBeNull());
    expect(postBody!.description as string).toContain(
      "Counterparty wants quick turnaround.",
    );
  });

  it("tolerates a failed agreement-template fetch — form still works", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/api/agreement-templates")) {
        return jsonResponse({ detail: "boom" }, 500);
      }
      if (url.includes("/api/requests")) {
        return jsonResponse([SAMPLE_REQUEST]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText("NDA with Acme");
    // Template selector is present but only has the placeholder option.
    const select = screen.getByTestId("requests-create-template");
    expect(select).toBeInTheDocument();
    expect(select.querySelectorAll("option")).toHaveLength(1);
    // Without a template, the pending state still applies until the
    // user picks a request/contract type — unchanged behavior.
    expect(
      screen.getByTestId("requests-create-supporting-questions-pending"),
    ).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------
  // Stage pill in request rows
  // ---------------------------------------------------------------------

  it("renders a stage pill for each request row", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_REQUEST]));
    renderPage();
    await screen.findByText("NDA with Acme");
    expect(screen.getByTestId("request-stage")).toBeInTheDocument();
    const pill = screen.getByTestId("request-stage-pill");
    expect(pill).toBeInTheDocument();
    expect(pill.textContent).toBe("Awaiting review");
  });

  it("stage pill reflects in_progress status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ ...SAMPLE_REQUEST, status: "in_progress" }]),
    );
    renderPage();
    await screen.findByText("NDA with Acme");
    expect(screen.getByTestId("request-stage-pill").textContent).toBe("In review");
  });

  it("stage pill shows Converted to Repository for completed + linked", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          ...SAMPLE_REQUEST,
          status: "completed",
          linked_contract_id: "c-xyz",
        },
      ]),
    );
    renderPage();
    await screen.findByText("NDA with Acme");
    expect(screen.getByTestId("request-stage-pill").textContent).toBe(
      "Converted to Repository",
    );
  });

  it("stage pill shows Closed for cancelled rows", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("include_cancelled=true")) {
        return jsonResponse([{ ...SAMPLE_REQUEST, status: "cancelled" }]);
      }
      return jsonResponse([SAMPLE_REQUEST]);
    });
    renderPage();
    fireEvent.click(screen.getByLabelText(/Show cancelled/i));
    await waitFor(() => {
      expect(screen.getByTestId("request-stage-pill").textContent).toBe("Closed");
    });
  });
});
