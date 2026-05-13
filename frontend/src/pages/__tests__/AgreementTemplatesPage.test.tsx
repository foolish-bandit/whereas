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
    artifacts?: unknown[];
  } = {},
) {
  const markdown = "markdown" in opts ? opts.markdown : NDA_MARKDOWN;
  const suggestions = opts.suggestions ?? [];
  const suggestionsStatus = opts.suggestionsStatus ?? 200;
  const artifacts = opts.artifacts ?? [NDA_ARTIFACT];
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith(`/api/agreement-templates/${NDA_ID}/markdown`)) {
      return markdown
        ? jsonResponse(markdown)
        : jsonResponse({ detail: "not found" }, 404);
    }
    if (url.endsWith(`/api/agreement-templates/${NDA_ID}/artifacts`)) {
      return jsonResponse(artifacts);
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
    // The catalog redesign uses agreement-templates-row-name for the template
    // name text and agreement-templates-row-link for the "Open template" action.
    // Disambiguate MSA (name vs type chip) via the name testId.
    const names = screen.getAllByTestId("agreement-templates-row-name");
    expect(names.map((n) => n.textContent)).toEqual(
      expect.arrayContaining(["Mutual NDA", "MSA"]),
    );
    // "Open template" links exist for each row.
    const openLinks = screen.getAllByTestId("agreement-templates-row-link");
    expect(openLinks).toHaveLength(2);
    expect(openLinks[0]).toHaveTextContent(/open template/i);
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
    expect(
      await screen.findByText(/Create a template, then upload its DOCX/i),
    ).toBeInTheDocument();
  });

  it("shows 'No archived templates' when archived view is empty", async () => {
    // Return empty list on every call so both the initial fetch and the
    // re-fetch triggered by the archived toggle produce empty results.
    fetchMock.mockImplementation(async () => jsonResponse([]));
    render(
      <MemoryRouter initialEntries={["/agreement-templates"]}>
        <Routes>
          <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText(/Create a template, then upload its DOCX/i);
    // Switch to archived view
    fireEvent.click(screen.getByTestId("agreement-templates-include-archived"));
    const matches = await screen.findAllByText(/No archived templates/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("groups templates by template_type into labeled catalog sections", async () => {
    setupListFetch(fetchMock);
    render(
      <MemoryRouter initialEntries={["/agreement-templates"]}>
        <Routes>
          <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Mutual NDA");
    const headings = screen.getAllByTestId("agreement-templates-group-heading");
    const labels = headings.map((h) => h.textContent);
    expect(labels).toContain("NDA");
    expect(labels).toContain("MSA");
  });

  it("search by name filters the catalog", async () => {
    setupListFetch(fetchMock);
    render(
      <MemoryRouter initialEntries={["/agreement-templates"]}>
        <Routes>
          <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Mutual NDA");

    fireEvent.change(screen.getByTestId("agreement-templates-search"), {
      target: { value: "Mutual" },
    });
    // The MSA group heading should disappear; the dropdown option may still
    // exist but the card/group heading should not.
    const headings = screen.queryAllByTestId("agreement-templates-group-heading");
    expect(headings.map((h) => h.textContent)).not.toContain("MSA");
    expect(screen.getByText("Mutual NDA")).toBeInTheDocument();
  });

  it("filter by type narrows the catalog", async () => {
    setupListFetch(fetchMock);
    render(
      <MemoryRouter initialEntries={["/agreement-templates"]}>
        <Routes>
          <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Mutual NDA");

    fireEvent.change(screen.getByTestId("agreement-templates-filter-type"), {
      target: { value: "NDA" },
    });
    expect(screen.getByText("Mutual NDA")).toBeInTheDocument();
    // MSA group heading should be gone
    const headings = screen.getAllByTestId("agreement-templates-group-heading");
    expect(headings.map((h) => h.textContent)).not.toContain("MSA");
  });

  it("reset filters button restores full catalog", async () => {
    setupListFetch(fetchMock);
    render(
      <MemoryRouter initialEntries={["/agreement-templates"]}>
        <Routes>
          <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Mutual NDA");

    fireEvent.change(screen.getByTestId("agreement-templates-search"), {
      target: { value: "nothing-matches" },
    });
    expect(screen.queryByText("Mutual NDA")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("agreement-templates-reset-filters"));
    expect(await screen.findByText("Mutual NDA")).toBeInTheDocument();
  });

  it("'Use this template' links to the detail page with #generate hash", async () => {
    setupListFetch(fetchMock);
    render(
      <MemoryRouter initialEntries={["/agreement-templates"]}>
        <Routes>
          <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Mutual NDA");
    const useLinks = screen.getAllByTestId("agreement-templates-card-use");
    // Each use link should end with the template id and #generate
    expect(useLinks[0]).toHaveAttribute(
      "href",
      `/requests/templates/${NDA_ID}#generate`,
    );
  });

  it("'Open template' links to the detail page", async () => {
    setupListFetch(fetchMock);
    render(
      <MemoryRouter initialEntries={["/agreement-templates"]}>
        <Routes>
          <Route path="/agreement-templates" element={<AgreementTemplatesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Mutual NDA");
    const openLinks = screen.getAllByTestId("agreement-templates-row-link");
    expect(openLinks[0]).toHaveAttribute(
      "href",
      `/requests/templates/${NDA_ID}`,
    );
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

  // -------------------------------------------------------------------------
  // PR #102 — Source file history section
  // -------------------------------------------------------------------------

  it("renders the Source file history section with the current marker", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    const section = await screen.findByTestId(
      "agreement-template-source-history",
    );
    expect(section).toHaveTextContent(/source file history/i);
    const rows = within(section).getAllByTestId(
      "agreement-template-source-history-row",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-current", "true");
    expect(
      within(rows[0]).getByTestId(
        "agreement-template-source-history-current-chip",
      ),
    ).toHaveTextContent(/current/i);
    expect(rows[0]).toHaveTextContent(/nda\.docx/);
  });

  it("renders multiple source uploads newest-first with the right current marker", async () => {
    const OLDER = {
      ...NDA_ARTIFACT,
      id: "art-old",
      filename: "nda-v1.docx",
      is_official: false,
      created_at: "2026-02-01T00:00:00Z",
    };
    const NEWER = {
      ...NDA_ARTIFACT,
      id: "art-new",
      filename: "nda-v2.docx",
      is_official: true,
      created_at: "2026-04-15T00:00:00Z",
    };
    // Backend returns newest-first; test sends them in mixed order to
    // confirm the page sorts them itself.
    setupDetailFetch(fetchMock, { artifacts: [OLDER, NEWER] });
    renderDetail();
    const section = await screen.findByTestId(
      "agreement-template-source-history",
    );
    const rows = within(section).getAllByTestId(
      "agreement-template-source-history-row",
    );
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0]).toHaveTextContent("nda-v2.docx");
    expect(rows[1]).toHaveTextContent("nda-v1.docx");
    // Current marker only on the most-recent official row.
    expect(rows[0]).toHaveAttribute("data-current", "true");
    expect(rows[1]).toHaveAttribute("data-current", "false");
    expect(
      within(rows[0]).getByTestId(
        "agreement-template-source-history-current-chip",
      ),
    ).toBeInTheDocument();
    expect(
      within(rows[1]).queryByTestId(
        "agreement-template-source-history-current-chip",
      ),
    ).toBeNull();
  });

  it("falls back to the most recent row when no artifact is is_official", async () => {
    const A = {
      ...NDA_ARTIFACT,
      id: "art-a",
      filename: "a.docx",
      is_official: false,
      created_at: "2026-02-01T00:00:00Z",
    };
    const B = {
      ...NDA_ARTIFACT,
      id: "art-b",
      filename: "b.docx",
      is_official: false,
      created_at: "2026-04-01T00:00:00Z",
    };
    setupDetailFetch(fetchMock, { artifacts: [A, B] });
    renderDetail();
    const section = await screen.findByTestId(
      "agreement-template-source-history",
    );
    const rows = within(section).getAllByTestId(
      "agreement-template-source-history-row",
    );
    expect(rows[0]).toHaveTextContent("b.docx");
    expect(rows[0]).toHaveAttribute("data-current", "true");
    expect(rows[1]).toHaveAttribute("data-current", "false");
  });

  it("renders the source-history empty state when no source uploads exist", async () => {
    setupDetailFetch(fetchMock, { artifacts: [] });
    renderDetail();
    expect(
      await screen.findByTestId(
        "agreement-template-source-history-empty",
      ),
    ).toHaveTextContent(/no source file uploads yet/i);
    expect(
      screen.queryByTestId("agreement-template-source-history-list"),
    ).toBeNull();
  });

  it("excludes non-source artifact types from the history section", async () => {
    const GENERATED = {
      ...NDA_ARTIFACT,
      id: "art-gen",
      filename: "nda-generated.docx",
      artifact_type: "generated_docx",
      is_official: false,
    };
    setupDetailFetch(fetchMock, { artifacts: [NDA_ARTIFACT, GENERATED] });
    renderDetail();
    const section = await screen.findByTestId(
      "agreement-template-source-history",
    );
    const rows = within(section).getAllByTestId(
      "agreement-template-source-history-row",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("nda.docx");
  });

  it("renders a Download version button on each source row (PR #103)", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    const section = await screen.findByTestId(
      "agreement-template-source-history",
    );
    const buttons = within(section).getAllByTestId(
      "agreement-template-source-history-download",
    );
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(/download version/i);
  });

  it("downloads via blob URL and revokes it on success (PR #103)", async () => {
    setupDetailFetch(fetchMock);
    // Override fetch to return raw bytes for the download endpoint.
    const realFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith(
          `/api/agreement-templates/${NDA_ID}/artifacts/${NDA_ARTIFACT.id}/download`,
        )
      ) {
        return new Response(new Blob([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="nda.pdf"',
          },
        });
      }
      return realFetch!(url, init);
    });
    const createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    try {
      renderDetail();
      const btn = await screen.findByTestId(
        "agreement-template-source-history-download",
      );
      fireEvent.click(btn);
      await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalled());
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders a per-row error state when the download fails (PR #103)", async () => {
    setupDetailFetch(fetchMock);
    const realFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith(
          `/api/agreement-templates/${NDA_ID}/artifacts/${NDA_ARTIFACT.id}/download`,
        )
      ) {
        return new Response(
          JSON.stringify({ detail: "Template artifact not found." }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return realFetch!(url, init);
    });
    renderDetail();
    const btn = await screen.findByTestId(
      "agreement-template-source-history-download",
    );
    fireEvent.click(btn);
    expect(
      await screen.findByTestId(
        "agreement-template-source-history-download-error",
      ),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // PR #106 — Restore prior source as current
  // -------------------------------------------------------------------------

  it("non-current rows show Restore as current; current row hides it (PR #106)", async () => {
    const OLDER = {
      ...NDA_ARTIFACT,
      id: "art-old",
      filename: "nda-v1.docx",
      is_official: false,
      created_at: "2026-02-01T00:00:00Z",
    };
    const NEWER = {
      ...NDA_ARTIFACT,
      id: "art-new",
      filename: "nda-v2.docx",
      is_official: true,
      created_at: "2026-04-15T00:00:00Z",
    };
    setupDetailFetch(fetchMock, { artifacts: [OLDER, NEWER] });
    renderDetail();
    const section = await screen.findByTestId(
      "agreement-template-source-history",
    );
    const rows = within(section).getAllByTestId(
      "agreement-template-source-history-row",
    );
    // Newest first; current is row 0; restore button only on row 1.
    expect(rows[0]).toHaveAttribute("data-current", "true");
    expect(rows[1]).toHaveAttribute("data-current", "false");
    expect(
      within(rows[0]).queryByTestId(
        "agreement-template-source-history-restore",
      ),
    ).toBeNull();
    expect(
      within(rows[1]).getByTestId(
        "agreement-template-source-history-restore",
      ),
    ).toBeInTheDocument();
  });

  it("Restore is a two-step confirm and Keep current cancels", async () => {
    const OLDER = {
      ...NDA_ARTIFACT,
      id: "art-old",
      filename: "nda-v1.docx",
      is_official: false,
      created_at: "2026-02-01T00:00:00Z",
    };
    const NEWER = {
      ...NDA_ARTIFACT,
      id: "art-new",
      filename: "nda-v2.docx",
      is_official: true,
      created_at: "2026-04-15T00:00:00Z",
    };
    setupDetailFetch(fetchMock, { artifacts: [OLDER, NEWER] });
    renderDetail();
    const section = await screen.findByTestId(
      "agreement-template-source-history",
    );
    const olderRow = within(section).getAllByTestId(
      "agreement-template-source-history-row",
    )[1];
    fireEvent.click(
      within(olderRow).getByTestId(
        "agreement-template-source-history-restore",
      ),
    );
    const confirm = within(olderRow).getByTestId(
      "agreement-template-source-history-restore-confirm",
    );
    // Explainer mentions the three guarantees from the brief.
    expect(confirm).toHaveTextContent(/does not delete/i);
    expect(confirm).toHaveTextContent(/future generated/i);
    expect(confirm).toHaveTextContent(/variables/i);
    // Cancel returns to idle.
    fireEvent.click(
      within(olderRow).getByTestId(
        "agreement-template-source-history-restore-cancel",
      ),
    );
    expect(
      within(olderRow).queryByTestId(
        "agreement-template-source-history-restore-confirm",
      ),
    ).toBeNull();
    expect(
      within(olderRow).getByTestId(
        "agreement-template-source-history-restore",
      ),
    ).toBeInTheDocument();
  });

  it("Confirm Restore POSTs and refreshes the page", async () => {
    const OLDER = {
      ...NDA_ARTIFACT,
      id: "art-old",
      filename: "nda-v1.docx",
      is_official: false,
      created_at: "2026-02-01T00:00:00Z",
    };
    const NEWER = {
      ...NDA_ARTIFACT,
      id: "art-new",
      filename: "nda-v2.docx",
      is_official: true,
      created_at: "2026-04-15T00:00:00Z",
    };
    let restored = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith(
          `/api/agreement-templates/${NDA_ID}/artifacts/art-old/restore`,
        ) &&
        init?.method === "POST"
      ) {
        restored = true;
        return jsonResponse({ ...OLDER, is_official: true });
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/markdown`)) {
        return jsonResponse(NDA_MARKDOWN);
      }
      if (url.endsWith(`/api/agreement-templates/${NDA_ID}/artifacts`)) {
        return jsonResponse(
          restored
            ? [{ ...OLDER, is_official: true }, { ...NEWER, is_official: false }]
            : [OLDER, NEWER],
        );
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
    });
    renderDetail();
    const section = await screen.findByTestId(
      "agreement-template-source-history",
    );
    const olderRow = within(section).getAllByTestId(
      "agreement-template-source-history-row",
    )[1];
    fireEvent.click(
      within(olderRow).getByTestId(
        "agreement-template-source-history-restore",
      ),
    );
    fireEvent.click(
      within(olderRow).getByTestId(
        "agreement-template-source-history-restore-confirm-yes",
      ),
    );
    await waitFor(() => expect(restored).toBe(true));
    // After the page reload, sort is still newest-first (NEWER stays
    // at the top by created_at), but the *Current* marker has moved
    // off the newest row and the older row (nda-v1.docx) is now the
    // official source.
    await waitFor(() => {
      const refreshed = within(
        screen.getByTestId("agreement-template-source-history"),
      ).getAllByTestId("agreement-template-source-history-row");
      expect(refreshed[0]).toHaveTextContent("nda-v2.docx");
      expect(refreshed[0]).toHaveAttribute("data-current", "false");
      expect(refreshed[1]).toHaveTextContent("nda-v1.docx");
      expect(refreshed[1]).toHaveAttribute("data-current", "true");
    });
  });

  it("Restore renders a per-row error state on failure (PR #106)", async () => {
    const OLDER = {
      ...NDA_ARTIFACT,
      id: "art-old",
      filename: "nda-v1.docx",
      is_official: false,
      created_at: "2026-02-01T00:00:00Z",
    };
    const NEWER = {
      ...NDA_ARTIFACT,
      id: "art-new",
      filename: "nda-v2.docx",
      is_official: true,
      created_at: "2026-04-15T00:00:00Z",
    };
    const realFetch = fetchMock.getMockImplementation();
    setupDetailFetch(fetchMock, { artifacts: [OLDER, NEWER] });
    const detailImpl = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith(
          `/api/agreement-templates/${NDA_ID}/artifacts/art-old/restore`,
        ) &&
        init?.method === "POST"
      ) {
        return jsonResponse(
          { detail: "Template artifact not found." },
          404,
        );
      }
      return detailImpl!(url, init);
    });
    // ``realFetch`` is referenced to keep the test self-contained — if
    // a future change rewires the default mock, we still fall back.
    void realFetch;
    renderDetail();
    const section = await screen.findByTestId(
      "agreement-template-source-history",
    );
    const olderRow = within(section).getAllByTestId(
      "agreement-template-source-history-row",
    )[1];
    fireEvent.click(
      within(olderRow).getByTestId(
        "agreement-template-source-history-restore",
      ),
    );
    fireEvent.click(
      within(olderRow).getByTestId(
        "agreement-template-source-history-restore-confirm-yes",
      ),
    );
    expect(
      await within(olderRow).findByTestId(
        "agreement-template-source-history-restore-error",
      ),
    ).toBeInTheDocument();
    // Restore button comes back so the user can retry.
    expect(
      within(olderRow).getByTestId(
        "agreement-template-source-history-restore",
      ),
    ).toBeInTheDocument();
  });

  it("does not leak forbidden artifact-type tokens or storage internals in the DOM", async () => {
    setupDetailFetch(fetchMock, {
      artifacts: [
        {
          ...NDA_ARTIFACT,
          metadata_json: {
            storage_key: "should-not-appear",
            wrapped_dek: "should-not-appear",
            s3_key: "should-not-appear",
            private_url: "https://x",
            presigned: "https://y",
            docuseal_secret: "should-not-appear",
          },
        },
      ],
    });
    renderDetail();
    await screen.findByTestId("agreement-template-source-history");
    const text = document.body.textContent ?? "";
    for (const needle of [
      "storage_key",
      "wrapped_dek",
      "s3_key",
      "metadata_json",
      "private_url",
      "presigned",
      "docuseal_secret",
      "should-not-appear",
      // Raw artifact-type taxonomy must never reach the DOM —
      // labels go through artifactDisplayLabel() instead.
      "original_upload",
      "generated_docx",
    ]) {
      expect(text).not.toContain(needle);
    }
  });
});
