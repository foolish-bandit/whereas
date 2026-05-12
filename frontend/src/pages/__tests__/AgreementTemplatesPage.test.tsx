import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

import AgreementTemplatesPage from "../AgreementTemplatesPage";
import AgreementTemplateDetailPage from "../AgreementTemplateDetailPage";
import { setDevUserId, clearDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";
const NDA_ID = "11111111-1111-4111-8111-111111111111";
const MSA_ID = "22222222-2222-4222-8222-222222222222";

const NDA = {
  id: NDA_ID,
  organization_id: "org-1",
  name: "Mutual NDA",
  description: "Standard NDA",
  template_type: "NDA",
  status: "active",
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
  metadata_json: null,
};

const MSA = {
  id: MSA_ID,
  organization_id: "org-1",
  name: "MSA",
  description: null,
  template_type: "MSA",
  status: "active",
  created_at: "2026-04-02T00:00:00Z",
  updated_at: "2026-04-02T00:00:00Z",
  metadata_json: null,
};

const NDA_MARKDOWN = {
  id: "snap-1",
  template_id: NDA_ID,
  markdown_text: "# Mutual NDA\n\nbody text",
  source_kind: "original_upload",
  converter_name: "markitdown",
  converter_version: "0.0.1",
  conversion_status: "ready",
  conversion_warnings: null,
  created_at: "2026-04-01T00:05:00Z",
};

const NDA_ARTIFACT = {
  id: "art-1",
  template_id: NDA_ID,
  artifact_type: "original_upload",
  storage_backend: "s3",
  filename: "nda.docx",
  mime_type:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  file_hash_sha256: null,
  size_bytes: 1024,
  source: "user_upload",
  is_official: true,
  created_at: "2026-04-01T00:05:00Z",
  metadata_json: null,
  // Defensive: backend never returns this, but if it leaked, scrubSecrets()
  // should remove it before it reaches the component.
  storage_key: "templates/should-not-be-here.enc",
};

const NDA_VARIABLES = [
  {
    id: "v-1",
    template_id: NDA_ID,
    key: "counterparty_name",
    label: "Counterparty Name",
    variable_type: "text",
    required: true,
    default_value: null,
    help_text: null,
    sort_order: 1,
    metadata_json: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  },
  // PR #94 — a second required variable so the missing-required
  // warning has more than one entry, plus an optional variable that
  // exercises the required/optional grouping in the generation form.
  {
    id: "v-2",
    template_id: NDA_ID,
    key: "effective_date",
    label: "Effective Date",
    variable_type: "date",
    required: true,
    default_value: null,
    help_text: null,
    sort_order: 2,
    metadata_json: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  },
  {
    id: "v-3",
    template_id: NDA_ID,
    key: "governing_law",
    label: "Governing Law",
    variable_type: "text",
    required: false,
    default_value: "California",
    help_text: null,
    sort_order: 3,
    metadata_json: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setupListFetch(fetchMock: Mock) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/api/agreement-templates")) {
      return jsonResponse([NDA, MSA]);
    }
    return jsonResponse({ detail: "unexpected " + url }, 500);
  });
}

function setupDetailFetch(
  fetchMock: Mock,
  opts: {
    markdown?: object | null;
    suggestions?: unknown[];
    suggestionsStatus?: number;
  } = {},
) {
  const markdown = "markdown" in opts ? opts.markdown : NDA_MARKDOWN;
  const suggestions = opts.suggestions ?? [];
  const suggestionsStatus = opts.suggestionsStatus ?? 200;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith(`/api/agreement-templates/${NDA_ID}/markdown`)) {
      return markdown
        ? jsonResponse(markdown)
        : jsonResponse({ detail: "not found" }, 404);
    }
    if (url.endsWith(`/api/agreement-templates/${NDA_ID}/artifacts`)) {
      return jsonResponse([NDA_ARTIFACT]);
    }
    if (url.endsWith(`/api/agreement-templates/${NDA_ID}/variables`)) {
      return jsonResponse(NDA_VARIABLES);
    }
    if (
      url.endsWith(
        `/api/agreement-templates/${NDA_ID}/variable-suggestions`,
      )
    ) {
      return suggestionsStatus === 200
        ? jsonResponse(suggestions)
        : jsonResponse({ detail: "boom" }, suggestionsStatus);
    }
    if (url.endsWith(`/api/agreement-templates/${NDA_ID}`)) {
      return jsonResponse(NDA);
    }
    return jsonResponse({ detail: "unexpected " + url }, 500);
  });
}

