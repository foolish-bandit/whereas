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
    // empty/loaded state without error noise.
    fetchMock.mockResolvedValue(jsonResponse([]));
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
});
