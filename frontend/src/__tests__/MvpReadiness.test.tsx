/**
 * PR #107 — MVP Readiness Audit
 *
 * Cross-cutting checks that, for every top-level route in the product:
 *   1. The route resolves to the intended page (smoke).
 *   2. The rendered DOM contains none of the FORBIDDEN_DOM_TOKENS
 *      (storage internals, signed URLs, raw artifact slot tokens,
 *      raw metadata_json, DocuSeal secrets).
 *   3. User-facing copy uses Repository / Text preview vocabulary —
 *      i.e. legacy "Markdown preview" copy never reaches the DOM.
 *
 * Individual page tests already cover narrower forbidden-string scans;
 * this file is the centralized backstop so a new page (or a regression
 * in an existing one) can't leak a sensitive token without something
 * red turning up here.
 */
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
import {
  FORBIDDEN_DOM_TOKENS,
  expectNoForbiddenTokens,
} from "../test/forbiddenTokens";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * True if the URL looks like a single-resource detail endpoint —
 * i.e. .../api/<collection>/<id>(/sub-resource)? — versus the bare
 * collection listing. Used to flip detail-page fetches to 404 so the
 * page lands in its error state without trying to render undefined.
 */
function isDetailEndpoint(url: string): boolean {
  const match = url.match(/\/api\/[^/?]+\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!match) return false;
  const id = match[1];
  // The base collection segment doesn't match here because of the
  // captured `[^/?]+/` prefix. Anything after the slash counts as a
  // detail id, including UUIDs, slugs, and our "*-missing" sentinels.
  return id.length > 0 && id !== "summary";
}

const MINIMAL_DASHBOARD_SUMMARY = {
  counts: {
    open_requests: 0,
    in_progress_requests: 0,
    urgent_or_high_priority_requests: 0,
    open_inbox_items: 0,
    overdue_inbox_items: 0,
    contracts_total: 0,
    contracts_sent_for_signature: 0,
    contracts_executed: 0,
    templates_active: 0,
    active_approval_workflows: 0,
    pending_approval_steps: 0,
    overdue_approval_steps: 0,
    active_approval_workflow_templates: 0,
  },
  upcoming: {
    requests_due_soon: [],
    inbox_items_due_soon: [],
  },
  recent_activity: {
    recent_contracts: [],
    recent_requests: [],
    recent_signed_contracts: [],
  },
  approval_analytics: {
    pending_steps: 0,
    overdue_steps: 0,
    active_workflows: 0,
    completed_workflows: 0,
    rejected_workflows: 0,
    cancelled_workflows: 0,
    workflows_completed_last_30_days: 0,
    workflows_rejected_last_30_days: 0,
    pending_by_assignee: [],
    oldest_pending_steps: [],
  },
};