describe("AgreementTemplatesPage", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("renders the template list", async () => {
    setupListFetch(fetchMock);
    render(
      <MemoryRouter initialEntries={["/agreement-templates"]}>
        <Routes>
          <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Mutual NDA")).toBeInTheDocument();
    // PR #87: "MSA" appears both as the row title and the type chip,
    // so we disambiguate via the row-link testId.
    const links = screen.getAllByTestId("agreement-templates-row-link");
    expect(links.map((l) => l.textContent)).toEqual(
      expect.arrayContaining(["Mutual NDA", "MSA"]),
    );
  });

  it("shows an empty state when no templates exist", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    render(
      <MemoryRouter initialEntries={["/agreement-templates"]}>
        <Routes>
          <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No templates yet/i)).toBeInTheDocument();
  });

  it("creates a template through the form", async () => {
    let listed = [NDA];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/agreement-templates") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        const created = {
          ...NDA,
          id: "new-id",
          name: body.name,
          template_type: body.template_type,
        };
        listed = [created, ...listed];
        return jsonResponse(created);
      }
      if (url.endsWith("/api/agreement-templates")) {
        return jsonResponse(listed);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });

    render(
      <MemoryRouter initialEntries={["/agreement-templates"]}>
        <Routes>
          <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Mutual NDA");

    fireEvent.change(screen.getByPlaceholderText(/Template name/i), {
      target: { value: "Vendor SOW" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Template type/i), {
      target: { value: "SOW" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create template/i }));

    await screen.findByText("Vendor SOW");
  });
});

