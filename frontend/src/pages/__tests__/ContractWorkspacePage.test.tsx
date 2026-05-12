import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import ContractWorkspacePage from "../ContractWorkspacePage";
import { setDevUserId, clearDevUserId } from "../../lib/devUser";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const CONTRACT_ID = "22222222-2222-4222-8222-222222222222";

const CONTRACT_DETAIL = {
  id: CONTRACT_ID,
  title: "Test MSA",
  status: "ready",
  mime_type: "application/pdf",
  file_hash_sha256: "0".repeat(64),
  page_count: 3,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:01Z",
  full_text: "Some plain text body.",
  extracted_fields: [],
  clauses: [],
};

const ARTIFACT = {
  id: "44444444-4444-4444-8444-444444444444",
  contract_id: CONTRACT_ID,
  artifact_type: "original_upload",
  storage_backend: "s3",
  filename: "vendor-msa.pdf",
  mime_type: "application/pdf",
  file_hash_sha256: "0".repeat(64),
  size_bytes: 12345,
  source: "user_upload",
  is_official: true,
  created_at: "2026-05-01T00:00:00Z",
  metadata_json: null,
};

const SNAPSHOT = {
  id: "33333333-3333-4333-8333-333333333333",
  contract_id: CONTRACT_ID,
  markdown_text: "# Workspace markdown\n\nFast working preview.\n",
  source_kind: "original_upload",
  converter_name: "markitdown",
  converter_version: null,
  conversion_status: "ready",
  conversion_warnings: null,
  created_at: "2026-05-08T00:00:00Z",
};

const METADATA_VIEW = {
  contract_id: CONTRACT_ID,
  title: CONTRACT_DETAIL.title,
  counterparty_name: null,
  contract_type: null,
  effective_date: null,
  updated_at: CONTRACT_DETAIL.updated_at,
  changed_fields: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setupFetch(
  fetchMock: Mock,
  options: {
    snapshot?: object | null;
    artifacts?: object[];
    metadata?: object | null;
  } = {},
) {
  const snapshot =
    "snapshot" in options ? options.snapshot ?? null : SNAPSHOT;
  const artifacts =
    "artifacts" in options ? options.artifacts ?? [] : [ARTIFACT];
  const metadata =
    "metadata" in options ? options.metadata : METADATA_VIEW;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
      return snapshot
        ? jsonResponse(snapshot)
        : jsonResponse({ detail: "not found" }, 404);
    }
    if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
      return jsonResponse(artifacts);
    }
    if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
      return metadata
        ? jsonResponse(metadata)
        : jsonResponse({ detail: "not found" }, 404);
    }
    if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
      return jsonResponse(CONTRACT_DETAIL);
    }
    return jsonResponse({ detail: "unexpected" }, 500);
  });
}

