import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import App from "../App";
import { clearDevUserId, setDevUserId } from "../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const SAMPLE_REQUEST = {
  id: "req-1",
  organization_id: "org-1",
  title: "NDA with Acme",
  description: null,
  request_type: "new_contract",
  contract_type: "NDA",
  status: "open",
  priority: "normal",
  requester_name: null,
  requester_email: null,
  counterparty_name: "Acme",
  due_date: null,
  assigned_to: null,
  linked_contract_id: null,
  linked_template_id: null,
  created_at: "2026-05-08T16:00:00Z",
  updated_at: "2026-05-08T16:00:00Z",
  created_by: null,
  metadata_json: null,
};

const EMPTY_APPROVAL_STATUS = {
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
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The router-level tests below mount the full App on a MemoryRouter
 * to verify the consolidated /demo/* URL space:
 *
 *   - /demo/contracts and /demo/repository both render the same
 *     repository workspace.
 *   - /demo/approvals renders the new landing page with cards.
 *   - /demo/approvals?workflow_id=<id> still resolves to the
 *     workflows page so PR #60/#61 deep links keep working.
 *   - /demo/approval-workflows / /demo/approval-templates /
 *     /demo/approval-policies remain reachable.
 *   - /demo/requests/templates renders the agreement templates page.
 *   - /demo/clause-manager and /demo/clause-library both render.
 *
 * The backend is mocked at the fetch boundary; the goal here is
 * navigation/aliasing, not list behavior.
 */
describe("App routing — UI consolidation pass", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    // Default to a friendly response so list pages can render an
    // empty/loaded state without error noise. Use mockImplementation
    // so each call gets a fresh Response object — needed because
    // multiple consumers (e.g. Sidebar + page) may both fetch in the
    // same test, and a Response body can only be read once.
    fetchMock.mockImplementation(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(DEV_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  }

  it("renders the repository workspace at /demo/repository", async () => {
    renderAt("/demo/repository");
    await waitFor(() =>
      expect(screen.getByTestId("repository-page")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: /repository/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it("renders the repository workspace at the legacy /demo/contracts alias", async () => {
    renderAt("/demo/contracts");
    await waitFor(() =>
      expect(screen.getByTestId("repository-page")).toBeInTheDocument(),
    );
  });

  it("renders the Approvals landing page at /demo/approvals", async () => {
    renderAt("/demo/approvals");
    expect(await screen.findByTestId("approvals-landing")).toBeInTheDocument();
    expect(screen.getByTestId("approvals-card-tasks")).toBeInTheDocument();
    expect(screen.getByTestId("approvals-card-workflows")).toBeInTheDocument();
    expect(screen.getByTestId("approvals-card-templates")).toBeInTheDocument();
    expect(screen.getByTestId("approvals-card-policies")).toBeInTheDocument();
  });

  it("forwards /demo/approvals?workflow_id=<id> to the workflows view so existing deep links still work", async () => {
    renderAt("/demo/approvals?workflow_id=wf-123");
    // The workflows page renders the "approvals-page" test id;
    // the landing page renders "approvals-landing".
    await waitFor(() =>
      expect(screen.getByTestId("approvals-page")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("approvals-landing")).toBeNull();
  });

  it("still serves the legacy /demo/approval-workflows route", async () => {
    renderAt("/demo/approval-workflows");
    await waitFor(() =>
      expect(screen.getByTestId("approvals-page")).toBeInTheDocument(),
    );
  });

  it("still serves the legacy /demo/approval-templates route", async () => {
    renderAt("/demo/approval-templates");
    await waitFor(() =>
      expect(screen.getByTestId("approval-templates-page")).toBeInTheDocument(),
    );
  });

  it("still serves the legacy /demo/approval-policies route", async () => {
    renderAt("/demo/approval-policies");
    await waitFor(() =>
      expect(screen.getByTestId("approval-policies-page")).toBeInTheDocument(),
    );
  });

  it("renders agreement templates at /demo/requests/templates (nested under Requests)", async () => {
    renderAt("/demo/requests/templates");
    await waitFor(() =>
      expect(
        screen.getByTestId("agreement-templates-page"),
      ).toBeInTheDocument(),
    );
  });

  it("renders the Clause Manager workspace at /demo/clause-manager and the legacy /demo/clause-library", async () => {
    renderAt("/demo/clause-manager");
    await waitFor(() =>
      expect(screen.getByTestId("clause-manager-page")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: /clause manager/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it("renders the Clause Manager at the legacy /demo/clause-library route", async () => {
    renderAt("/demo/clause-library");
    await waitFor(() =>
      expect(screen.getByTestId("clause-manager-page")).toBeInTheDocument(),
    );
  });

  it("renders the Requests workspace cards on /demo/requests", async () => {
    renderAt("/demo/requests");
    await waitFor(() =>
      expect(screen.getByTestId("requests-page")).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("requests-workspace-cards"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("requests-card-start-from-template"),
    ).toHaveAttribute("href", "/demo/requests/templates");
    expect(
      screen.getByTestId("requests-card-manage-templates"),
    ).toHaveAttribute("href", "/demo/requests/templates");
  });

  it("keeps demo Request list links under /demo/requests/:id", async () => {
    fetchMock.mockImplementation(async () => jsonResponse([SAMPLE_REQUEST]));
    renderAt("/demo/requests");
    expect(await screen.findByTestId("request-title-link")).toHaveAttribute(
      "href",
      "/demo/requests/req-1",
    );
    expect(screen.getByTestId("request-view-link")).toHaveAttribute(
      "href",
      "/demo/requests/req-1",
    );
  });

  it("renders the normal Requests list at /requests", async () => {
    renderAt("/requests");
    await waitFor(() =>
      expect(screen.getByTestId("requests-page")).toBeInTheDocument(),
    );
  });

  it("preserves request_id auto-expand on the normal /requests?request_id route", async () => {
    renderAt("/requests?request_id=req-missing");
    await waitFor(() =>
      expect(screen.getByTestId("requests-page")).toBeInTheDocument(),
    );
    expect(
      await screen.findByTestId("requests-deep-link-not-found"),
    ).toHaveTextContent("req-missing");
  });

  it("renders the normal Request detail route at /requests/:id", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(EMPTY_APPROVAL_STATUS);
      }
      if (url.endsWith("/api/requests/req-1/activity")) {
        return jsonResponse({ items: [] });
      }
      if (url.endsWith("/api/requests/req-1")) {
        return jsonResponse(SAMPLE_REQUEST);
      }
      return jsonResponse([]);
    });
    renderAt("/requests/req-1");
    expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "NDA with Acme" })).toBeInTheDocument();
  });

  it("also renders the demo Request detail route at /demo/requests/:id", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/requests/req-1/approval-status")) {
        return jsonResponse(EMPTY_APPROVAL_STATUS);
      }
      if (url.endsWith("/api/requests/req-1/activity")) {
        return jsonResponse({ items: [] });
      }
      if (url.endsWith("/api/requests/req-1")) {
        return jsonResponse(SAMPLE_REQUEST);
      }
      return jsonResponse([]);
    });
    renderAt("/demo/requests/req-1");
    expect(await screen.findByTestId("request-detail-page")).toBeInTheDocument();
  });

  it("still serves the legacy /demo/agreement-templates route", async () => {
    renderAt("/demo/agreement-templates");
    await waitFor(() =>
      expect(
        screen.getByTestId("agreement-templates-page"),
      ).toBeInTheDocument(),
    );
  });

  it("still serves the legacy /demo/inbox route", async () => {
    renderAt("/demo/inbox");
    await waitFor(() =>
      expect(screen.getByTestId("inbox-page")).toBeInTheDocument(),
    );
  });

  it("renders the Repository upload flow at /demo/upload (target of the Inbox classification-modal real-mode link)", async () => {
    renderAt("/demo/upload");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^upload$/i, level: 1 }),
      ).toBeInTheDocument(),
    );
  });

  it("renders the new /demo/approvals/workflows route", async () => {
    renderAt("/demo/approvals/workflows");
    await waitFor(() =>
      expect(screen.getByTestId("approvals-page")).toBeInTheDocument(),
    );
  });

  it("renders the new /demo/approvals/workflows/:id detail route (PR #98)", async () => {
    renderAt("/demo/approvals/workflows/wf-deep-detail");
    // The detail page starts in loading state — the loading testId
    // is enough to confirm the route resolved to the right component.
    await waitFor(() =>
      expect(
        screen.getByTestId("approval-workflow-detail-loading"),
      ).toBeInTheDocument(),
    );
  });

  it("renders the new /demo/approvals/tasks/:id detail route (PR #99)", async () => {
    renderAt("/demo/approvals/tasks/task-deep-detail");
    await waitFor(() =>
      expect(
        screen.getByTestId("approval-task-detail-loading"),
      ).toBeInTheDocument(),
    );
  });

  it("renders the new /demo/approvals/templates route", async () => {
    renderAt("/demo/approvals/templates");
    await waitFor(() =>
      expect(screen.getByTestId("approval-templates-page")).toBeInTheDocument(),
    );
  });

  it("renders the new /demo/approvals/policies route", async () => {
    renderAt("/demo/approvals/policies");
    await waitFor(() =>
      expect(screen.getByTestId("approval-policies-page")).toBeInTheDocument(),
    );
  });

  it("renders the new /demo/approvals/tasks route (Approval Tasks)", async () => {
    renderAt("/demo/approvals/tasks");
    await waitFor(() =>
      expect(screen.getByTestId("approval-tasks-page")).toBeInTheDocument(),
    );
  });

  it("preserves workflow_id when forwarding /approvals to /approvals/workflows", async () => {
    renderAt("/demo/approvals?workflow_id=wf-deep");
    await waitFor(() =>
      expect(screen.getByTestId("approvals-page")).toBeInTheDocument(),
    );
    // The not-found notice is the most reliable observable that the query
    // string survived the forward — the workflows page reads
    // ?workflow_id= and renders this when the id isn't in the list.
    expect(
      await screen.findByTestId("approvals-deep-link-not-found"),
    ).toHaveTextContent("wf-deep");
  });

  it("preserves request_id auto-expand on the legacy /requests?request_id route", async () => {
    renderAt("/demo/requests?request_id=req-missing");
    await waitFor(() =>
      expect(screen.getByTestId("requests-page")).toBeInTheDocument(),
    );
    expect(
      await screen.findByTestId("requests-deep-link-not-found"),
    ).toHaveTextContent("req-missing");
  });

  it("preserves policy_id deep link on /approval-policies", async () => {
    renderAt("/demo/approval-policies?policy_id=apol-missing");
    await waitFor(() =>
      expect(screen.getByTestId("approval-policies-page")).toBeInTheDocument(),
    );
    expect(
      await screen.findByTestId("approval-policies-deep-link-not-found"),
    ).toHaveTextContent("apol-missing");
  });

  it("renders the Intake page at /demo/intake", async () => {
    renderAt("/demo/intake");
    await waitFor(() =>
      expect(screen.getByTestId("intake-page")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("heading", { name: /intake/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it("renders all five intake action cards at /demo/intake", async () => {
    renderAt("/demo/intake");
    await waitFor(() =>
      expect(screen.getByTestId("intake-page")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("intake-card-upload")).toBeInTheDocument();
    expect(screen.getByTestId("intake-card-request")).toBeInTheDocument();
    expect(screen.getByTestId("intake-card-templates")).toBeInTheDocument();
    expect(screen.getByTestId("intake-card-inbox")).toBeInTheDocument();
    expect(screen.getByTestId("intake-card-approvals")).toBeInTheDocument();
  });

  it("renders the Intake page at the standalone /intake route", async () => {
    renderAt("/intake");
    await waitFor(() =>
      expect(screen.getByTestId("intake-page")).toBeInTheDocument(),
    );
  });

  it("highlights Intake in the sidebar when at /demo/intake", async () => {
    renderAt("/demo/intake");
    await waitFor(() =>
      expect(screen.getByTestId("intake-page")).toBeInTheDocument(),
    );
    // There are two sidebar-nav elements (desktop + mobile drawer);
    // check both — the active link should appear in at least one.
    const navs = screen.getAllByTestId("sidebar-nav");
    const activeIntakeLinks = navs.flatMap((nav) =>
      Array.from(nav.querySelectorAll('a[href="/demo/intake"]')),
    );
    expect(activeIntakeLinks.length).toBeGreaterThan(0);
    expect(activeIntakeLinks[0].className).toMatch(/font-medium/);
  });
});
