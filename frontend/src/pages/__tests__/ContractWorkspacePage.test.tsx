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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setupFetch(
  fetchMock: Mock,
  options: { snapshot?: object | null; artifacts?: object[] } = {},
) {
  const snapshot =
    "snapshot" in options ? options.snapshot ?? null : SNAPSHOT;
  const artifacts =
    "artifacts" in options ? options.artifacts ?? [] : [ARTIFACT];
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
      return snapshot
        ? jsonResponse(snapshot)
        : jsonResponse({ detail: "not found" }, 404);
    }
    if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
      return jsonResponse(artifacts);
    }
    if (url.endsWith(`/api/contracts/${CONTRACT_ID}`)) {
      return jsonResponse(CONTRACT_DETAIL);
    }
    return jsonResponse({ detail: "unexpected" }, 500);
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/contracts/${CONTRACT_ID}`]}>
      <Routes>
        <Route
          path="/contracts/:id"
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

  it("defaults to the markdown preview and shows the toggle + Download original action", async () => {
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
    expect(buttons[0].textContent).toMatch(/markdown preview/i);
    expect(buttons[1]).toHaveAttribute("aria-pressed", "false");
    expect(buttons[1].textContent).toMatch(/view original/i);

    // The header still exposes the original-artifact action.
    expect(
      screen.getByRole("button", { name: /download original/i }),
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

  it("renders the original artifact metadata strip when an artifact is returned", async () => {
    setupFetch(fetchMock);
    renderPage();
    const strip = await screen.findByTestId("original-artifact-strip");
    expect(strip).toHaveTextContent(/original artifact/i);
    expect(strip).toHaveTextContent(/official/i);
    expect(strip).toHaveTextContent("vendor-msa.pdf");
    expect(strip).toHaveTextContent(/pdf/i);
  });

  it("renders a legacy fallback strip when the artifacts list is empty", async () => {
    setupFetch(fetchMock, { artifacts: [] });
    renderPage();
    const legacy = await screen.findByTestId(
      "original-artifact-strip-legacy",
    );
    expect(legacy).toHaveTextContent(/legacy original/i);
    // The official strip must not render when no artifact exists.
    expect(
      screen.queryByTestId("original-artifact-strip"),
    ).not.toBeInTheDocument();
    // Download original action stays available either way.
    expect(
      screen.getByRole("button", { name: /download original/i }),
    ).toBeInTheDocument();
  });

  it("prefers signed_pdf over original_upload in the artifact strip", async () => {
    const SIGNED = {
      ...ARTIFACT,
      id: "55555555-5555-4555-8555-555555555555",
      artifact_type: "signed_pdf",
      filename: "executed-msa.signed.pdf",
      mime_type: "application/pdf",
      source: "docuseal",
    };
    setupFetch(fetchMock, { artifacts: [SIGNED, ARTIFACT] });
    renderPage();
    const strip = await screen.findByTestId("signed-artifact-strip");
    expect(strip).toHaveTextContent(/signed artifact/i);
    expect(strip).toHaveTextContent("executed-msa.signed.pdf");
    expect(strip).toHaveTextContent(/signed/i);
    // The "original" strip must NOT also render — only one strip.
    expect(
      screen.queryByTestId("original-artifact-strip"),
    ).not.toBeInTheDocument();
  });

  it("renders neither artifact strip when the artifacts API fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) {
        return jsonResponse(SNAPSHOT);
      }
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) {
        return jsonResponse({ detail: "boom" }, 500);
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
    // Workspace still renders the Markdown preview; the artifact
    // failure is silent.
    await screen.findByRole("heading", {
      level: 1,
      name: "Workspace markdown",
    });
    expect(
      screen.queryByTestId("original-artifact-strip"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("original-artifact-strip-legacy"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download original/i }),
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

  it("shows safe gate error state when approval-gate fetch fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/markdown`)) return jsonResponse(SNAPSHOT);
      if (url.endsWith(`/api/contracts/${CONTRACT_ID}/artifacts`)) return jsonResponse([ARTIFACT]);
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
