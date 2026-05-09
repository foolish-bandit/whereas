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

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/requests"]}>
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
    expect(link).toHaveAttribute("href", "/demo/contracts/contract-xyz");
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
    expect(link).toHaveAttribute("href", "/demo/contracts/contract-new");

    // The DOM must not contain any storage internals — the API client
    // scrubs them, but this checks end-to-end at the rendered surface.
    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("wrapped_dek");
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
});