function renderPage(path: string = `/contracts/${CONTRACT_ID}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/contracts/:id"
          element={<ContractWorkspacePage />}
        />
        <Route
          path="/repository/:id"
          element={<ContractWorkspacePage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ContractWorkspacePage markdown integration", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(VALID_UUID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("defaults to the markdown preview and shows the toggle + Download current document action", async () => {
    setupFetch(fetchMock);
    renderPage();

    await screen.findByRole("heading", {
      level: 1,
      name: "Workspace markdown",
    });

    const group = screen.getByRole("group", { name: /document view/i });
    const buttons = group.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    expect(buttons[0].textContent).toMatch(/text preview/i);
    expect(buttons[1]).toHaveAttribute("aria-pressed", "false");
    expect(buttons[1].textContent).toMatch(/view original/i);

    // The header still exposes the Download current document action.
    expect(
      screen.getByRole("button", { name: /download current document/i }),
    ).toBeInTheDocument();
  });

  it("switches to the original document text viewer when 'View original' is clicked", async () => {
    setupFetch(fetchMock);
    renderPage();
    await screen.findByRole("heading", {
      level: 1,
      name: "Workspace markdown",
    });

    const viewOriginal = screen
      .getByRole("group", { name: /document view/i })
      .querySelectorAll("button")[1];
    fireEvent.click(viewOriginal);

    expect(
      screen.getByRole("heading", { name: /original document text/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Some plain text body.")).toBeInTheDocument();
  });

  it("renders the document lifecycle strip with each slot's user-facing label", async () => {
    setupFetch(fetchMock);
    renderPage();
    const strip = await screen.findByTestId("document-lifecycle-strip");
    expect(strip).toHaveTextContent(/document lifecycle/i);
    // User-facing labels — never the raw artifact_type names.
    expect(strip).toHaveTextContent(/source file/i);
    expect(strip).toHaveTextContent(/generated word document/i);
    expect(strip).toHaveTextContent(/signed pdf/i);
    expect(strip).toHaveTextContent(/text preview/i);

    // Strip itself must not surface the on-disk artifact_type enum
    // values (those belong to dev/debug surfaces only).
    expect(strip.textContent ?? "").not.toMatch(/original_upload/);
    expect(strip.textContent ?? "").not.toMatch(/generated_docx/);
    expect(strip.textContent ?? "").not.toMatch(/signed_pdf/);

    // Original upload slot is "present"; generated/signed are "missing".
    expect(
      screen.getByTestId("lifecycle-slot-original_upload"),
    ).toHaveAttribute("data-state", "present");
    expect(
      screen.getByTestId("lifecycle-slot-generated_docx"),
    ).toHaveAttribute("data-state", "missing");
    expect(
      screen.getByTestId("lifecycle-slot-signed_pdf"),
    ).toHaveAttribute("data-state", "missing");
  });

  it("shows 'Current document: Source file' when only an original upload exists", async () => {
    setupFetch(fetchMock);
    renderPage();
    const label = await screen.findByTestId("repository-current-document");
    expect(label).toHaveTextContent(/current document/i);
    expect(label).toHaveTextContent(/source file/i);
  });

  it("falls back to a legacy-original notice when the artifacts list is empty", async () => {
    setupFetch(fetchMock, { artifacts: [] });
    renderPage();
    const legacy = await screen.findByTestId(
      "repository-current-document-legacy",
    );
    expect(legacy).toHaveTextContent(/legacy original/i);
    expect(
      screen.queryByTestId("repository-current-document"),
    ).not.toBeInTheDocument();
    // Download current document action stays available either way.
    expect(
      screen.getByRole("button", { name: /download current document/i }),
    ).toBeInTheDocument();
  });

  it("prefers signed_pdf over generated_docx and original_upload in the current document label", async () => {
    const SIGNED = {
      ...ARTIFACT,
      id: "55555555-5555-4555-8555-555555555555",
      artifact_type: "signed_pdf",
      filename: "executed-msa.signed.pdf",
      mime_type: "application/pdf",
      source: "docuseal",
    };
    const GENERATED = {
      ...ARTIFACT,
      id: "66666666-6666-4666-8666-666666666666",
      artifact_type: "generated_docx",
      filename: "draft.docx",
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      source: "template_generation",
    };
    setupFetch(fetchMock, { artifacts: [SIGNED, GENERATED, ARTIFACT] });
    renderPage();
    const label = await screen.findByTestId("repository-current-document");
    expect(label).toHaveTextContent(/signed pdf/i);
    expect(label).not.toHaveTextContent(/generated word document/i);
    expect(label).not.toHaveTextContent(/source file/i);
    // Lifecycle strip shows all three as present.
    expect(
      screen.getByTestId("lifecycle-slot-signed_pdf"),
    ).toHaveAttribute("data-state", "present");
    expect(
      screen.getByTestId("lifecycle-slot-generated_docx"),
    ).toHaveAttribute("data-state", "present");
    expect(
      screen.getByTestId("lifecycle-slot-original_upload"),
    ).toHaveAttribute("data-state", "present");
  });

  it("prefers generated_docx over original_upload when no signed PDF is present", async () => {
    const GENERATED = {
      ...ARTIFACT,
      id: "66666666-6666-4666-8666-666666666666",
      artifact_type: "generated_docx",
      filename: "draft.docx",
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      source: "template_generation",
    };
    setupFetch(fetchMock, { artifacts: [GENERATED, ARTIFACT] });
    renderPage();
    const label = await screen.findByTestId("repository-current-document");
    expect(label).toHaveTextContent(/generated word document/i);
    expect(label).not.toHaveTextContent(/signed pdf/i);
  });

  it("hides the lifecycle strip when the artifacts API fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse(SNAPSHOT);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        return jsonResponse({ detail: "boom" }, 500);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
        return jsonResponse(METADATA_VIEW);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
        return jsonResponse(CONTRACT_DETAIL);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/approval-gate`)) {
        return jsonResponse({
          allowed: true,
          code: "no_linked_request",
          request_id: null,
          blocking_workflow_ids: [],
          completed_workflow_ids: [],
          active_count: 0,
          rejected_count: 0,
          cancelled_count: 0,
          completed_count: 0,
        });
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    await screen.findByRole("heading", {
      level: 1,
      name: "Workspace markdown",
    });
    expect(
      screen.queryByTestId("document-lifecycle-strip"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("repository-current-document"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download current document/i }),
    ).toBeInTheDocument();
  });

  it("shows the empty state when the contract has no markdown snapshot", async () => {
    setupFetch(fetchMock, { snapshot: null });
    renderPage();
    await waitFor(() => {
      expect(
        screen.getByTestId("markdown-empty-state"),
      ).toBeInTheDocument();
    });
    // The toggle still renders so the user can switch to the original.
    expect(
      screen.getByRole("group", { name: /document view/i }),
    ).toBeInTheDocument();
  });

  it("shows a blocked gate warning and requires override reason", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) return jsonResponse(SNAPSHOT);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) return jsonResponse([ARTIFACT]);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) return jsonResponse(METADATA_VIEW);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) return jsonResponse(CONTRACT_DETAIL);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/approval-gate`)) {
        return jsonResponse({ allowed: false, code: "active_approval_workflows", request_id: "r1", blocking_workflow_ids: ["w1"], completed_workflow_ids: [], active_count: 1, rejected_count: 0, cancelled_count: 0, completed_count: 0 });
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/send-to-docuseal`) && init?.method === "POST") {
        return jsonResponse({ detail: "Contract cannot be sent to DocuSeal until approvals are completed." }, 409);
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    await screen.findByTestId("docuseal-gate-blocked");
    fireEvent.change(screen.getByTestId("docuseal-signer-email-0"), { target: { value: "signer@example.com" } });
    fireEvent.change(screen.getByTestId("docuseal-signer-name-0"), { target: { value: "Signer One" } });
    expect(screen.getByTestId("docuseal-send-submit")).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByTestId("docuseal-send-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("docuseal-override-reason"), { target: { value: "Urgent close" } });
    expect(screen.getByTestId("docuseal-send-submit")).not.toBeDisabled();
  });


  it("renders required approval policy unmet copy with missing policy NAMES (PR #59)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) return jsonResponse(SNAPSHOT);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) return jsonResponse([ARTIFACT]);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) return jsonResponse(METADATA_VIEW);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) return jsonResponse(CONTRACT_DETAIL);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/approval-gate`)) {
        return jsonResponse({
          allowed: false,
          code: "required_approval_policy_unmet",
          request_id: "r1",
          blocking_workflow_ids: [],
          completed_workflow_ids: [],
          active_count: 0,
          rejected_count: 0,
          cancelled_count: 0,
          completed_count: 0,
          required_policy_ids: ["apol-1", "apol-2"],
          missing_policy_ids: ["apol-1", "apol-2"],
          required_policies: [
            {
              id: "apol-1",
              name: "Standard Legal Review",
              workflow_template_id: "tpl-1",
              auto_attach: true,
              applies_to_generated_contracts: true,
              request_type: null,
              contract_type: null,
              priority: null,
              agreement_template_id: null,
            },
            {
              id: "apol-2",
              name: "High Priority Executive Approval",
              workflow_template_id: "tpl-2",
              auto_attach: true,
              applies_to_generated_contracts: true,
              request_type: null,
              contract_type: null,
              priority: null,
              agreement_template_id: null,
            },
          ],
          missing_policies: [
            {
              id: "apol-1",
              name: "Standard Legal Review",
              workflow_template_id: "tpl-1",
              auto_attach: true,
              applies_to_generated_contracts: true,
              request_type: null,
              contract_type: null,
              priority: null,
              agreement_template_id: null,
            },
            {
              id: "apol-2",
              name: "High Priority Executive Approval",
              workflow_template_id: "tpl-2",
              auto_attach: true,
              applies_to_generated_contracts: true,
              request_type: null,
              contract_type: null,
              priority: null,
              agreement_template_id: null,
            },
          ],
        });
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    const blocked = await screen.findByTestId("docuseal-gate-blocked");
    expect(blocked).toHaveTextContent(
      "Required approval policies have not been satisfied:",
    );
    const list = await screen.findByTestId("docuseal-gate-missing-policies");
    expect(list).toHaveTextContent("Standard Legal Review");
    expect(list).toHaveTextContent("High Priority Executive Approval");
    // The opaque ids are no longer surfaced when names are present.
    expect(list).not.toHaveTextContent("apol-1");
    expect(list).not.toHaveTextContent("apol-2");
  });

  it("falls back to missing policy IDs when the gate response has no named summaries", async () => {
    // Simulates an older backend (or mock) that has not yet been
    // upgraded to PR #59 — the UI must still render *something* useful
    // instead of dropping the missing-policy context on the floor.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) return jsonResponse(SNAPSHOT);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) return jsonResponse([ARTIFACT]);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) return jsonResponse(METADATA_VIEW);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) return jsonResponse(CONTRACT_DETAIL);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/approval-gate`)) {
        return jsonResponse({
          allowed: false,
          code: "required_approval_policy_unmet",
          request_id: "r1",
          blocking_workflow_ids: [],
          completed_workflow_ids: [],
          active_count: 0,
          rejected_count: 0,
          cancelled_count: 0,
          completed_count: 0,
          missing_policy_ids: ["apol-legacy-1", "apol-legacy-2"],
        });
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    const list = await screen.findByTestId("docuseal-gate-missing-policies");
    expect(list).toHaveTextContent("apol-legacy-1");
    expect(list).toHaveTextContent("apol-legacy-2");
  });

  it("override UI is preserved on required_approval_policy_unmet (PR #59 is response polish)", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) return jsonResponse(SNAPSHOT);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) return jsonResponse([ARTIFACT]);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) return jsonResponse(METADATA_VIEW);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) return jsonResponse(CONTRACT_DETAIL);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/approval-gate`)) {
        return jsonResponse({
          allowed: false,
          code: "required_approval_policy_unmet",
          request_id: "r1",
          blocking_workflow_ids: [],
          completed_workflow_ids: [],
          active_count: 0,
          rejected_count: 0,
          cancelled_count: 0,
          completed_count: 0,
          required_policy_ids: ["apol-1"],
          missing_policy_ids: ["apol-1"],
          required_policies: [
            {
              id: "apol-1",
              name: "Standard Legal Review",
              workflow_template_id: "tpl-1",
              auto_attach: true,
              applies_to_generated_contracts: true,
              request_type: null,
              contract_type: null,
              priority: null,
              agreement_template_id: null,
            },
          ],
          missing_policies: [
            {
              id: "apol-1",
              name: "Standard Legal Review",
              workflow_template_id: "tpl-1",
              auto_attach: true,
              applies_to_generated_contracts: true,
              request_type: null,
              contract_type: null,
              priority: null,
              agreement_template_id: null,
            },
          ],
        });
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/send-to-docuseal`) && init?.method === "POST") {
        return jsonResponse({ detail: "approval_required" }, 409);
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    await screen.findByTestId("docuseal-gate-blocked");
    fireEvent.change(screen.getByTestId("docuseal-signer-email-0"), { target: { value: "signer@example.com" } });
    fireEvent.change(screen.getByTestId("docuseal-signer-name-0"), { target: { value: "Signer One" } });
    expect(screen.getByTestId("docuseal-send-submit")).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByTestId("docuseal-send-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("docuseal-override-reason"), { target: { value: "CFO unreachable; closing today" } });
    expect(screen.getByTestId("docuseal-send-submit")).not.toBeDisabled();
  });

  it("renders the gate remediation block alongside the blocked panel", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) return jsonResponse(SNAPSHOT);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) return jsonResponse([ARTIFACT]);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) return jsonResponse(METADATA_VIEW);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) return jsonResponse(CONTRACT_DETAIL);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/approval-gate`)) {
        return jsonResponse({
          allowed: false,
          code: "active_approval_workflows",
          request_id: "req-blocked",
          blocking_workflow_ids: ["wf-blocked"],
          completed_workflow_ids: [],
          active_count: 1,
          rejected_count: 0,
          cancelled_count: 0,
          completed_count: 0,
        });
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    await screen.findByTestId("docuseal-gate-blocked");
    const remediation = screen.getByTestId("docuseal-gate-remediation");
    expect(remediation).toHaveTextContent(/how to unblock/i);
    expect(remediation).toHaveTextContent(
      /complete the active approval workflow before sending/i,
    );
    // PR #61: links now deep-link with the relevant id.
    expect(screen.getByTestId("remediation-request-link")).toHaveAttribute(
      "href",
      "/demo/requests?request_id=req-blocked",
    );
    expect(screen.getByTestId("remediation-workflow-link")).toHaveAttribute(
      "href",
      "/demo/approvals?workflow_id=wf-blocked",
    );
    expect(screen.getByTestId("remediation-blocking-workflows")).toHaveTextContent(
      "wf-blocked",
    );
  });

  it("does not render remediation links when the gate fetch fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) return jsonResponse(SNAPSHOT);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) return jsonResponse([ARTIFACT]);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) return jsonResponse(METADATA_VIEW);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) return jsonResponse(CONTRACT_DETAIL);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/approval-gate`)) return jsonResponse({ detail: "gate unavailable" }, 500);
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    await screen.findByTestId("docuseal-gate-error");
    expect(
      screen.queryByTestId("docuseal-gate-remediation"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("docuseal-gate-blocked"),
    ).not.toBeInTheDocument();
  });

  it("shows safe gate error state when approval-gate fetch fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) return jsonResponse(SNAPSHOT);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) return jsonResponse([ARTIFACT]);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) return jsonResponse(METADATA_VIEW);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) return jsonResponse(CONTRACT_DETAIL);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/approval-gate`)) return jsonResponse({ detail: "gate unavailable" }, 500);
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    const err = await screen.findByTestId("docuseal-gate-error");
    expect(err).toHaveTextContent(/gate unavailable|unexpected/i);
    expect(screen.getByTestId("docuseal-send-submit")).toBeDisabled();
  });

});

