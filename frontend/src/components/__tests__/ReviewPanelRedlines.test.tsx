import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import ReviewPanel from "../ReviewPanel";
import type { ReviewRunDetail, ReviewRunSummary } from "../../types/findings";
import type { PlaybookSummary } from "../../types/playbooks";
import type { SuggestedRedline } from "../../types/redlines";

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>(
    "../../lib/api",
  );
  return {
    ...actual,
    getPlaybooks: vi.fn(),
    listPlaybookReviewRuns: vi.fn(),
    getPlaybookReviewRun: vi.fn(),
    createPlaybookReviewRun: vi.fn(),
    updateFindingStatus: vi.fn(),
    generateRedline: vi.fn(),
    listRedlines: vi.fn(),
    updateRedlineStatus: vi.fn(),
  };
});

import {
  createPlaybookReviewRun,
  generateRedline,
  getPlaybookReviewRun,
  getPlaybooks,
  listPlaybookReviewRuns,
  listRedlines,
  updateFindingStatus,
  updateRedlineStatus,
} from "../../lib/api";

const PLAYBOOK_ID = "00000000-0000-4000-8000-000000000111";
const CONTRACT_ID = "00000000-0000-4000-8000-000000000222";
const RUN_ID = "00000000-0000-4000-8000-000000000333";
const FINDING_ID = "00000000-0000-4000-8000-000000000444";
const REDLINE_ID = "00000000-0000-4000-8000-000000000555";

const PLAYBOOK_SUMMARY: PlaybookSummary = {
  id: PLAYBOOK_ID,
  name: "NDA Review Playbook",
  description: null,
  jurisdiction: "California",
  contract_type: "mutual_nda",
  version: "1.0",
  is_active: true,
  rule_count: 1,
  created_at: "2026-05-07T00:00:00Z",
  updated_at: "2026-05-07T00:00:00Z",
};

const RUN_SUMMARY: ReviewRunSummary = {
  id: RUN_ID,
  organization_id: "00000000-0000-4000-8000-0000000000aa",
  contract_id: CONTRACT_ID,
  playbook_id: PLAYBOOK_ID,
  playbook_name: PLAYBOOK_SUMMARY.name,
  rules_checked: 1,
  passed_count: 0,
  failed_count: 1,
  created_at: "2026-05-07T01:00:00Z",
};

const EVIDENCE_TEXT =
  "Either party may assign this Agreement at its sole discretion.";

const RUN_DETAIL: ReviewRunDetail = {
  ...RUN_SUMMARY,
  findings: [
    {
      id: FINDING_ID,
      organization_id: RUN_SUMMARY.organization_id,
      contract_id: CONTRACT_ID,
      playbook_id: PLAYBOOK_ID,
      review_run_id: RUN_ID,
      rule_id: "assignment-consent",
      rule_title: "Assignment should require consent",
      rule_type: "text_contains",
      clause_type: "assignment",
      severity: "medium",
      status: "fail",
      finding_status: "open",
      message: "Assignment clause does not include 'consent'.",
      clause_id: "00000000-0000-4000-8000-0000000000bb",
      evidence_text: EVIDENCE_TEXT,
      span_start: 100,
      span_end: 100 + EVIDENCE_TEXT.length,
      matched_terms: ["consent"],
      expected_value: null,
      guidance: null,
      preferred_language: null,
      created_at: "2026-05-07T01:00:00Z",
      updated_at: "2026-05-07T01:00:00Z",
    },
  ],
  results: [
    {
      rule_id: "assignment-consent",
      title: "Assignment should require consent",
      rule_type: "text_contains",
      clause_type: "assignment",
      severity: "medium",
      status: "fail",
      message: "Assignment clause does not include 'consent'.",
      clause_id: "00000000-0000-4000-8000-0000000000bb",
      clause_ordinal: 0,
      clause_heading: null,
      evidence_text: EVIDENCE_TEXT,
      span_start: 100,
      span_end: 100 + EVIDENCE_TEXT.length,
      matched_terms: ["consent"],
      expected_value: null,
      description: null,
      guidance: null,
      preferred_language: null,
    },
  ],
};

const SUGGESTED_TEXT =
  "Neither party may assign this Agreement without the prior written consent of the other.";

