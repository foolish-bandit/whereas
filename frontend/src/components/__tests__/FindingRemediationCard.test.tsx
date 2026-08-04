import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { DeviationFinding } from "../../types/findings";
import type {
  FindingRemediationPlan,
  FindingRemediationTaskResponse,
} from "../../types/remediation";

vi.mock("../../lib/remediationApi", () => ({
  getFindingRemediationPlan: vi.fn(),
  createFindingRemediationTask: vi.fn(),
}));

import FindingRemediationCard from "../FindingRemediationCard";
import {
  createFindingRemediationTask,
  getFindingRemediationPlan,
} from "../../lib/remediationApi";

const CONTRACT_ID = "00000000-0000-4000-8000-000000000001";
const FINDING_ID = "00000000-0000-4000-8000-000000000002";
const TASK_ID = "00000000-0000-4000-8000-000000000003";

const FINDING: DeviationFinding = {
  id: FINDING_ID,
  organization_id: "00000000-0000-4000-8000-000000000004",
  contract_id: CONTRACT_ID,
  playbook_id: "00000000-0000-4000-8000-000000000005",
  review_run_id: "00000000-0000-4000-8000-000000000006",
  rule_id: "governing-law-california",
  rule_title: "Governing law should be California",
  rule_type: "preferred_value",
  clause_type: "governing_law",
  severity: "high",
  status: "fail",
  finding_status: "open",
  message: "California was not found.",
  clause_id: null,
  evidence_text: "This Agreement is governed by New York law.",
  span_start: 0,
  span_end: 45,
  matched_terms: [],
  expected_value: "California",
  guidance: "Use the firm's approved position.",
  preferred_language:
    "This Agreement is governed by the laws of the State of California.",
  created_at: "2026-08-04T08:00:00Z",
  updated_at: "2026-08-04T08:00:00Z",
};

const PLAN: FindingRemediationPlan = {
  finding_id: FINDING_ID,
  contract_id: CONTRACT_ID,
  review_run_id: FINDING.review_run_id,
  playbook_id: FINDING.playbook_id,
  rule_id: FINDING.rule_id,
  rule_title: FINDING.rule_title,
  clause_type: FINDING.clause_type,
  severity: FINDING.severity,
  finding_status: FINDING.finding_status,
  suggested_language:
    "This Agreement is governed by the laws of the State of California.",
  source_type: "clause_template",
  source_id: "00000000-0000-4000-8000-000000000007",
  source_name: "California MSA Governing Law",
  rationale: "Selected because it is tagged preferred.",
  scope_warning:
    "This source is scoped to California and MSA records. Confirm fit before use.",
  existing_task: null,
};

const TASK = {
  id: TASK_ID,
  organization_id: FINDING.organization_id,
  title: "Remediate: Governing law should be California",
  description: "Review the finding.",
  item_type: "finding_remediation",
  status: "open",
  priority: "high",
  assigned_to: "00000000-0000-4000-8000-000000000008",
  due_date: null,
  request_id: null,
  contract_id: CONTRACT_ID,
  template_id: null,
  created_at: "2026-08-04T08:01:00Z",
  updated_at: "2026-08-04T08:01:00Z",
  created_by: "00000000-0000-4000-8000-000000000008",
  metadata_json: {
    finding_id: FINDING_ID,
    source_type: "clause_template",
  },
};

function taskResponse(
  overrides: Partial<FindingRemediationTaskResponse> = {},
): FindingRemediationTaskResponse {
  return {
    plan: { ...PLAN, existing_task: TASK },
    task: TASK,
    created: true,
    reopened: false,
    ...overrides,
  };
}

describe("FindingRemediationCard", () => {
  beforeEach(() => {
    vi.mocked(getFindingRemediationPlan).mockResolvedValue(PLAN);
    vi.mocked(createFindingRemediationTask).mockResolvedValue(taskResponse());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads lazily, explains provenance, copies explicitly, and creates one Inbox task", async () => {
    render(
      <FindingRemediationCard contractId={CONTRACT_ID} finding={FINDING} />,
    );

    expect(getFindingRemediationPlan).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: /plan remediation/i }),
    );

    expect(
      await screen.findByText("California MSA Governing Law"),
    ).toBeInTheDocument();
    expect(getFindingRemediationPlan).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/tagged preferred/i)).toBeInTheDocument();
    expect(screen.getByText(/confirm fit before use/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        "This Agreement is governed by the laws of the State of California.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /copy language/i }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        PLAN.suggested_language,
      ),
    );
    expect(await screen.findByText("Copied")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /create inbox task/i }),
    );
    expect(await screen.findByText("Task created")).toBeInTheDocument();
    expect(createFindingRemediationTask).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("link", { name: /open in inbox/i }),
    ).toHaveAttribute("href", `/demo/inbox?item_id=${TASK_ID}`);
  });

  it("keeps task creation available when no approved language exists", async () => {
    vi.mocked(getFindingRemediationPlan).mockResolvedValue({
      ...PLAN,
      suggested_language: null,
      source_type: "none",
      source_id: null,
      source_name: null,
      scope_warning: null,
      rationale:
        "No approved language source matches this finding. Add preferred language to the playbook rule or Clause Manager.",
    });

    render(
      <FindingRemediationCard contractId={CONTRACT_ID} finding={FINDING} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /plan remediation/i }),
    );

    expect(
      await screen.findByText(/no approved language is available yet/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /copy language/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create inbox task/i }),
    ).toBeEnabled();
  });

  it("shows existing work without creating a duplicate", async () => {
    vi.mocked(getFindingRemediationPlan).mockResolvedValue({
      ...PLAN,
      existing_task: { ...TASK, status: "completed" },
    });

    render(
      <FindingRemediationCard contractId={CONTRACT_ID} finding={FINDING} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /plan remediation/i }),
    );

    expect(await screen.findByText(/task completed/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /create inbox task/i }),
    ).not.toBeInTheDocument();
    expect(createFindingRemediationTask).not.toHaveBeenCalled();
  });

  it("does not offer remediation work for a superseded finding", async () => {
    const supersededFinding = {
      ...FINDING,
      finding_status: "superseded" as const,
    };
    vi.mocked(getFindingRemediationPlan).mockResolvedValue({
      ...PLAN,
      finding_status: "superseded",
    });

    render(
      <FindingRemediationCard
        contractId={CONTRACT_ID}
        finding={supersededFinding}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /plan remediation/i }),
    );

    expect(
      await screen.findByText(/open the latest review run/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /create inbox task/i }),
    ).not.toBeInTheDocument();
    expect(createFindingRemediationTask).not.toHaveBeenCalled();
  });

  it("can retry a failed plan request", async () => {
    vi.mocked(getFindingRemediationPlan)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(PLAN);

    render(
      <FindingRemediationCard contractId={CONTRACT_ID} finding={FINDING} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /plan remediation/i }),
    );

    expect(
      await screen.findByText(/could not load the remediation plan/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(
      await screen.findByText("California MSA Governing Law"),
    ).toBeInTheDocument();
    expect(getFindingRemediationPlan).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight request when the card unmounts", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(getFindingRemediationPlan).mockImplementation(
      async (_contractId, _finding, options) => {
        capturedSignal = options?.signal;
        return new Promise<FindingRemediationPlan>(() => undefined);
      },
    );

    const view = render(
      <FindingRemediationCard contractId={CONTRACT_ID} finding={FINDING} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /plan remediation/i }),
    );
    await waitFor(() => expect(capturedSignal).toBeDefined());

    view.unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });
});