describe("AgreementTemplateDetailPage", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  function renderDetail(
    initialPath: string = `/demo/agreement-templates/${NDA_ID}`,
  ) {
    return render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/demo/agreement-templates/:id"
            element={<AgreementTemplateDetailPage />}
          />
          <Route
            path="/demo/requests/templates/:id"
            element={<AgreementTemplateDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("renders the markdown preview when available", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    const body = await screen.findByTestId("agreement-template-markdown-body");
    expect(body.textContent).toContain("body text");
  });

  it("renders an empty state when no markdown snapshot exists", async () => {
    setupDetailFetch(fetchMock, { markdown: null });
    renderDetail();
    expect(
      await screen.findByTestId("agreement-template-markdown-empty"),
    ).toBeInTheDocument();
  });

  it("shows variables and supports the upload UI affordance", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    expect(
      screen.getByTestId("agreement-template-file-input"),
    ).toBeInTheDocument();
    // The variables list and the generation form both render the label,
    // so look inside the variables panel specifically.
    const variablesPanel = screen.getByTestId("agreement-template-variables");
    expect(variablesPanel.textContent).toContain("Counterparty Name");
    expect(variablesPanel.textContent).toContain("counterparty_name");
  });

  it("does not surface storage_key from artifact responses", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    await waitFor(() =>
      expect(screen.getByTestId("agreement-template-artifact")).toBeInTheDocument(),
    );
    // The defensive scrub in the API client should drop storage_key even
    // if the backend ever started returning it.
    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("should-not-be-here");
  });

  it("renders a generation form built from the template variables", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");

    expect(
      screen.getByTestId("agreement-template-generate"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agreement-template-generate-input-counterparty_name"),
    ).toBeInTheDocument();
  });

  it("shows the generated contract success state with a link", async () => {
    const GENERATED_CONTRACT_ID = "99999999-9999-4999-8999-999999999999";
    fetchMock.mockImplementation(
      async (url: string, init: RequestInit | undefined) => {
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/markdown`)) {
          return jsonResponse(NDA_MARKDOWN);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/artifacts`)) {
          return jsonResponse([NDA_ARTIFACT]);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/variables`)) {
          return jsonResponse(NDA_VARIABLES);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}`)) {
          return jsonResponse(NDA);
        }
        if (
          url.endsWith(`/api/agreement-templates/${NDA_ID}/generate`) &&
          init?.method === "POST"
        ) {
          const body = JSON.parse(init.body as string);
          expect(body.variable_values.counterparty_name).toBe("Acme Inc.");
          return jsonResponse(
            {
              contract: {
                id: GENERATED_CONTRACT_ID,
                title: body.title || "Mutual NDA — generated",
                status: "ready",
                mime_type:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                file_hash_sha256: "f".repeat(64),
                page_count: null,
                created_at: "2026-05-09T10:00:00Z",
                updated_at: "2026-05-09T10:00:00Z",
              },
              artifact: {
                id: "art-generated-1",
                contract_id: GENERATED_CONTRACT_ID,
                artifact_type: "generated_docx",
                storage_backend: "s3",
                filename: "Acme_NDA.docx",
                mime_type:
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                file_hash_sha256: null,
                size_bytes: 32_000,
                source: "template_generation",
                is_official: true,
                created_at: "2026-05-09T10:00:00Z",
                metadata_json: {
                  template_id: NDA_ID,
                  template_name: "Mutual NDA",
                  variable_values: { counterparty_name: "Acme Inc." },
                },
                // Defensive: backend never returns this; the scrub should drop it.
                storage_key: "documents/should-not-be-here.enc",
              },
              markdown_snapshot: null,
              variables_used: ["counterparty_name"],
            },
            201,
          );
        }
        return jsonResponse({ detail: "unexpected " + url }, 500);
      },
    );

    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");

    fireEvent.change(screen.getByTestId("agreement-template-generate-title"), {
      target: { value: "Acme NDA" },
    });
    fireEvent.change(
      screen.getByTestId("agreement-template-generate-input-counterparty_name"),
      { target: { value: "Acme Inc." } },
    );
    // PR #94 — the fixture now carries two required variables, so we
    // also fill effective_date before clicking Generate.
    fireEvent.change(
      screen.getByTestId("agreement-template-generate-input-effective_date"),
      { target: { value: "2026-05-01" } },
    );

    // PR #97 — top-level button opens the review panel; the actual
    // API call only fires on the panel's final Generate button.
    fireEvent.click(
      screen.getByTestId("agreement-template-generate-submit"),
    );
    await screen.findByTestId("agreement-template-generate-review");
    fireEvent.click(
      screen.getByTestId("agreement-template-generate-review-confirm"),
    );

    await screen.findByTestId("agreement-template-generate-success");
    const link = screen.getByTestId("agreement-template-generate-contract-link");
    expect(link).toHaveAttribute(
      "href",
      `/demo/repository/${GENERATED_CONTRACT_ID}`,
    );
    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("should-not-be-here");
  });

  it("warns about missing required fields when generate is clicked with blanks (PR #94)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");

    // The button is no longer disabled when a required field is blank
    // (PR #94 — clicking surfaces a clear "Missing required fields"
    // message rather than silently disabling).
    const button = screen.getByTestId("agreement-template-generate-submit");
    expect(button).not.toBeDisabled();
    expect(
      screen.queryByTestId("agreement-template-generate-missing-required"),
    ).toBeNull();

    fireEvent.click(button);
    const missing = await screen.findByTestId(
      "agreement-template-generate-missing-required",
    );
    // The fixture defines two required variables; both should be in the
    // warning since neither has been filled.
    expect(missing.textContent ?? "").toMatch(/counterparty name/i);
    expect(missing.textContent ?? "").toMatch(/effective date/i);
  });

  it("renders an Active status pill, breadcrumb, and a template-type chip (PR #94)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    expect(screen.getByTestId("agreement-template-status-pill")).toHaveTextContent(
      /active/i,
    );
    expect(screen.getByTestId("agreement-template-type-chip")).toHaveTextContent(
      "NDA",
    );
    // Breadcrumb is mount-aware: when we render under /demo/* the
    // links point at the demo-prefixed routes.
    const breadcrumb = screen.getByTestId(
      "agreement-template-breadcrumb-templates",
    );
    expect(breadcrumb).toHaveAttribute(
      "href",
      "/demo/requests/templates",
    );
  });

  it("renders a user-friendly artifact label (no raw original_upload / generated_docx) (PR #94)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    const list = await screen.findByTestId(
      "agreement-template-artifact-list",
    );
    expect(list.textContent ?? "").toMatch(/source file/i);
    // The raw enum names should never leak into the rendered DOM.
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/\boriginal_upload\b/);
    expect(body).not.toMatch(/\bgenerated_docx\b/);
  });

  it("does not surface raw metadata_json anywhere on the detail page (PR #94)", async () => {
    const tampered = {
      ...NDA,
      metadata_json: {
        secret_note: "should-not-render",
        storage_key: "should-not-render",
      } as Record<string, unknown>,
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/markdown`)) {
        return jsonResponse(NDA_MARKDOWN);
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/artifacts`)) {
        return jsonResponse([NDA_ARTIFACT]);
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/variables`)) {
        return jsonResponse(NDA_VARIABLES);
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}`)) {
        return jsonResponse(tampered);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    const body = document.body.textContent ?? "";
    // The pre-#94 implementation dumped metadata_json into a <pre>
    // block at the bottom of the page; PR #94 removed that.
    expect(body).not.toContain("metadata_json");
    expect(body).not.toContain("should-not-render");
    expect(body).not.toContain("storage_key");
  });

  it("groups required variables before optional ones in the generate form (PR #94)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    expect(
      screen.getByTestId("agreement-template-generate-required-group"),
    ).toHaveTextContent(/counterparty name/i);
    expect(
      screen.getByTestId("agreement-template-generate-required-group"),
    ).toHaveTextContent(/effective date/i);
    expect(
      screen.getByTestId("agreement-template-generate-optional-group"),
    ).toHaveTextContent(/governing law/i);
  });

  it("archives the template behind a two-step confirm (PR #94)", async () => {
    let archived = false;
    fetchMock.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url.endsWith(`/api/agreement-templates/${NDA_ID}`) &&
          init?.method === "DELETE"
        ) {
          archived = true;
          return new Response(null, { status: 204 });
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/markdown`)) {
          return jsonResponse(NDA_MARKDOWN);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/artifacts`)) {
          return jsonResponse([NDA_ARTIFACT]);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/variables`)) {
          return jsonResponse(NDA_VARIABLES);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}`)) {
          return jsonResponse(archived ? { ...NDA, status: "archived" } : NDA);
        }
        return jsonResponse({ detail: "unexpected " + url }, 500);
      },
    );
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");

    // Single click reveals confirm — no DELETE goes out yet.
    fireEvent.click(
      screen.getByTestId("agreement-template-archive-button"),
    );
    expect(archived).toBe(false);
    expect(
      screen.getByTestId("agreement-template-confirm-archive"),
    ).toBeInTheDocument();
    // Cancel keeps us in pristine state.
    fireEvent.click(
      screen.getByTestId("agreement-template-cancel-archive"),
    );
    expect(archived).toBe(false);
    // Re-open + confirm sends the DELETE.
    fireEvent.click(
      screen.getByTestId("agreement-template-archive-button"),
    );
    fireEvent.click(
      screen.getByTestId("agreement-template-confirm-archive"),
    );
    await waitFor(() => expect(archived).toBe(true));
    // After the reload, the status pill flips to Archived and the
    // Archive section disappears (only shown on Active templates).
    await waitFor(() => {
      expect(
        screen.getByTestId("agreement-template-status-pill"),
      ).toHaveTextContent(/archived/i);
    });
    expect(screen.queryByTestId("agreement-template-archive")).toBeNull();
  });

  it("hides the Archive section entirely on already-archived templates (PR #94)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/markdown`)) {
        return jsonResponse(NDA_MARKDOWN);
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/artifacts`)) {
        return jsonResponse([NDA_ARTIFACT]);
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/variables`)) {
        return jsonResponse(NDA_VARIABLES);
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}`)) {
        return jsonResponse({ ...NDA, status: "archived" });
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    expect(
      screen.getByTestId("agreement-template-status-pill"),
    ).toHaveTextContent(/archived/i);
    expect(screen.queryByTestId("agreement-template-archive")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // PR #97 — pre-generation review step
  // -------------------------------------------------------------------------

  it("Review generation opens the inline review panel (PR #97)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    expect(
      screen.queryByTestId("agreement-template-generate-review"),
    ).toBeNull();

    const submit = screen.getByTestId(
      "agreement-template-generate-submit",
    );
    expect(submit).toHaveTextContent(/review generation/i);
    fireEvent.click(submit);

    const panel = await screen.findByTestId(
      "agreement-template-generate-review",
    );
    expect(panel).toHaveAttribute("aria-label", "Review generation");
    // While the panel is open the top-level button is disabled (the
    // user uses the in-panel buttons from this point).
    expect(submit).toBeDisabled();
  });

  it("review panel renders summary counts (PR #97)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");

    // Fill one of two required variables so missing=1, filled=1.
    fireEvent.change(
      screen.getByTestId(
        "agreement-template-generate-input-counterparty_name",
      ),
      { target: { value: "Acme" } },
    );
    fireEvent.click(
      screen.getByTestId("agreement-template-generate-submit"),
    );
    const panel = await screen.findByTestId(
      "agreement-template-generate-review",
    );
    expect(
      within(panel).getByTestId(
        "agreement-template-generate-review-required-filled",
      ),
    ).toHaveTextContent("1");
    expect(
      within(panel).getByTestId(
        "agreement-template-generate-review-required-missing",
      ),
    ).toHaveTextContent("1");
    // governing_law has a default of "California" — so the optional
    // group has 0 blank entries despite the user not having typed
    // anything (default fills it for the review).
    expect(
      within(panel).getByTestId(
        "agreement-template-generate-review-optional-blank",
      ),
    ).toHaveTextContent("0");
  });

  it("review panel disables final Generate when required fields are missing (PR #97)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");

    fireEvent.click(
      screen.getByTestId("agreement-template-generate-submit"),
    );
    await screen.findByTestId("agreement-template-generate-review");
    expect(
      screen.getByTestId("agreement-template-generate-review-confirm"),
    ).toBeDisabled();
    expect(
      screen.getByTestId(
        "agreement-template-generate-review-missing-warning",
      ),
    ).toHaveTextContent(/fill missing required/i);
  });

  it("review panel does not call the generation endpoint on open (PR #97)", async () => {
    let generateCalled = false;
    fetchMock.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url.endsWith(`/api/agreement-templates/${NDA_ID}/generate`) &&
          init?.method === "POST"
        ) {
          generateCalled = true;
          return jsonResponse({ detail: "should not fire" }, 500);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/markdown`)) {
          return jsonResponse(NDA_MARKDOWN);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/artifacts`)) {
          return jsonResponse([NDA_ARTIFACT]);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/variables`)) {
          return jsonResponse(NDA_VARIABLES);
        }
        if (
          url.endsWith(
            `/api/agreement-templates/${NDA_ID}/variable-suggestions`,
          )
        ) {
          return jsonResponse([]);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}`)) {
          return jsonResponse(NDA);
        }
        return jsonResponse({ detail: "unexpected " + url }, 500);
      },
    );
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    fireEvent.change(
      screen.getByTestId(
        "agreement-template-generate-input-counterparty_name",
      ),
      { target: { value: "Acme" } },
    );
    fireEvent.change(
      screen.getByTestId("agreement-template-generate-input-effective_date"),
      { target: { value: "2026-05-01" } },
    );
    fireEvent.click(
      screen.getByTestId("agreement-template-generate-submit"),
    );
    await screen.findByTestId("agreement-template-generate-review");
    expect(generateCalled).toBe(false);
  });

  it("Back to edit closes the review panel (PR #97)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    fireEvent.click(
      screen.getByTestId("agreement-template-generate-submit"),
    );
    await screen.findByTestId("agreement-template-generate-review");
    fireEvent.click(
      screen.getByTestId("agreement-template-generate-review-back"),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId("agreement-template-generate-review"),
      ).toBeNull();
    });
    // Top-level button re-enabled.
    expect(
      screen.getByTestId("agreement-template-generate-submit"),
    ).not.toBeDisabled();
  });

  it("review panel renders privacy note and result framing (PR #97)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    fireEvent.click(
      screen.getByTestId("agreement-template-generate-submit"),
    );
    const panel = await screen.findByTestId(
      "agreement-template-generate-review",
    );
    expect(
      within(panel).getByTestId(
        "agreement-template-generate-review-result",
      ),
    ).toHaveTextContent(
      /create a Repository record with a Generated Word document/i,
    );
    expect(
      within(panel).getByTestId(
        "agreement-template-generate-review-privacy",
      ),
    ).toHaveTextContent(
      /not stored in template metadata/i,
    );
    // No raw backend labels.
    expect(panel.textContent ?? "").not.toMatch(/\bgenerated_docx\b/);
    expect(panel.textContent ?? "").not.toMatch(/\boriginal_upload\b/);
  });

  it("review panel rows report Filled / Blank / Missing status (PR #97)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");

    // Fill counterparty_name; leave effective_date missing.
    fireEvent.change(
      screen.getByTestId(
        "agreement-template-generate-input-counterparty_name",
      ),
      { target: { value: "Acme" } },
    );
    // Override the optional governing_law default to empty (Blank).
    fireEvent.change(
      screen.getByTestId(
        "agreement-template-generate-input-governing_law",
      ),
      { target: { value: "" } },
    );
    fireEvent.click(
      screen.getByTestId("agreement-template-generate-submit"),
    );
    const panel = await screen.findByTestId(
      "agreement-template-generate-review",
    );
    const rows = within(panel).getAllByTestId(
      "agreement-template-generate-review-row",
    );
    const byKey = new Map(
      rows.map((row) => [row.getAttribute("data-variable-key"), row]),
    );
    expect(byKey.get("counterparty_name")?.getAttribute("data-status")).toBe(
      "filled",
    );
    expect(byKey.get("effective_date")?.getAttribute("data-status")).toBe(
      "missing",
    );
    expect(byKey.get("governing_law")?.getAttribute("data-status")).toBe(
      "blank",
    );
  });

  it("does not surface forbidden strings in the review panel (PR #97)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    fireEvent.click(
      screen.getByTestId("agreement-template-generate-submit"),
    );
    await screen.findByTestId("agreement-template-generate-review");
    const body = document.body.textContent ?? "";
    for (const needle of [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned",
    ]) {
      expect(body).not.toContain(needle);
    }
  });

  // -------------------------------------------------------------------------
  // PR #96 — variable suggestion detection
  // -------------------------------------------------------------------------

  it("renders an empty-state message when no placeholders are detected (PR #96)", async () => {
    setupDetailFetch(fetchMock, { suggestions: [] });
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    expect(
      screen.getByTestId("agreement-template-suggestions-empty"),
    ).toHaveTextContent(/no placeholders detected/i);
    expect(
      screen.queryByTestId("agreement-template-suggestions-list"),
    ).toBeNull();
  });

  it("renders suggestion rows with label, key, and occurrence count (PR #96)", async () => {
    setupDetailFetch(fetchMock, {
      suggestions: [
        { key: "term_years", label: "Term Years", occurrences: 3 },
        { key: "governing_law", label: "Governing Law", occurrences: 1 },
      ],
    });
    renderDetail();
    const list = await screen.findByTestId(
      "agreement-template-suggestions-list",
    );
    const rows = within(list).getAllByTestId(
      "agreement-template-suggestion-row",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("data-suggestion-key")).toBe("term_years");
    expect(rows[0]).toHaveTextContent("Term Years");
    expect(rows[0]).toHaveTextContent("term_years");
    expect(rows[0]).toHaveTextContent("3×");
    expect(rows[1]).toHaveTextContent("Governing Law");
    expect(rows[1]).toHaveTextContent("1×");
  });

  it("Add as variable creates the variable and removes the suggestion (PR #96)", async () => {
    let created = false;
    fetchMock.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url.endsWith(`/api/agreement-templates/${NDA_ID}/variables`) &&
          init?.method === "POST"
        ) {
          created = true;
          const body = JSON.parse(init.body as string);
          expect(body.key).toBe("term_years");
          expect(body.required).toBe(true);
          return jsonResponse(
            {
              id: "v-new",
              template_id: NDA_ID,
              key: body.key,
              label: body.label,
              variable_type: body.variable_type,
              required: body.required,
              default_value: null,
              help_text: null,
              sort_order: body.sort_order ?? 0,
              metadata_json: null,
              created_at: "2026-05-12T00:00:00Z",
              updated_at: "2026-05-12T00:00:00Z",
            },
            201,
          );
        }
        if (
          url.endsWith(`/api/agreement-templates/${NDA_ID}/variable-suggestions`)
        ) {
          return jsonResponse([
            { key: "term_years", label: "Term Years", occurrences: 3 },
          ]);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/markdown`)) {
          return jsonResponse(NDA_MARKDOWN);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/artifacts`)) {
          return jsonResponse([NDA_ARTIFACT]);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}/variables`)) {
          return jsonResponse(NDA_VARIABLES);
        }
        if (url.endsWith(`/api/agreement-templates/${NDA_ID}`)) {
          return jsonResponse(NDA);
        }
        return jsonResponse({ detail: "unexpected " + url }, 500);
      },
    );
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    // Toggle required ON for term_years before adding.
    fireEvent.click(
      screen.getByTestId("agreement-template-suggestion-required-term_years"),
    );
    fireEvent.click(
      screen.getByTestId("agreement-template-suggestion-add-term_years"),
    );
    await waitFor(() => expect(created).toBe(true));
    // The suggestion disappears (the just-added variable is filtered
    // out of the suggestions list).
    await waitFor(() => {
      expect(
        screen.queryByTestId(
          "agreement-template-suggestion-row",
        ),
      ).toBeNull();
    });
    expect(
      screen.getByTestId("agreement-template-suggestions-empty"),
    ).toBeInTheDocument();
  });

  it("does not duplicate suggestions that already exist as variables (PR #96)", async () => {
    // counterparty_name is already a variable in NDA_VARIABLES (PR #94
    // fixture). The backend filters duplicates server-side; this test
    // pins the contract that the page renders only the suggestions
    // the server returned (does NOT re-merge anything client-side).
    setupDetailFetch(fetchMock, {
      suggestions: [
        // Only the non-existing key is in the response.
        { key: "term_years", label: "Term Years", occurrences: 2 },
      ],
    });
    renderDetail();
    const list = await screen.findByTestId(
      "agreement-template-suggestions-list",
    );
    expect(
      within(list).queryAllByTestId(
        "agreement-template-suggestion-row",
      ),
    ).toHaveLength(1);
    expect(list).not.toHaveTextContent(/counterparty_name/);
  });

  it("survives a failing suggestion endpoint (renders empty section)", async () => {
    setupDetailFetch(fetchMock, { suggestionsStatus: 500 });
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    expect(
      screen.getByTestId("agreement-template-suggestions"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agreement-template-suggestions-empty"),
    ).toBeInTheDocument();
  });

  it("does not surface forbidden strings in the rendered DOM (PR #94)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");
    const body = document.body.textContent ?? "";
    for (const needle of [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned",
    ]) {
      expect(body).not.toContain(needle);
    }
  });

  it("clears the missing-required warning once required fields are filled (PR #94)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");

    fireEvent.click(screen.getByTestId("agreement-template-generate-submit"));
    await screen.findByTestId("agreement-template-generate-missing-required");

    fireEvent.change(
      screen.getByTestId("agreement-template-generate-input-counterparty_name"),
      { target: { value: "Acme" } },
    );
    fireEvent.change(
      screen.getByTestId("agreement-template-generate-input-effective_date"),
      { target: { value: "2026-05-01" } },
    );
    // The warning disappears as soon as both required values are non-blank.
    await waitFor(() => {
      expect(
        screen.queryByTestId("agreement-template-generate-missing-required"),
      ).toBeNull();
    });
  });

  it("warns when generation is attempted without an original upload", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/markdown`)) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/artifacts`)) {
        return jsonResponse([]);
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/variables`)) {
        return jsonResponse([]);
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}`)) {
        return jsonResponse(NDA);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderDetail();
    await screen.findByTestId("agreement-template-generate");

    expect(
      screen.getByTestId("agreement-template-generate-needs-upload"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agreement-template-generate-submit"),
    ).toBeDisabled();
  });
});
