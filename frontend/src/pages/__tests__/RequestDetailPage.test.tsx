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

  it("renders a plain description unchanged when no supporting-questions block is present", async () => {
    mockDetail({
      ...BASE_REQUEST,
      description: "Please review counterparty paper and flag liability.",
    });
    renderPage();

    expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
    expect(screen.getByTestId("request-description")).toHaveTextContent(
      "Please review counterparty paper and flag liability.",
    );
    expect(screen.queryByTestId("request-supporting-questions")).toBeNull();
  });

  it("pretty-prints a supporting-questions block with label, questions, and answers", async () => {
    mockDetail({
      ...BASE_REQUEST,
      description:
        "Supporting questions (NDA review):\n• Is this mutual or one-way? Mutual\n• Who is disclosing confidential information? Both parties",
    });
    renderPage();

    expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
    expect(screen.getByTestId("request-supporting-questions")).toBeInTheDocument();
    expect(screen.getByTestId("request-supporting-questions-label")).toHaveTextContent(
      "NDA review",
    );
    expect(screen.queryByTestId("request-description")).toBeNull();
    const rows = screen.getAllByTestId("request-supporting-question-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Is this mutual or one-way?");
    expect(rows[0]).toHaveTextContent("Mutual");
    expect(rows[1]).toHaveTextContent("Who is disclosing confidential information?");
    expect(rows[1]).toHaveTextContent("Both parties");
    expect(screen.queryByTestId("request-additional-context")).toBeNull();
  });

  it("renders additional free-text context separately after the supporting-questions block", async () => {
    mockDetail({
      ...BASE_REQUEST,
      description:
        "Supporting questions (Vendor agreement):\n• What product or service is being purchased? Cloud hosting\n• Is this a new vendor or renewal? New vendor\n\nPlease also review the data security addendum and liability cap.",
    });
    renderPage();

    expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
    expect(screen.getByTestId("request-supporting-questions")).toBeInTheDocument();
    const ctx = screen.getByTestId("request-additional-context");
    expect(ctx).toHaveTextContent(
      "Please also review the data security addendum and liability cap.",
    );
  });

  it("fails safe and shows raw description for a malformed supporting-questions block", async () => {
    const malformed =
      "Supporting questions (NDA review):\nNot a bullet line\n• Is this mutual? Mutual";
    mockDetail({ ...BASE_REQUEST, description: malformed });
    renderPage();

    expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
    expect(screen.getByTestId("request-description")).toHaveTextContent(
      "Supporting questions (NDA review):",
    );
    expect(screen.getByTestId("request-description")).toHaveTextContent(
      "Not a bullet line",
    );
    expect(screen.getByTestId("request-description")).toHaveTextContent(
      "Is this mutual? Mutual",
    );
    expect(screen.queryByTestId("request-supporting-questions")).toBeNull();
  });

  it("renders nothing for a null description without errors", async () => {
    mockDetail({ ...BASE_REQUEST, description: null });
    renderPage();

    expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
    expect(screen.queryByTestId("request-description")).toBeNull();
    expect(screen.queryByTestId("request-supporting-questions")).toBeNull();
  });

  it("does not expose forbidden tokens in the description section", async () => {
    mockDetail({
      ...BASE_REQUEST,
      description:
        "Supporting questions (NDA review):\n• Is this mutual or one-way? Mutual",
    });
    renderPage();

    expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
    const body = document.body.textContent ?? "";
    for (const forbidden of [
      "storage_key",
      "wrapped_dek",
      "wrapped_master_key",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned",
      "presigned_url",
      "presigned_uri",
      "docuseal_webhook_secret",
      "docuseal_api_token",
    ]) {
      expect(body).not.toContain(forbidden);
    }
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

  describe("demo seed descriptions", () => {
    // These tests use the exact description strings written into MOCK_REQUESTS
    // to verify that the seeded format parses and renders correctly on the
    // Request Detail page without touching backend or real API calls.

    it("seeded open NDA description renders supporting-questions and additional context", async () => {
      mockDetail({
        ...BASE_REQUEST,
        description:
          "Supporting questions (NDA review):\n• Is this mutual or one-way? Mutual\n• Who is disclosing confidential information? Both parties\n• Preferred confidentiality term? 3 years\n\nStart from the NDA template before sharing roadmap materials with Acme Corp.",
      });
      renderPage();

      expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
      expect(screen.getByTestId("request-supporting-questions")).toBeInTheDocument();
      expect(screen.getByTestId("request-supporting-questions-label")).toHaveTextContent("NDA review");
      const rows = screen.getAllByTestId("request-supporting-question-row");
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveTextContent("Is this mutual or one-way?");
      expect(rows[0]).toHaveTextContent("Mutual");
      expect(rows[1]).toHaveTextContent("Who is disclosing confidential information?");
      expect(rows[1]).toHaveTextContent("Both parties");
      const ctx = screen.getByTestId("request-additional-context");
      expect(ctx).toHaveTextContent("Start from the NDA template");
    });

    it("seeded MSA description renders supporting-questions and additional context", async () => {
      mockDetail({
        ...BASE_REQUEST,
        description:
          "Supporting questions (MSA review):\n• Customer paper or company paper? Customer paper\n• Any attached order forms or SOWs? Yes — two SOWs for onboarding and managed migration\n• Are liability caps negotiable? Yes — targeting 12 months of fees paid\n• Non-standard payment or termination terms? Net-60 payment; 90-day termination for convenience, no cure period.\n\nOnboarding timeline is Q3; confirm SOW milestones align before execution.",
      });
      renderPage();

      expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
      expect(screen.getByTestId("request-supporting-questions")).toBeInTheDocument();
      expect(screen.getByTestId("request-supporting-questions-label")).toHaveTextContent("MSA review");
      const rows = screen.getAllByTestId("request-supporting-question-row");
      expect(rows).toHaveLength(4);
      const ctx = screen.getByTestId("request-additional-context");
      expect(ctx).toHaveTextContent("SOW milestones");
    });

    it("seeded DPA description renders DPA / privacy review label and additional context", async () => {
      mockDetail({
        ...BASE_REQUEST,
        description:
          "Supporting questions (DPA / privacy review):\n• What personal data is involved? Employee directories and project-assignment records synced to vendor HR platform\n• Sensitive personal information involved? No\n• Cross-border transfer expected? Yes — US to EU under standard contractual clauses\n• Counterparty role? Processor\n• Security addendum required? Yes — attached to draft\n\nWaiting on InfoSec sign-off. Draft SCC addendum shared 2026-04-28.",
      });
      renderPage();

      expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
      expect(screen.getByTestId("request-supporting-questions-label")).toHaveTextContent("DPA / privacy review");
      const rows = screen.getAllByTestId("request-supporting-question-row");
      expect(rows).toHaveLength(5);
      expect(screen.getByTestId("request-additional-context")).toHaveTextContent("InfoSec sign-off");
    });

    it("seeded employment description renders Employment agreement label without additional context", async () => {
      mockDetail({
        ...BASE_REQUEST,
        description:
          "Supporting questions (Employment agreement):\n• Employee, contractor, advisor, or consultant? Full-time employee\n• Is equity, bonus, or commission compensation involved? Yes — annual bonus target 12% of base\n• Restrictive covenants expected? Non-solicitation of employees; no non-compete\n• Jurisdiction / state that applies? California",
      });
      renderPage();

      expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
      expect(screen.getByTestId("request-supporting-questions-label")).toHaveTextContent("Employment agreement");
      const rows = screen.getAllByTestId("request-supporting-question-row");
      expect(rows).toHaveLength(4);
      expect(screen.queryByTestId("request-additional-context")).toBeNull();
    });

    it("seeded Atlas NDA renewal description renders 4 supporting-question rows", async () => {
      mockDetail({
        ...BASE_REQUEST,
        description:
          "Supporting questions (NDA review):\n• Is this mutual or one-way? Mutual\n• Who is disclosing confidential information? Both parties — includes product roadmap and pricing\n• Preferred confidentiality term? 5 years\n• Unusual disclosure restrictions to flag? Carve-out for compelled disclosures added by Atlas counsel; review against our standard form.",
      });
      renderPage();

      expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
      expect(screen.getByTestId("request-supporting-questions-label")).toHaveTextContent("NDA review");
      const rows = screen.getAllByTestId("request-supporting-question-row");
      expect(rows).toHaveLength(4);
      expect(rows[3]).toHaveTextContent("Unusual disclosure restrictions to flag?");
    });

    it("seeded vendor description renders Vendor agreement label", async () => {
      mockDetail({
        ...BASE_REQUEST,
        description:
          "Supporting questions (Vendor agreement):\n• What product or service is being purchased? SaaS data pipeline and observability tooling\n• New vendor or renewal? New vendor\n• Will the vendor access company or customer data? Yes — anonymized usage analytics\n• Is a security review required? Yes — completed\n• Estimated contract value? $36,000 annually",
      });
      renderPage();

      expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
      expect(screen.getByTestId("request-supporting-questions-label")).toHaveTextContent("Vendor agreement");
      const rows = screen.getAllByTestId("request-supporting-question-row");
      expect(rows).toHaveLength(5);
      expect(screen.queryByTestId("request-additional-context")).toBeNull();
    });
  });
});
