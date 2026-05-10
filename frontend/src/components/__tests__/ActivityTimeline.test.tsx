import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ActivityTimeline from "../ActivityTimeline";
import { clearDevUserId, setDevUserId } from "../../lib/devUser";

const DEV_USER = "11111111-1111-4111-8111-111111111111";

const SAMPLE_ITEMS = [
  {
    id: "ev-3",
    event_type: "approval.workflow.completed",
    occurred_at: "2026-05-09T08:00:00Z",
    actor_user_id: null,
    title: "Approval workflow completed: Legal approval",
    description: null,
    request_id: "req-1",
    contract_id: null,
    workflow_run_id: "wf-1",
    approval_step_id: null,
    step_order: null,
    source: "ad_hoc",
  },
  {
    id: "ev-2",
    event_type: "approval.step.approved",
    occurred_at: "2026-05-09T07:00:00Z",
    actor_user_id: null,
    title: "Step approved: Legal review",
    description: "Step 1",
    request_id: "req-1",
    contract_id: null,
    workflow_run_id: "wf-1",
    approval_step_id: "step-1",
    step_order: 1,
    source: "ad_hoc",
  },
  {
    id: "ev-1",
    event_type: "approval.workflow.created",
    occurred_at: "2026-05-09T06:00:00Z",
    actor_user_id: null,
    title: "Approval workflow created: Legal approval",
    description: null,
    request_id: "req-1",
    contract_id: null,
    workflow_run_id: "wf-1",
    approval_step_id: null,
    step_order: null,
    source: "ad_hoc",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ActivityTimeline", () => {
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

  it("renders items in the order returned by the server", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: SAMPLE_ITEMS }));
    render(<ActivityTimeline kind="request" requestId="req-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("activity-timeline")).toBeInTheDocument(),
    );
    const titles = screen
      .getAllByTestId("activity-timeline-title")
      .map((el) => el.textContent);
    expect(titles).toEqual([
      "Approval workflow completed: Legal approval",
      "Step approved: Legal review",
      "Approval workflow created: Legal approval",
    ]);
  });

  it("renders the empty state when no items", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    render(<ActivityTimeline kind="request" requestId="req-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("activity-timeline-empty")).toBeInTheDocument(),
    );
  });

  it("renders a safe error state on fetch failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));
    render(<ActivityTimeline kind="request" requestId="req-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("activity-timeline-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("activity-timeline-error")).toHaveTextContent(
      /boom|server failed/i,
    );
  });

  it("uses the contract endpoint when kind=contract", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/contracts/contract-1/activity")) {
        return jsonResponse({ items: SAMPLE_ITEMS.slice(0, 1) });
      }
      return jsonResponse({ detail: "unexpected " + url }, 500);
    });
    render(<ActivityTimeline kind="contract" contractId="contract-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("activity-timeline")).toBeInTheDocument(),
    );
    expect(screen.getAllByTestId("activity-timeline-item")).toHaveLength(1);
  });

  it("does not render storage internals in the DOM", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: SAMPLE_ITEMS }));
    render(<ActivityTimeline kind="request" requestId="req-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("activity-timeline")).toBeInTheDocument(),
    );
    expect(document.body.textContent ?? "").not.toContain("storage_key");
    expect(document.body.textContent ?? "").not.toContain("wrapped_dek");
    expect(document.body.textContent ?? "").not.toContain("s3_key");
    expect(document.body.textContent ?? "").not.toContain("decision_note");
  });
});