describe("ContractWorkspacePage Repository detail polish (PR #68)", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(VALID_UUID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("renders the Repository detail header with Repository terminology", async () => {
    setupFetch(fetchMock);
    renderPage();
    const header = await screen.findByTestId("repository-detail-header");
    expect(header).toBeInTheDocument();
    // Back link uses Repository terminology rather than 'Contracts'.
    const back = screen.getByRole("link", { name: /back to repository/i });
    expect(back).toBeInTheDocument();
    expect(back).toHaveAttribute("href", "/demo/repository");
  });

  it("renders the Details section with safe metadata + the Edit details action", async () => {
    setupFetch(fetchMock, {
      metadata: {
        ...METADATA_VIEW,
        counterparty_name: "Globex",
        contract_type: "MSA",
        effective_date: "2026-05-01",
      },
    });
    renderPage();
    const details = await screen.findByTestId("contract-details-section");
    expect(details).toHaveTextContent(/Counterparty/i);
    expect(details).toHaveTextContent(/Globex/);
    expect(details).toHaveTextContent(/Contract type/i);
    expect(details).toHaveTextContent(/MSA/);
    expect(details).toHaveTextContent(/Effective date/i);
    expect(details).toHaveTextContent("2026-05-01");
    // Source uses friendly origin copy derived from the artifact.
    expect(details).toHaveTextContent(/Uploaded directly/);
    expect(
      screen.getByTestId("contract-details-edit"),
    ).toBeInTheDocument();
  });

  it("opens the Edit details panel and reuses the upload-review form", async () => {
    setupFetch(fetchMock);
    renderPage();
    const editBtn = await screen.findByTestId("contract-details-edit");
    fireEvent.click(editBtn);
    expect(
      await screen.findByTestId("contract-details-edit-panel"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("upload-review-title")).toBeInTheDocument();
  });

  it("renders the Files section using user-friendly artifact labels (no raw artifact_type names)", async () => {
    const SIGNED = {
      ...ARTIFACT,
      id: "55555555-5555-4555-8555-555555555555",
      artifact_type: "signed_pdf",
      filename: "executed.pdf",
      mime_type: "application/pdf",
      source: "docuseal",
      metadata_json: { docuseal_submission_id: "sub-1" },
    };
    setupFetch(fetchMock, { artifacts: [SIGNED, ARTIFACT] });
    renderPage();
    const files = await screen.findByTestId("contract-files-section");
    expect(files).toHaveTextContent(/Source file/i);
    expect(files).toHaveTextContent(/Signed PDF/i);
    // Raw internal type names must not leak to the user-facing list.
    expect(files.textContent ?? "").not.toMatch(/original_upload/);
    expect(files.textContent ?? "").not.toMatch(/signed_pdf/);
    // Filenames + origin copy are visible.
    expect(files).toHaveTextContent("vendor-msa.pdf");
    expect(files).toHaveTextContent("executed.pdf");
    expect(files).toHaveTextContent(/Signed through DocuSeal/i);
    expect(files).toHaveTextContent(/Uploaded directly/i);
  });

  it("never leaks storage_key, wrapped_dek, or signer PII into the Files list", async () => {
    // The backend strips these at the schema layer and the api client
    // re-scrubs them, but we belt-and-suspenders here: even if a
    // malformed payload carried them, the UI must not surface them.
    const NAUGHTY = {
      ...ARTIFACT,
      // These shouldn't be on the wire — assert the UI doesn't render
      // them even if they sneak through.
      storage_key: "s3://internal/whoops",
      wrapped_dek: "00".repeat(32),
      metadata_json: {
        docuseal_submission_id: "sub-1",
        signer_email: "secret@example.com",
      },
    };
    setupFetch(fetchMock, { artifacts: [NAUGHTY] });
    renderPage();
    await screen.findByTestId("contract-files-section");
    const html = document.body.innerHTML;
    expect(html).not.toContain("storage_key");
    expect(html).not.toContain("wrapped_dek");
    expect(html).not.toContain("s3://internal");
    expect(html).not.toContain("secret@example.com");
  });

  it("renders the existing activity timeline section", async () => {
    setupFetch(fetchMock);
    renderPage();
    expect(
      await screen.findByTestId("contract-activity-section"),
    ).toBeInTheDocument();
  });

  it("still renders the Send to DocuSeal panel", async () => {
    setupFetch(fetchMock);
    renderPage();
    expect(
      await screen.findByTestId("send-to-docuseal"),
    ).toBeInTheDocument();
  });

  it("works on the /repository/:id route alias", async () => {
    setupFetch(fetchMock);
    renderPage(`/repository/${CONTRACT_ID}`);
    expect(
      await screen.findByTestId("repository-detail-header"),
    ).toBeInTheDocument();
  });
});

describe("ContractWorkspacePage Document history (PR #69)", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(VALID_UUID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  const SOURCE_ARTIFACT = {
    ...ARTIFACT,
    id: "44444444-4444-4444-8444-444444444444",
    artifact_type: "original_upload",
    filename: "source.pdf",
    source: "user_upload",
    created_at: "2026-05-01T00:00:00Z",
  };
  const GENERATED_ARTIFACT = {
    ...ARTIFACT,
    id: "66666666-6666-4666-8666-666666666666",
    artifact_type: "generated_docx",
    filename: "draft.docx",
    mime_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    source: "template_generation",
    created_at: "2026-05-02T00:00:00Z",
    metadata_json: { template_id: "tpl-1", template_name: "Mutual NDA" },
  };
  const SIGNED_ARTIFACT = {
    ...ARTIFACT,
    id: "55555555-5555-4555-8555-555555555555",
    artifact_type: "signed_pdf",
    filename: "executed.pdf",
    mime_type: "application/pdf",
    source: "docuseal",
    created_at: "2026-05-03T00:00:00Z",
    metadata_json: {
      docuseal_submission_id: "sub-OPAQUE-LONG-ID",
      signed_at: "2026-05-03T00:00:00Z",
    },
  };

  it("renders the Document history section heading + chronological rows", async () => {
    setupFetch(fetchMock, {
      artifacts: [SIGNED_ARTIFACT, GENERATED_ARTIFACT, SOURCE_ARTIFACT],
    });
    renderPage();
    const section = await screen.findByTestId("contract-files-section");
    expect(section).toHaveTextContent(/document history/i);
    const list = await screen.findByTestId("document-history-list");
    const rows = list.querySelectorAll('[data-testid="contract-files-row"]');
    expect(rows).toHaveLength(3);
    // Newest first: signed -> generated -> original.
    expect(rows[0].getAttribute("data-artifact-id")).toBe(SIGNED_ARTIFACT.id);
    expect(rows[1].getAttribute("data-artifact-id")).toBe(GENERATED_ARTIFACT.id);
    expect(rows[2].getAttribute("data-artifact-id")).toBe(SOURCE_ARTIFACT.id);
  });

  it("marks signed PDF as the current document over generated and source", async () => {
    setupFetch(fetchMock, {
      artifacts: [SIGNED_ARTIFACT, GENERATED_ARTIFACT, SOURCE_ARTIFACT],
    });
    renderPage();
    const list = await screen.findByTestId("document-history-list");
    const badges = list.querySelectorAll(
      '[data-testid="document-history-current-badge"]',
    );
    expect(badges).toHaveLength(1);
    const currentRow = list.querySelector(
      `[data-artifact-id="${SIGNED_ARTIFACT.id}"]`,
    );
    expect(currentRow?.getAttribute("data-current")).toBe("true");
    expect(currentRow).toContainElement(badges[0] as HTMLElement);
  });

  it("marks the generated Word document as current when no signed PDF exists", async () => {
    setupFetch(fetchMock, {
      artifacts: [GENERATED_ARTIFACT, SOURCE_ARTIFACT],
    });
    renderPage();
    const list = await screen.findByTestId("document-history-list");
    const badge = list.querySelector(
      '[data-testid="document-history-current-badge"]',
    );
    expect(badge).not.toBeNull();
    const currentRow = list.querySelector(
      `[data-artifact-id="${GENERATED_ARTIFACT.id}"]`,
    );
    expect(currentRow?.getAttribute("data-current")).toBe("true");
  });

  it("marks the source file as current when only original_upload exists", async () => {
    setupFetch(fetchMock, { artifacts: [SOURCE_ARTIFACT] });
    renderPage();
    const list = await screen.findByTestId("document-history-list");
    const currentRow = list.querySelector(
      `[data-artifact-id="${SOURCE_ARTIFACT.id}"]`,
    );
    expect(currentRow?.getAttribute("data-current")).toBe("true");
  });

  it("renders the legacy fallback row when the contract has no artifacts", async () => {
    setupFetch(fetchMock, { artifacts: [] });
    renderPage();
    const legacy = await screen.findByTestId(
      "document-history-legacy-row",
    );
    expect(legacy).toHaveTextContent(/legacy source file/i);
    expect(legacy).toHaveTextContent(/stored before artifact tracking/i);
    expect(
      screen.getByTestId("document-history-current-badge"),
    ).toBeInTheDocument();
  });

  it("renders an Official badge on official artifacts", async () => {
    setupFetch(fetchMock, { artifacts: [SOURCE_ARTIFACT] });
    renderPage();
    const list = await screen.findByTestId("document-history-list");
    expect(
      list.querySelector('[data-testid="document-history-official-badge"]'),
    ).not.toBeNull();
  });

  it("renders user-friendly source chips for each artifact origin", async () => {
    const REQUEST_UPLOAD = {
      ...ARTIFACT,
      id: "77777777-7777-4777-8777-777777777777",
      artifact_type: "original_upload",
      source: "request_upload",
      filename: "counterparty.pdf",
      created_at: "2026-04-30T00:00:00Z",
      metadata_json: {
        request_id: "req-1",
        upload_source: "request_conversion",
      },
    };
    setupFetch(fetchMock, {
      artifacts: [SIGNED_ARTIFACT, GENERATED_ARTIFACT, REQUEST_UPLOAD],
    });
    renderPage();
    const section = await screen.findByTestId("contract-files-section");
    // Source chip text (artifactSourceChip):
    expect(section).toHaveTextContent(/From DocuSeal/i);
    expect(section).toHaveTextContent(/From template/i);
    expect(section).toHaveTextContent(/From request/i);
    // Origin copy sentences (artifactOriginCopy):
    expect(section).toHaveTextContent(/Signed through DocuSeal/i);
    expect(section).toHaveTextContent(/Generated from template/i);
    expect(section).toHaveTextContent(/Converted from request upload/i);
  });

  it("renders allowlisted metadata chips and never the raw metadata_json", async () => {
    setupFetch(fetchMock, {
      artifacts: [SIGNED_ARTIFACT, GENERATED_ARTIFACT],
    });
    renderPage();
    const section = await screen.findByTestId("contract-files-section");
    // Allowlisted chips render.
    expect(
      screen.getByTestId("document-history-meta-template_name"),
    ).toHaveTextContent(/Mutual NDA/);
    expect(
      screen.getByTestId("document-history-meta-docuseal_submission_id"),
    ).toBeInTheDocument();
    // The raw submission id is opaque and is never surfaced.
    expect(section.textContent ?? "").not.toContain("sub-OPAQUE-LONG-ID");
    // template_id (raw uuid) is never rendered.
    expect(section.textContent ?? "").not.toContain("tpl-1");
  });

  it("never surfaces storage_key / wrapped_dek / raw metadata_json keys in the DOM", async () => {
    const NAUGHTY = {
      ...SIGNED_ARTIFACT,
      storage_key: "s3://internal/whoops",
      wrapped_dek: "00".repeat(32),
      metadata_json: {
        docuseal_submission_id: "sub-1",
        signer_email: "secret@example.com",
        notes: "internal commentary",
      },
    };
    setupFetch(fetchMock, { artifacts: [NAUGHTY] });
    renderPage();
    await screen.findByTestId("contract-files-section");
    const html = document.body.innerHTML;
    expect(html).not.toContain("storage_key");
    expect(html).not.toContain("wrapped_dek");
    expect(html).not.toContain("s3://internal");
    expect(html).not.toContain("secret@example.com");
    expect(html).not.toContain("internal commentary");
  });

  it("still renders the existing lifecycle strip and preview alongside history", async () => {
    setupFetch(fetchMock, {
      artifacts: [SIGNED_ARTIFACT, GENERATED_ARTIFACT, SOURCE_ARTIFACT],
    });
    renderPage();
    await screen.findByTestId("document-lifecycle-strip");
    expect(
      screen.getByTestId("contract-preview-section"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("contract-files-section"),
    ).toBeInTheDocument();
  });

  it("renders the document history section on both /contracts/:id and /repository/:id routes", async () => {
    setupFetch(fetchMock, { artifacts: [SOURCE_ARTIFACT] });
    renderPage(`/repository/${CONTRACT_ID}`);
    expect(
      await screen.findByTestId("contract-files-section"),
    ).toHaveTextContent(/document history/i);
  });
});

describe("ContractWorkspacePage per-artifact download (PR #70)", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(VALID_UUID);
    // jsdom does not implement URL.createObjectURL; stub it so the
    // download path can build an anchor href and revoke it.
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:demo"),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  const SOURCE_ARTIFACT = {
    ...ARTIFACT,
    id: "44444444-4444-4444-8444-444444444444",
    artifact_type: "original_upload",
    filename: "source.pdf",
    source: "user_upload",
    created_at: "2026-05-01T00:00:00Z",
  };
  const SIGNED_ARTIFACT = {
    ...ARTIFACT,
    id: "55555555-5555-4555-8555-555555555555",
    artifact_type: "signed_pdf",
    filename: "executed.pdf",
    mime_type: "application/pdf",
    source: "docuseal",
    created_at: "2026-05-03T00:00:00Z",
  };

  function withArtifactDownload(
    artifacts: object[],
    artifactResponder: (artifactId: string) => Response,
  ): void {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse(SNAPSHOT);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        return jsonResponse(artifacts);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
        return jsonResponse(METADATA_VIEW);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
        return jsonResponse(CONTRACT_DETAIL);
      }
      const m =
        /\/api\/contracts\/[^/]+\/artifacts\/([^/]+)\/download$/.exec(url);
      if (m) {
        return artifactResponder(m[1]);
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
  }

  function withArtifactPreview(
    artifacts: object[],
    previewResponder: (artifactId: string) => Response,
  ): void {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse(SNAPSHOT);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        return jsonResponse(artifacts);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
        return jsonResponse(METADATA_VIEW);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
        return jsonResponse(CONTRACT_DETAIL);
      }
      const m = /\/api\/contracts\/[^/]+\/artifacts\/([^/]+)\/preview$/.exec(url);
      if (m) return previewResponder(m[1]);
      return jsonResponse({ detail: "unexpected" }, 500);
    });
  }

  it("renders a Download version button on every history row", async () => {
    setupFetch(fetchMock, {
      artifacts: [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
    });
    renderPage();
    const list = await screen.findByTestId("document-history-list");
    const buttons = list.querySelectorAll(
      '[data-testid="document-history-row-download"]',
    );
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect((button as HTMLElement).textContent ?? "").toMatch(
        /download version/i,
      );
    }
  });

  it("does not say 'Download artifact' anywhere in the history UI", async () => {
    setupFetch(fetchMock, {
      artifacts: [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
    });
    renderPage();
    const section = await screen.findByTestId("contract-files-section");
    expect(section.textContent ?? "").not.toMatch(/download artifact/i);
  });

  it("clicking Download version calls the per-artifact endpoint with contractId + artifactId", async () => {
    const seen: string[] = [];
    withArtifactDownload([SOURCE_ARTIFACT], (artifactId) => {
      seen.push(artifactId);
      return new Response(
        new Blob(["%PDF-"], { type: "application/pdf" }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="source.pdf"',
          },
        },
      );
    });
    renderPage();
    const button = (await screen.findAllByTestId(
      "document-history-row-download",
    ))[0];
    fireEvent.click(button);
    await waitFor(() => {
      expect(seen).toEqual([SOURCE_ARTIFACT.id]);
    });
    // The matching URL went to the per-artifact endpoint, not the
    // contract-level one.
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(
      calledUrls.some((u) =>
        u.endsWith(
          `/api/contracts/${CONTRACT_ID}/artifacts/${SOURCE_ARTIFACT.id}/download`,
        ),
      ),
    ).toBe(true);
  });

  it("header still exposes the Download current document action", async () => {
    setupFetch(fetchMock, {
      artifacts: [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
    });
    renderPage();
    expect(
      await screen.findByRole("button", {
        name: /download current document/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows Preview for PDF and DOCX artifacts and unavailable copy for unsupported types", async () => {
    setupFetch(fetchMock, {
      artifacts: [SIGNED_ARTIFACT, { ...SOURCE_ARTIFACT, mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", artifact_type: "generated_docx" }, { ...SOURCE_ARTIFACT, id: "unsupported-1", mime_type: "text/plain" }],
    });
    renderPage();
    const section = await screen.findByTestId("contract-files-section");
    const previewButtons = await screen.findAllByTestId("document-history-row-preview");
    expect(previewButtons).toHaveLength(2);
    expect(section).toHaveTextContent("Preview unavailable for this file type");
  });

  it("clicking Preview opens and closing/unmounting revokes object URLs", async () => {
    const createSpy = vi.spyOn(URL, "createObjectURL");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    withArtifactPreview([SIGNED_ARTIFACT], () =>
      new Response(new Blob(["%PDF"], { type: "application/pdf" }), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="executed.pdf"',
        },
      }),
    );
    const { unmount } = renderPage();
    fireEvent.click(await screen.findByTestId("document-history-row-preview"));
    await screen.findByTestId("pdf-preview-modal");
    expect(createSpy).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => expect(revokeSpy.mock.calls.length).toBeGreaterThanOrEqual(1));
    fireEvent.click(await screen.findByTestId("document-history-row-preview"));
    await screen.findByTestId("pdf-preview-modal");
    unmount();
    expect(revokeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a safe inline error when the artifact download fails", async () => {
    withArtifactDownload(
      [SOURCE_ARTIFACT],
      () =>
        new Response(JSON.stringify({ detail: "Artifact not found." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    renderPage();
    const button = (await screen.findAllByTestId(
      "document-history-row-download",
    ))[0];
    fireEvent.click(button);
    const errorNode = await screen.findByTestId(
      "document-history-row-download-error",
    );
    expect(errorNode.textContent ?? "").toMatch(/not found/i);
    // The user-facing error never leaks storage internals.
    expect(errorNode.textContent ?? "").not.toMatch(/storage_key/);
    expect(errorNode.textContent ?? "").not.toMatch(/wrapped_dek/);
  });

  it("never surfaces storage_key or wrapped_dek into the DOM after a download attempt", async () => {
    withArtifactDownload(
      [SOURCE_ARTIFACT],
      () =>
        new Response(
          new Blob(["%PDF-"], { type: "application/pdf" }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": 'attachment; filename="source.pdf"',
            },
          },
        ),
    );
    renderPage();
    const button = (await screen.findAllByTestId(
      "document-history-row-download",
    ))[0];
    fireEvent.click(button);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const html = document.body.innerHTML;
    expect(html).not.toContain("storage_key");
    expect(html).not.toContain("wrapped_dek");
  });

  it("uses the existing user-friendly row labels (no raw artifact_type)", async () => {
    setupFetch(fetchMock, {
      artifacts: [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
    });
    renderPage();
    const section = await screen.findByTestId("contract-files-section");
    expect(section.textContent ?? "").not.toMatch(/original_upload/);
    expect(section.textContent ?? "").not.toMatch(/signed_pdf/);
    // The user-friendly labels are still there from PR #69.
    expect(section).toHaveTextContent(/source file/i);
    expect(section).toHaveTextContent(/signed pdf/i);
  });
});

describe("ContractWorkspacePage Send to DocuSeal", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(VALID_UUID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  function setupGenerated(fetchImpl: Mock) {
    const generatedArtifact = {
      ...ARTIFACT,
      artifact_type: "generated_docx",
      filename: "acme-nda.docx",
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      source: "template_generation",
    };
    fetchImpl.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse(SNAPSHOT);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        return jsonResponse([generatedArtifact]);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
        return jsonResponse(METADATA_VIEW);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
        return jsonResponse(CONTRACT_DETAIL);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/approval-gate`)) {
        return jsonResponse({
          allowed: true,
          code: "no_linked_request",
          request_id: null,
          blocking_workflow_ids: [],
          completed_workflow_ids: [],
          active_count: 0,
          rejected_count: 0,
          cancelled_count: 0,
          completed_count: 0,
        });
      }
      if (
        url.endsWith(`/api/contracts/${CONTRACT_ID}/send-to-docuseal`) &&
        init?.method === "POST"
      ) {
        return jsonResponse(
          {
            contract_id: CONTRACT_ID,
            artifact_id: generatedArtifact.id,
            artifact_type: "generated_docx",
            filename: "acme-nda.docx",
            submission_id: "demo-sub-1",
            status: "sent_for_signature",
            embed_url: "https://docuseal.example/sign/abc",
            signer_count: 1,
            raw: { id: "demo-sub-1" },
          },
          201,
        );
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
  }

  it("renders the Send to DocuSeal action and signer form for a generated contract", async () => {
    setupGenerated(fetchMock);
    renderPage();
    await screen.findByRole("heading", {
      level: 1,
      name: "Workspace markdown",
    });
    const panel = screen.getByTestId("send-to-docuseal");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent(/send to docuseal/i);
    expect(screen.getByTestId("docuseal-signer-row")).toBeInTheDocument();
    expect(
      screen.getByTestId("docuseal-signer-email-0"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("docuseal-signer-name-0"),
    ).toBeInTheDocument();
    // Submit is disabled with empty signer fields.
    const submit = screen.getByTestId("docuseal-send-submit");
    expect(submit).toBeDisabled();
  });

  it("shows a success state with the DocuSeal submission id after sending", async () => {
    setupGenerated(fetchMock);
    renderPage();
    await screen.findByTestId("send-to-docuseal");
    fireEvent.change(screen.getByTestId("docuseal-signer-email-0"), {
      target: { value: "signer@example.com" },
    });
    fireEvent.change(screen.getByTestId("docuseal-signer-name-0"), {
      target: { value: "Signer One" },
    });
    fireEvent.click(screen.getByTestId("docuseal-send-submit"));
    const success = await screen.findByTestId("docuseal-send-success");
    expect(success).toHaveTextContent(/sent 1 signer/i);
    expect(success).toHaveTextContent(/demo-sub-1/);
    expect(success).toHaveTextContent(/acme-nda\.docx/);
    expect(
      screen.getByTestId("docuseal-embed-link"),
    ).toHaveAttribute("href", "https://docuseal.example/sign/abc");
  });

  it("renders backend error inline and does not enter the success state", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse(SNAPSHOT);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        return jsonResponse([ARTIFACT]);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
        return jsonResponse(METADATA_VIEW);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
        return jsonResponse(CONTRACT_DETAIL);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/approval-gate`)) {
        return jsonResponse({
          allowed: true,
          code: "no_linked_request",
          request_id: null,
          blocking_workflow_ids: [],
          completed_workflow_ids: [],
          active_count: 0,
          rejected_count: 0,
          cancelled_count: 0,
          completed_count: 0,
        });
      }
      if (
        url.endsWith(`/api/contracts/${CONTRACT_ID}/send-to-docuseal`) &&
        init?.method === "POST"
      ) {
        return jsonResponse({ detail: "DocuSeal exploded" }, 502);
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    await screen.findByTestId("send-to-docuseal");
    fireEvent.change(screen.getByTestId("docuseal-signer-email-0"), {
      target: { value: "signer@example.com" },
    });
    fireEvent.change(screen.getByTestId("docuseal-signer-name-0"), {
      target: { value: "Signer One" },
    });
    fireEvent.click(screen.getByTestId("docuseal-send-submit"));
    const err = await screen.findByTestId("docuseal-send-error");
    expect(err).toHaveTextContent(/docuseal/i);
    expect(
      screen.queryByTestId("docuseal-send-success"),
    ).not.toBeInTheDocument();
  });

  it("never surfaces storage_key or wrapped_dek strings in the DOM", async () => {
    setupGenerated(fetchMock);
    renderPage();
    await screen.findByTestId("send-to-docuseal");
    fireEvent.change(screen.getByTestId("docuseal-signer-email-0"), {
      target: { value: "signer@example.com" },
    });
    fireEvent.change(screen.getByTestId("docuseal-signer-name-0"), {
      target: { value: "Signer One" },
    });
    fireEvent.click(screen.getByTestId("docuseal-send-submit"));
    await screen.findByTestId("docuseal-send-success");
    const html = document.body.innerHTML;
    expect(html).not.toContain("storage_key");
    expect(html).not.toContain("wrapped_dek");
    expect(html).not.toContain("wrapped_master_key");
  });
});

describe("ContractWorkspacePage compare versions (PR #71)", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(VALID_UUID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  const SOURCE_ARTIFACT = {
    ...ARTIFACT,
    id: "44444444-4444-4444-8444-444444444444",
    artifact_type: "original_upload",
    filename: "source.pdf",
    source: "user_upload",
    created_at: "2026-05-01T00:00:00Z",
  };
  const SIGNED_ARTIFACT = {
    ...ARTIFACT,
    id: "55555555-5555-4555-8555-555555555555",
    artifact_type: "signed_pdf",
    filename: "executed.pdf",
    mime_type: "application/pdf",
    source: "docuseal",
    created_at: "2026-05-03T00:00:00Z",
  };

  const HAPPY_COMPARE_BODY = {
    base: {
      artifact_id: SOURCE_ARTIFACT.id,
      artifact_type: "original_upload",
      label: "Source file",
      filename: "source.pdf",
      created_at: "2026-05-01T00:00:00Z",
    },
    compare: {
      artifact_id: SIGNED_ARTIFACT.id,
      artifact_type: "signed_pdf",
      label: "Signed PDF",
      filename: "executed.pdf",
      created_at: "2026-05-03T00:00:00Z",
    },
    summary: {
      added_lines: 3,
      removed_lines: 2,
      changed_blocks: 1,
      unchanged_lines: 12,
    },
    diff_blocks: [
      {
        type: "context",
        base_line_start: 1,
        compare_line_start: 1,
        lines: [{ type: "context", text: "Section 1. Term." }],
      },
      {
        type: "changed",
        base_line_start: 2,
        compare_line_start: 2,
        lines: [
          { type: "removed", text: "Term: one (1) year." },
          { type: "added", text: "Term: two (2) years." },
        ],
      },
    ],
    warnings: [],
  };

  function withCompare(
    artifacts: object[],
    compareResponse: object,
    {
      compareStatus = 200,
    }: { compareStatus?: number } = {},
  ): void {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse(SNAPSHOT);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        return jsonResponse(artifacts);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
        return jsonResponse(METADATA_VIEW);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
        return jsonResponse(CONTRACT_DETAIL);
      }
      if (
        url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts/compare`) &&
        init?.method === "POST"
      ) {
        return jsonResponse(compareResponse, compareStatus);
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
  }

  it("renders the Compare versions panel with both dropdowns and a disabled Compare button by default", async () => {
    withCompare(
      [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
      HAPPY_COMPARE_BODY,
    );
    renderPage();
    const panel = await screen.findByTestId(
      "document-history-compare-panel",
    );
    expect(panel).toHaveTextContent(/text comparison/i);
    expect(panel).toHaveTextContent(/not an official word redline/i);
    expect(screen.getByTestId("compare-base-select")).toBeInTheDocument();
    expect(screen.getByTestId("compare-target-select")).toBeInTheDocument();
    const button = screen.getByTestId("compare-versions-button");
    expect(button).toBeDisabled();
  });

  it("does not render the compare panel when there is only one artifact (no second version to compare)", async () => {
    withCompare([SOURCE_ARTIFACT], HAPPY_COMPARE_BODY);
    renderPage();
    await screen.findByTestId("contract-files-section");
    expect(
      screen.queryByTestId("document-history-compare-panel"),
    ).not.toBeInTheDocument();
  });

  it("enables Compare once two distinct versions are selected and fires the API", async () => {
    withCompare(
      [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
      HAPPY_COMPARE_BODY,
    );
    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    const baseSelect = screen.getByTestId("compare-base-select") as HTMLSelectElement;
    const compareSelect = screen.getByTestId("compare-target-select") as HTMLSelectElement;
    const button = screen.getByTestId("compare-versions-button");

    // Picking the same artifact on both sides keeps the button
    // disabled — comparing a version to itself is a degenerate case.
    fireEvent.change(baseSelect, { target: { value: SOURCE_ARTIFACT.id } });
    fireEvent.change(compareSelect, { target: { value: SOURCE_ARTIFACT.id } });
    expect(button).toBeDisabled();

    fireEvent.change(compareSelect, { target: { value: SIGNED_ARTIFACT.id } });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    const result = await screen.findByTestId("compare-versions-result");
    expect(result).toHaveTextContent(/source file/i);
    expect(result).toHaveTextContent(/signed pdf/i);

    // The compare POST went to the per-artifact compare route with the
    // two ids the user selected.
    const compareCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith(`/api/contracts/${CONTRACT_ID}/artifacts/compare`),
    );
    expect(compareCall).toBeDefined();
    const body = JSON.parse(
      (compareCall![1] as RequestInit).body as string,
    );
    expect(body.base_artifact_id).toBe(SOURCE_ARTIFACT.id);
    expect(body.compare_artifact_id).toBe(SIGNED_ARTIFACT.id);
  });

  it("renders summary cards and a structured diff with added/removed lines", async () => {
    withCompare(
      [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
      HAPPY_COMPARE_BODY,
    );
    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    fireEvent.click(screen.getByTestId("compare-versions-button"));
    await screen.findByTestId("compare-versions-result");
    expect(screen.getByTestId("compare-summary-added")).toHaveTextContent("3");
    expect(screen.getByTestId("compare-summary-removed")).toHaveTextContent("2");
    expect(screen.getByTestId("compare-summary-changed")).toHaveTextContent("1");
    expect(screen.getByTestId("compare-summary-unchanged")).toHaveTextContent("12");
    // Diff rendered with one context block and one changed block.
    expect(screen.getByTestId("compare-block-context")).toBeInTheDocument();
    expect(screen.getByTestId("compare-block-changed")).toBeInTheDocument();
    // Added + removed lines render their text.
    const added = screen.getByText(/Term: two \(2\) years\./);
    const removed = screen.getByText(/Term: one \(1\) year\./);
    expect(added).toBeInTheDocument();
    expect(removed).toBeInTheDocument();
  });

  it("renders a user-friendly notice for diff-truncated warnings (never the raw tag)", async () => {
    withCompare([SIGNED_ARTIFACT, SOURCE_ARTIFACT], {
      ...HAPPY_COMPARE_BODY,
      warnings: ["diff_lines_truncated"],
    });
    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    fireEvent.click(screen.getByTestId("compare-versions-button"));
    const warnings = await screen.findByTestId("compare-versions-warnings");
    // User-facing copy, never the raw tag.
    expect(warnings).toHaveTextContent(/truncated/i);
    expect(warnings.textContent ?? "").not.toContain("diff_lines_truncated");
  });

  it("shows a safe inline error when the conversion fails (422)", async () => {
    withCompare(
      [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
      { detail: "The base version could not be converted to comparable text." },
      { compareStatus: 422 },
    );
    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    fireEvent.click(screen.getByTestId("compare-versions-button"));
    const error = await screen.findByTestId("compare-versions-error");
    expect(error.textContent ?? "").toMatch(
      /could not be converted to comparable text/i,
    );
    // No service-layer / converter internals.
    expect(error.textContent ?? "").not.toMatch(/markitdown/i);
    expect(error.textContent ?? "").not.toMatch(/storage_key/);
    expect(error.textContent ?? "").not.toMatch(/wrapped_dek/);
  });

  it("never surfaces storage_key / wrapped_dek / raw metadata in the DOM after a compare", async () => {
    withCompare(
      [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
      HAPPY_COMPARE_BODY,
    );
    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    fireEvent.click(screen.getByTestId("compare-versions-button"));
    await screen.findByTestId("compare-versions-result");
    const html = document.body.innerHTML;
    expect(html).not.toContain("storage_key");
    expect(html).not.toContain("wrapped_dek");
    expect(html).not.toContain("presigned_url");
  });

  it("clears a stale compare result when the user picks a different version", async () => {
    withCompare(
      [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
      HAPPY_COMPARE_BODY,
    );
    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    fireEvent.click(screen.getByTestId("compare-versions-button"));
    await screen.findByTestId("compare-versions-result");
    // Change one side — the stale result should disappear.
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: "" },
    });
    expect(
      screen.queryByTestId("compare-versions-result"),
    ).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // PR #90 — on-demand DOCX redline export
  // -------------------------------------------------------------------------

  it("disables Export redline until two distinct versions are picked", async () => {
    withCompare([SIGNED_ARTIFACT, SOURCE_ARTIFACT], HAPPY_COMPARE_BODY);
    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    const exportBtn = screen.getByTestId("compare-export-redline-button");
    expect(exportBtn).toBeDisabled();
    // Picking the same artifact on both sides is degenerate.
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    expect(exportBtn).toBeDisabled();
    // Two distinct versions enables the action.
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    expect(exportBtn).not.toBeDisabled();
  });

  it("POSTs to /artifacts/compare/export and triggers a blob download", async () => {
    // Spy on the URL + anchor click pipeline so we can confirm the
    // download flow fires without actually navigating jsdom.
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const anchorClicks: string[] = [];
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = originalCreateElement(tag);
      if (tag === "a") {
        Object.defineProperty(el, "click", {
          value: function () {
            anchorClicks.push((el as HTMLAnchorElement).href || "");
          },
          writable: true,
        });
      }
      return el;
    });

    withCompare(
      [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
      HAPPY_COMPARE_BODY,
    );
    // Layer the export endpoint on top of the existing mock.
    const baseImpl = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith(
          `/api/contracts/${CONTRACT_ID}/artifacts/compare/export`,
        ) &&
        init?.method === "POST"
      ) {
        return new Response(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]), {
          status: 200,
          headers: {
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition":
              'attachment; filename="Acme-MSA-comparison-report.docx"',
          },
        });
      }
      return baseImpl!(url, init);
    });

    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    fireEvent.click(screen.getByTestId("compare-export-redline-button"));

    await waitFor(() => {
      const exportCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith(
          `/api/contracts/${CONTRACT_ID}/artifacts/compare/export`,
        ),
      );
      expect(exportCall).toBeDefined();
      const body = JSON.parse(
        (exportCall![1] as RequestInit).body as string,
      );
      expect(body.base_artifact_id).toBe(SOURCE_ARTIFACT.id);
      expect(body.compare_artifact_id).toBe(SIGNED_ARTIFACT.id);
    });

    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalled();
      expect(anchorClicks.length).toBeGreaterThan(0);
      expect(revokeObjectURL).toHaveBeenCalled();
    });

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it("surfaces a safe error message when the export endpoint fails", async () => {
    withCompare(
      [SIGNED_ARTIFACT, SOURCE_ARTIFACT],
      HAPPY_COMPARE_BODY,
    );
    const baseImpl = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith(
          `/api/contracts/${CONTRACT_ID}/artifacts/compare/export`,
        )
      ) {
        return jsonResponse({ detail: "boom" }, 500);
      }
      return baseImpl!(url, init);
    });

    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    fireEvent.click(screen.getByTestId("compare-export-redline-button"));

    const error = await screen.findByTestId("compare-export-redline-error");
    expect(error.textContent ?? "").toMatch(/boom|export failed/i);
  });

  it("frames the export action as a comparison report, not an official Word redline", async () => {
    withCompare([SIGNED_ARTIFACT, SOURCE_ARTIFACT], HAPPY_COMPARE_BODY);
    renderPage();
    const panel = await screen.findByTestId("document-history-compare-panel");
    // Both the existing compare panel framing and the new export
    // framing must read as "comparison report", not "redline".
    expect(panel.textContent ?? "").toMatch(/not an official Word redline/i);
    expect(panel.textContent ?? "").toMatch(/comparison report/i);
  });

  // -------------------------------------------------------------------------
  // PR #91 — save redline to Document History
  // -------------------------------------------------------------------------

  it("disables Save to Document History until two distinct versions are picked", async () => {
    withCompare([SIGNED_ARTIFACT, SOURCE_ARTIFACT], HAPPY_COMPARE_BODY);
    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    const saveBtn = screen.getByTestId("compare-save-redline-button");
    expect(saveBtn).toBeDisabled();
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    expect(saveBtn).not.toBeDisabled();
  });

  it("POSTs to /artifacts/compare/save and refreshes Document History on success", async () => {
    const REDLINE_ID = "redline-1";
    const REDLINE_FILENAME = "Test-MSA-comparison-report.docx";
    const SAVED_REDLINE = {
      id: REDLINE_ID,
      contract_id: CONTRACT_ID,
      artifact_type: "redline",
      storage_backend: "s3",
      filename: REDLINE_FILENAME,
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      file_hash_sha256: null,
      size_bytes: 4096,
      source: "comparison_report",
      is_official: false,
      created_at: "2026-05-12T00:00:00Z",
      metadata_json: {
        base_artifact_id: SOURCE_ARTIFACT.id,
        compare_artifact_id: SIGNED_ARTIFACT.id,
        base_artifact_type: "original_upload",
        compare_artifact_type: "signed_pdf",
        added_lines: 3,
        removed_lines: 2,
        changed_blocks: 1,
        unchanged_lines: 12,
        format: "docx",
        source_kind: "comparison_report",
      },
    };

    let saved = false;
    withCompare([SIGNED_ARTIFACT, SOURCE_ARTIFACT], HAPPY_COMPARE_BODY);
    const baseImpl = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith(
          `/api/contracts/${CONTRACT_ID}/artifacts/compare/save`,
        ) &&
        init?.method === "POST"
      ) {
        saved = true;
        return jsonResponse(SAVED_REDLINE, 201);
      }
      // Once saved, the artifacts listing must include the new redline.
      if (
        saved &&
        url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)
      ) {
        return jsonResponse([
          SAVED_REDLINE,
          SIGNED_ARTIFACT,
          SOURCE_ARTIFACT,
        ]);
      }
      return baseImpl!(url, init);
    });

    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    fireEvent.click(screen.getByTestId("compare-save-redline-button"));

    await waitFor(() => {
      const saveCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith(
          `/api/contracts/${CONTRACT_ID}/artifacts/compare/save`,
        ),
      );
      expect(saveCall).toBeDefined();
      const body = JSON.parse(
        (saveCall![1] as RequestInit).body as string,
      );
      expect(body.base_artifact_id).toBe(SOURCE_ARTIFACT.id);
      expect(body.compare_artifact_id).toBe(SIGNED_ARTIFACT.id);
    });

    // Success confirmation surfaces with the filename.
    const confirm = await screen.findByTestId("compare-save-redline-confirm");
    expect(confirm.textContent ?? "").toContain(REDLINE_FILENAME);

    // The Document History list refreshes — the new redline row
    // appears with the user-facing "Redline" label.
    await waitFor(() => {
      const history = screen.getByTestId("document-history-list");
      expect(history.textContent ?? "").toMatch(/redline/i);
    });
  });

  it("surfaces a safe error when the save endpoint fails and does not refresh", async () => {
    withCompare([SIGNED_ARTIFACT, SOURCE_ARTIFACT], HAPPY_COMPARE_BODY);
    const baseImpl = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith(
          `/api/contracts/${CONTRACT_ID}/artifacts/compare/save`,
        )
      ) {
        return jsonResponse({ detail: "boom" }, 500);
      }
      return baseImpl!(url, init);
    });

    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    fireEvent.click(screen.getByTestId("compare-save-redline-button"));

    const err = await screen.findByTestId("compare-save-redline-error");
    expect(err.textContent ?? "").toMatch(/boom|failed/i);
    expect(
      screen.queryByTestId("compare-save-redline-confirm"),
    ).not.toBeInTheDocument();
  });

  it("does not surface storage internals returned by a regressed save endpoint", async () => {
    withCompare([SIGNED_ARTIFACT, SOURCE_ARTIFACT], HAPPY_COMPARE_BODY);
    const baseImpl = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith(
          `/api/contracts/${CONTRACT_ID}/artifacts/compare/save`,
        ) &&
        init?.method === "POST"
      ) {
        return jsonResponse(
          {
            id: "r1",
            contract_id: CONTRACT_ID,
            artifact_type: "redline",
            storage_backend: "s3",
            filename: "x.docx",
            mime_type:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            file_hash_sha256: null,
            size_bytes: 1,
            source: "comparison_report",
            is_official: false,
            created_at: "2026-05-12T00:00:00Z",
            metadata_json: {
              base_artifact_id: SOURCE_ARTIFACT.id,
              compare_artifact_id: SIGNED_ARTIFACT.id,
              format: "docx",
              source_kind: "comparison_report",
            },
            // Poison values: the api-client scrub should drop these
            // before the page ever sees them.
            storage_key: "should-not-appear",
            wrapped_dek: "should-not-appear",
          },
          201,
        );
      }
      return baseImpl!(url, init);
    });

    renderPage();
    await screen.findByTestId("document-history-compare-panel");
    fireEvent.change(screen.getByTestId("compare-base-select"), {
      target: { value: SOURCE_ARTIFACT.id },
    });
    fireEvent.change(screen.getByTestId("compare-target-select"), {
      target: { value: SIGNED_ARTIFACT.id },
    });
    fireEvent.click(screen.getByTestId("compare-save-redline-button"));

    await screen.findByTestId("compare-save-redline-confirm");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("storage_key");
    expect(text).not.toContain("wrapped_dek");
    expect(text).not.toContain("should-not-appear");
  });
});

// ---------------------------------------------------------------------------
// PR #83 — lifecycle status banner above the document lifecycle strip
// ---------------------------------------------------------------------------

describe("ContractWorkspacePage lifecycle status banner (PR #83)", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(VALID_UUID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("renders a green Executed banner with the signed-PDF date when status is executed", async () => {
    const signed = {
      ...ARTIFACT,
      id: "55555555-5555-4555-8555-555555555555",
      artifact_type: "signed_pdf",
      filename: "signed.pdf",
      created_at: "2026-05-11T00:00:00Z",
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        return jsonResponse([ARTIFACT, signed]);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
        return jsonResponse(METADATA_VIEW);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
        return jsonResponse({ ...CONTRACT_DETAIL, status: "executed" });
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    const banner = await screen.findByTestId("workspace-status-banner-executed");
    expect(banner).toHaveTextContent(/executed/i);
    // The banner surfaces the formatted signed-PDF date — exact text
    // depends on locale, but the year is stable.
    expect(banner).toHaveTextContent(/2026/);
    expect(
      screen.queryByTestId("workspace-status-banner-sent"),
    ).toBeNull();
  });

  it("renders an Out for signature info banner when status is sent_for_signature", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        return jsonResponse([ARTIFACT]);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
        return jsonResponse(METADATA_VIEW);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
        return jsonResponse({
          ...CONTRACT_DETAIL,
          status: "sent_for_signature",
        });
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    const banner = await screen.findByTestId("workspace-status-banner-sent");
    expect(banner).toHaveTextContent(/out for signature/i);
    expect(banner).toHaveTextContent(/waiting/i);
    expect(
      screen.queryByTestId("workspace-status-banner-executed"),
    ).toBeNull();
  });

  it("renders no status banner for status 'ready' (clean by default)", async () => {
    setupFetch(fetchMock);
    renderPage();
    await screen.findByTestId("document-lifecycle-strip");
    expect(
      screen.queryByTestId("workspace-status-banner-executed"),
    ).toBeNull();
    expect(
      screen.queryByTestId("workspace-status-banner-sent"),
    ).toBeNull();
  });

  it("renders an Executed banner even when the artifacts list is still loading", async () => {
    // The banner should not block on the artifacts request — clients
    // see status=executed on the contract response and that alone is
    // enough to surface the success state. The signed-PDF date is a
    // nice-to-have.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        // Hang forever; the banner should still render from the
        // contract response.
        return new Promise<Response>(() => {});
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
        return jsonResponse(METADATA_VIEW);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
        return jsonResponse({ ...CONTRACT_DETAIL, status: "executed" });
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    expect(
      await screen.findByTestId("workspace-status-banner-executed"),
    ).toBeInTheDocument();
  });

  it("does not leak storage_key / wrapped_dek / signer PII through the banner path", async () => {
    const signed = {
      ...ARTIFACT,
      id: "77777777-7777-4777-8777-777777777777",
      artifact_type: "signed_pdf",
      filename: "signed.pdf",
      created_at: "2026-05-11T00:00:00Z",
      // Poison values: the API client scrubs them, but assert
      // defense-in-depth against the rendered DOM.
      metadata_json: {
        storage_key: "should-not-appear",
        wrapped_dek: "should-not-appear",
        signer_email: "signer@example.com",
        docuseal_secret: "shhh",
      } as Record<string, unknown>,
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        return jsonResponse([ARTIFACT, signed]);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/metadata`)) {
        return jsonResponse(METADATA_VIEW);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
        return jsonResponse({ ...CONTRACT_DETAIL, status: "executed" });
      }
      return jsonResponse({ detail: "unexpected" }, 500);
    });
    renderPage();
    await screen.findByTestId("workspace-status-banner-executed");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("storage_key");
    expect(text).not.toContain("wrapped_dek");
    expect(text).not.toContain("signer@example.com");
    expect(text).not.toContain("docuseal_secret");
    expect(text).not.toContain("shhh");
  });
});
