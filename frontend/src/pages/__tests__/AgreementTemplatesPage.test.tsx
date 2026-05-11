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
  opts: { markdown?: object | null } = {},
) {
  const markdown = "markdown" in opts ? opts.markdown : NDA_MARKDOWN;
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

  function renderDetail() {
    return render(
      <MemoryRouter initialEntries={[`/agreement-templates/${NDA_ID}`]}>
        <Routes>
          <Route
            path="/agreement-templates/:id"
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

    fireEvent.click(
      screen.getByTestId("agreement-template-generate-submit"),
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

  it("disables the generate button when required variables are blank", async () => {
    setupDetailFetch(fetchMock);
    renderDetail();
    await screen.findByTestId("agreement-template-markdown-body");

    const button = screen.getByTestId("agreement-template-generate-submit");
    expect(button).toBeDisabled();

    fireEvent.change(
      screen.getByTestId("agreement-template-generate-input-counterparty_name"),
      { target: { value: "Acme" } },
    );
    expect(button).not.toBeDisabled();
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