const REDLINE: SuggestedRedline = {
  id: REDLINE_ID,
  organization_id: RUN_SUMMARY.organization_id,
  contract_id: CONTRACT_ID,
  finding_id: FINDING_ID,
  redline_text: SUGGESTED_TEXT,
  rationale: "Adds the required consent language.",
  model_name: "ollama/llama3.1:70b",
  prompt_version: "redline-v1",
  confidence: 0.82,
  status: "proposed",
  created_by: null,
  created_at: "2026-05-07T01:00:30Z",
  updated_at: "2026-05-07T01:00:30Z",
};

describe("ReviewPanel — suggested redlines", () => {
  beforeEach(() => {
    vi.mocked(getPlaybooks).mockResolvedValue([PLAYBOOK_SUMMARY]);
    vi.mocked(listPlaybookReviewRuns).mockResolvedValue([RUN_SUMMARY]);
    vi.mocked(getPlaybookReviewRun).mockResolvedValue(RUN_DETAIL);
    vi.mocked(createPlaybookReviewRun).mockResolvedValue(RUN_DETAIL);
    vi.mocked(updateFindingStatus).mockResolvedValue(RUN_DETAIL.findings[0]);
    vi.mocked(listRedlines).mockResolvedValue([]);
    vi.mocked(generateRedline).mockResolvedValue(REDLINE);
    vi.mocked(updateRedlineStatus).mockImplementation(
      async (_c, _f, _r, status) => ({ ...REDLINE, status }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the redline section header but not the panel until generated", async () => {
    render(
      <ReviewPanel
        contractId={CONTRACT_ID}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    await screen.findByText("Assignment should require consent");
    expect(screen.getByText("Suggested redline")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /suggest redline/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(SUGGESTED_TEXT)).toBeNull();
  });

  it("generates a redline and renders its text + confidence + rationale", async () => {
    render(
      <ReviewPanel
        contractId={CONTRACT_ID}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    await screen.findByText("Assignment should require consent");
    fireEvent.click(screen.getByRole("button", { name: /suggest redline/i }));
    await waitFor(() => {
      expect(screen.getByText(SUGGESTED_TEXT)).toBeInTheDocument();
    });
    expect(generateRedline).toHaveBeenCalledWith(CONTRACT_ID, FINDING_ID);
    expect(screen.getByText(/confidence 82%/)).toBeInTheDocument();
    expect(
      screen.getByText("Adds the required consent language."),
    ).toBeInTheDocument();
    // Status starts as "Proposed".
    expect(screen.getByText("Proposed")).toBeInTheDocument();
  });

  it("transitions the redline through accept and reject", async () => {
    render(
      <ReviewPanel
        contractId={CONTRACT_ID}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    await screen.findByText("Assignment should require consent");
    fireEvent.click(screen.getByRole("button", { name: /suggest redline/i }));
    await screen.findByText(SUGGESTED_TEXT);

    fireEvent.click(screen.getByRole("button", { name: /^accept$/i }));
    await waitFor(() =>
      expect(screen.getByText("Accepted")).toBeInTheDocument(),
    );
    expect(updateRedlineStatus).toHaveBeenLastCalledWith(
      CONTRACT_ID,
      FINDING_ID,
      REDLINE_ID,
      "accepted",
    );

    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    await waitFor(() =>
      expect(screen.getByText("Rejected")).toBeInTheDocument(),
    );
  });

  it("regeneration prepends the new suggestion and keeps prior under history", async () => {
    const second: SuggestedRedline = {
      ...REDLINE,
      id: "00000000-0000-4000-8000-000000000777",
      redline_text:
        "Neither party shall assign without the other party's prior written consent.",
      confidence: 0.71,
      created_at: "2026-05-07T01:01:00Z",
      updated_at: "2026-05-07T01:01:00Z",
    };
    vi.mocked(generateRedline)
      .mockResolvedValueOnce(REDLINE)
      .mockResolvedValueOnce(second);

    render(
      <ReviewPanel
        contractId={CONTRACT_ID}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    await screen.findByText("Assignment should require consent");
    fireEvent.click(screen.getByRole("button", { name: /suggest redline/i }));
    await screen.findByText(SUGGESTED_TEXT);
    // The button label flips to "Regenerate" once a redline exists.
    fireEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    await waitFor(() =>
      expect(screen.getByText(second.redline_text)).toBeInTheDocument(),
    );
    // Prior suggestion is still in the DOM (as collapsed history).
    expect(screen.getByText(SUGGESTED_TEXT)).toBeInTheDocument();
  });
});