describe("PR #107 — MVP readiness audit", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    // Route fetches by URL shape:
    //   - Single-resource detail endpoints (.../<id>) → 404 so the page
    //     flips to its error state without trying to render undefined
    //     shapes. The page's wrapper testid stays mounted either way.
    //   - The dashboard summary endpoint needs a minimal valid shape
    //     because the page renders summary.upcoming / summary.counts
    //     unconditionally once the fetch resolves.
    //   - Everything else gets ``[]`` (the typical list endpoint).
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/dashboard/summary")) {
        return jsonResponse(MINIMAL_DASHBOARD_SUMMARY);
      }
      if (isDetailEndpoint(url)) {
        return jsonResponse({ detail: "not found" }, 404);
      }
      return jsonResponse([]);
    });
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

  // ---------------------------------------------------------------------
  // Route smoke + DOM-hygiene matrix.
  //
  // Each entry exercises one route the MVP demo path depends on. The
  // ``ready`` test id is the deterministic signal that the page
  // resolved (either fully loaded or rendered its loading skeleton).
  // ---------------------------------------------------------------------
  const ROUTES: { path: string; readyTestId: string; label: string }[] = [
    { path: "/demo/dashboard", readyTestId: "dashboard-page", label: "Dashboard" },
    { path: "/demo/repository", readyTestId: "repository-page", label: "Repository" },
    { path: "/demo/contracts", readyTestId: "repository-page", label: "Repository (legacy /contracts)" },
    { path: "/demo/requests", readyTestId: "requests-page", label: "Requests" },
    { path: "/demo/requests/templates", readyTestId: "agreement-templates-page", label: "Agreement Templates" },
    { path: "/demo/approvals", readyTestId: "approvals-landing", label: "Approvals landing" },
    { path: "/demo/approvals/workflows", readyTestId: "approvals-page", label: "Approval Workflows" },
    { path: "/demo/approvals/templates", readyTestId: "approval-templates-page", label: "Approval Templates" },
    { path: "/demo/approvals/policies", readyTestId: "approval-policies-page", label: "Approval Policies" },
    { path: "/demo/approvals/tasks", readyTestId: "approval-tasks-page", label: "Approval Tasks" },
    { path: "/demo/clause-manager", readyTestId: "clause-manager-page", label: "Clause Manager" },
    { path: "/demo/clause-library", readyTestId: "clause-manager-page", label: "Clause Manager (legacy)" },
    { path: "/demo/playbooks", readyTestId: "playbooks-page", label: "Playbooks" },
    { path: "/demo/settings", readyTestId: "settings-page", label: "Settings" },
    { path: "/requests", readyTestId: "requests-page", label: "Standalone /requests" },
    { path: "/requests/templates", readyTestId: "agreement-templates-page", label: "Standalone /requests/templates" },
  ];

  for (const route of ROUTES) {
    it(`route ${route.path} resolves to the ${route.label} page and leaks no forbidden tokens`, async () => {
      const { unmount } = renderAt(route.path);
      await waitFor(() =>
        expect(screen.getByTestId(route.readyTestId)).toBeInTheDocument(),
      );
      expectNoForbiddenTokens(document.body.textContent);
      // Legacy Markdown-preview phrasing must never reach the DOM —
      // the canonical label is "Text preview".
      expect(document.body.textContent ?? "").not.toMatch(
        /markdown preview/i,
      );
      unmount();
    });
  }

  // ---------------------------------------------------------------------
  // Detail-route smoke. These pages start in a loading skeleton state
  // when the backend returns empty/404; the testid asserts the route
  // resolved to the right component.
  // ---------------------------------------------------------------------
  const DETAIL_ROUTES: { path: string; readyTestId: string; label: string }[] = [
    {
      path: "/demo/repository/contract-missing",
      readyTestId: "contract-workspace-loading",
      label: "Repository contract workspace",
    },
    {
      path: "/demo/requests/templates/tmpl-missing",
      readyTestId: "agreement-template-detail",
      label: "Agreement template detail",
    },
    {
      path: "/demo/requests/req-missing",
      readyTestId: "request-detail-loading",
      label: "Request detail",
    },
    {
      path: "/demo/approvals/workflows/wf-missing",
      readyTestId: "approval-workflow-detail-loading",
      label: "Approval workflow detail",
    },
    {
      path: "/demo/approvals/tasks/task-missing",
      readyTestId: "approval-task-detail-loading",
      label: "Approval task detail",
    },
  ];

  for (const route of DETAIL_ROUTES) {
    it(`detail route ${route.path} resolves to the ${route.label} page`, async () => {
      const { unmount } = renderAt(route.path);
      await waitFor(() =>
        expect(screen.getByTestId(route.readyTestId)).toBeInTheDocument(),
      );
      expectNoForbiddenTokens(document.body.textContent);
      unmount();
    });
  }

  // ---------------------------------------------------------------------
  // Sanity: the canonical token list itself is non-empty and stable.
  // A future PR shrinking this list should be intentional.
  // ---------------------------------------------------------------------
  it("FORBIDDEN_DOM_TOKENS list covers the documented MVP categories", () => {
    expect(FORBIDDEN_DOM_TOKENS).toContain("storage_key");
    expect(FORBIDDEN_DOM_TOKENS).toContain("wrapped_dek");
    expect(FORBIDDEN_DOM_TOKENS).toContain("s3_key");
    expect(FORBIDDEN_DOM_TOKENS).toContain("private_url");
    expect(FORBIDDEN_DOM_TOKENS).toContain("presigned_url");
    expect(FORBIDDEN_DOM_TOKENS).toContain("metadata_json");
    expect(FORBIDDEN_DOM_TOKENS).toContain("original_upload");
    expect(FORBIDDEN_DOM_TOKENS).toContain("generated_docx");
    expect(FORBIDDEN_DOM_TOKENS).toContain("signed_pdf");
    expect(FORBIDDEN_DOM_TOKENS).toContain("redline_docx");
    expect(FORBIDDEN_DOM_TOKENS).toContain("docuseal_webhook_secret");
  });
});
