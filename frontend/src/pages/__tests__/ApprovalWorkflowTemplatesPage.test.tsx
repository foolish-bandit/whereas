import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ApprovalWorkflowTemplatesPage from "../ApprovalWorkflowTemplatesPage";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const SAMPLE_STEP_1 = {
  id: "wftpl-step-1",
  organization_id: "org-1",
  workflow_template_id: "tmpl-1",
  step_order: 1,
  title: "Legal review",
  description: null,
  approver_name: "Legal Team",
  approver_email: "legal@example.com",
  assigned_to: null,
  due_in_days: 3,
  metadata_json: null,
  created_at: "2026-05-09T12:00:00Z",
  updated_at: "2026-05-09T12:00:00Z",
};

const SAMPLE_STEP_2 = {
  ...SAMPLE_STEP_1,
  id: "wftpl-step-2",
  step_order: 2,
  title: "Finance review",
  approver_email: "finance@example.com",
  due_in_days: 5,
};

const SAMPLE_TEMPLATE = {
  id: "tmpl-1",
  organization_id: "org-1",
  name: "Standard Legal Review",
  description: "One legal approver, then finance",
  template_type: "legal_review",
  status: "active" as const,
  created_at: "2026-05-09T12:00:00Z",
  updated_at: "2026-05-09T12:00:00Z",
  created_by: null,
  metadata_json: null,
  steps: [SAMPLE_STEP_1, SAMPLE_STEP_2],
};

const SAMPLE_RUN_FROM_INSTANTIATE = {
  id: "wf-1",
  organization_id: "org-1",
  name: "Legal approval for Acme NDA",
  status: "active" as const,
  request_id: "req-1",
  contract_id: null,
  template_id: null,
  current_step_order: 1,
  started_at: "2026-05-09T12:00:00Z",
  completed_at: null,
  created_at: "2026-05-09T12:00:00Z",
  updated_at: "2026-05-09T12:00:00Z",
  created_by: null,
  metadata_json: {
    source_workflow_template_id: SAMPLE_TEMPLATE.id,
    source_workflow_template_name: SAMPLE_TEMPLATE.name,
  },
  steps: [
    {
      id: "step-1",
      organization_id: "org-1",
      workflow_run_id: "wf-1",
      step_order: 1,
      title: "Legal review",
      description: null,
      approver_name: "Legal Team",
      approver_email: "legal@example.com",
      assigned_to: null,
      status: "pending",
      decision_note: null,
      decided_at: null,
      due_date: "2026-05-12",
      inbox_item_id: "inbox-1",
      created_at: "2026-05-09T12:00:00Z",
      updated_at: "2026-05-09T12:00:00Z",
      metadata_json: null,
    },
    {
      id: "step-2",
      organization_id: "org-1",
      workflow_run_id: "wf-1",
      step_order: 2,
      title: "Finance review",
      description: null,
      approver_name: null,
      approver_email: "finance@example.com",
      assigned_to: null,
      status: "pending",
      decision_note: null,
      decided_at: null,
      due_date: "2026-05-14",
      inbox_item_id: null,
      created_at: "2026-05-09T12:00:00Z",
      updated_at: "2026-05-09T12:00:00Z",
      metadata_json: null,
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/approval-templates"]}>
      <Routes>
        <Route
          path="/approval-templates"
          element={<ApprovalWorkflowTemplatesPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ApprovalWorkflowTemplatesPage", () => {
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

  it("renders the create form and an empty state when no templates exist", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage();
    expect(
      await screen.findByText(/No approval templates yet/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("approval-templates-create")).toBeInTheDocument();
  });

  it("lists templates and excludes archived by default", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("include_archived=true")) {
        return jsonResponse([
          SAMPLE_TEMPLATE,
          { ...SAMPLE_TEMPLATE, id: "tmpl-2", name: "Archived", status: "archived" },
        ]);
      }
      // Default list — server filters out archived.
      return jsonResponse([SAMPLE_TEMPLATE]);
    });
    renderPage();
    expect(
      await screen.findByText(SAMPLE_TEMPLATE.name),
    ).toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("approval-templates-include-archived"));
    expect(await screen.findByText("Archived")).toBeInTheDocument();
  });

  it("creates a template with steps", async () => {
    let listed: typeof SAMPLE_TEMPLATE[] = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (
        url.endsWith("/api/approval-workflow-templates") &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(init.body as string);
        const created = {
          ...SAMPLE_TEMPLATE,
          id: "tmpl-new",
          name: body.name,
          steps: body.steps.map(
            (s: { title: string; due_in_days?: number | null }, idx: number) => ({
              ...SAMPLE_STEP_1,
              id: `wftpl-step-new-${idx + 1}`,
              step_order: idx + 1,
              title: s.title,
              due_in_days: s.due_in_days ?? null,
            }),
          ),
        };
        listed = [created, ...listed];
        return jsonResponse(created, 201);
      }
      if (url.includes("/api/approval-workflow-templates")) {
        return jsonResponse(listed);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText(/No approval templates yet/i);

    fireEvent.change(screen.getByTestId("approval-templates-name"), {
      target: { value: "New Template" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Step 1 title/i), {
      target: { value: "Legal review" },
    });

    fireEvent.click(screen.getByTestId("approval-templates-create-submit"));

    expect(await screen.findByText("New Template")).toBeInTheDocument();
  });

  it("instantiates a template and shows the run id success state", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (
        url.includes("/api/approval-workflow-templates/tmpl-1/instantiate") &&
        init?.method === "POST"
      ) {
        return jsonResponse(SAMPLE_RUN_FROM_INSTANTIATE, 201);
      }
      if (url.includes("/api/approval-workflow-templates")) {
        return jsonResponse([SAMPLE_TEMPLATE]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText(SAMPLE_TEMPLATE.name);

    fireEvent.click(screen.getByTestId("approval-templates-toggle-detail"));

    fireEvent.change(
      screen.getByTestId("approval-templates-instantiate-name"),
      { target: { value: "Legal approval for Acme NDA" } },
    );
    fireEvent.change(
      screen.getByTestId("approval-templates-instantiate-request"),
      { target: { value: "req-1" } },
    );

    fireEvent.click(
      screen.getByTestId("approval-templates-instantiate-submit"),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("approval-templates-instantiate-success"),
      ).toHaveTextContent(SAMPLE_RUN_FROM_INSTANTIATE.id.slice(0, 8));
    });
  });

  it("archives a template via the archive action", async () => {
    let archived = false;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/tmpl-1") && init?.method === "DELETE") {
        archived = true;
        return jsonResponse({ ...SAMPLE_TEMPLATE, status: "archived" });
      }
      if (url.includes("/api/approval-workflow-templates")) {
        return jsonResponse(archived ? [] : [SAMPLE_TEMPLATE]);
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    renderPage();
    await screen.findByText(SAMPLE_TEMPLATE.name);

    fireEvent.click(screen.getByTestId("approval-templates-archive"));

    await waitFor(() => {
      expect(screen.queryByText(SAMPLE_TEMPLATE.name)).not.toBeInTheDocument();
    });
  });

  it("renders an error state when the list request fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
    renderPage();
    expect(
      await screen.findByTestId("approval-templates-error"),
    ).toHaveTextContent(/boom|server failed/i);
  });

  it("does not render storage internals in the DOM", async () => {
    fetchMock.mockResolvedValue(jsonResponse([SAMPLE_TEMPLATE]));
    renderPage();
    await screen.findByText(SAMPLE_TEMPLATE.name);
    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("wrapped_dek");
    expect(document.body.textContent ?? "").not.toContain("s3_key");
  });
});
