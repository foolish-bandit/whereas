import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import ReviewPanel from "../ReviewPanel";
import type { ReviewRunDetail, ReviewRunSummary } from "../../types/findings";
import type { PlaybookSummary } from "../../types/playbooks";

// Mock the API surface so the component can mount with deterministic
// data. Tests interact with the rendered DOM only.
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
  };
});

import {
  createPlaybookReviewRun,
  getPlaybookReviewRun,
  getPlaybooks,
  listPlaybookReviewRuns,
  updateFindingStatus,
} from "../../lib/api";

const PLAYBOOK_ID = "00000000-0000-4000-8000-000000000111";
const CONTRACT_ID = "00000000-0000-4000-8000-000000000222";
const RUN_ID = "00000000-0000-4000-8000-000000000333";
const FINDING_ID = "00000000-0000-4000-8000-000000000444";

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
  rules_checked: 2,
  passed_count: 0,
  failed_count: 2,
  created_at: "2026-05-07T01:00:00Z",
};

const PREFERRED_LANGUAGE_BLOCK =
  "This Agreement shall be governed by the laws of the State of California, without regard to conflict of laws principles.";
const GUIDANCE_TEXT =
  "We require California governing law for this contract type. Substitute the firm-preferred clause below verbatim.";

function makeRun(overrides: Partial<ReviewRunDetail> = {}): ReviewRunDetail {
  return {
    ...RUN_SUMMARY,
    findings: [
      {
        id: FINDING_ID,
        organization_id: RUN_SUMMARY.organization_id,
        contract_id: CONTRACT_ID,
        playbook_id: PLAYBOOK_ID,
        review_run_id: RUN_ID,
        rule_id: "governing-law-california",
        rule_title: "Governing law should be California",
        rule_type: "preferred_value",
        clause_type: "governing_law",
        severity: "medium",
        status: "fail",
        finding_status: "open",
        message:
          "Preferred value 'California' not found in any 'governing_law' clause.",
        clause_id: null,
        evidence_text: null,
        span_start: null,
        span_end: null,
        matched_terms: [],
        expected_value: "California",
        guidance: GUIDANCE_TEXT,
        preferred_language: PREFERRED_LANGUAGE_BLOCK,
        created_at: "2026-05-07T01:00:00Z",
        updated_at: "2026-05-07T01:00:00Z",
      },
      {
        id: "no-guidance-finding-id",
        organization_id: RUN_SUMMARY.organization_id,
        contract_id: CONTRACT_ID,
        playbook_id: PLAYBOOK_ID,
        review_run_id: RUN_ID,
        rule_id: "bare-rule",
        rule_title: "Bare rule with no firm guidance",
        rule_type: "required_clause",
        clause_type: "indemnity",
        severity: "low",
        status: "fail",
        finding_status: "open",
        message:
          "No clause of type 'indemnity' was found in the contract.",
        clause_id: null,
        evidence_text: null,
        span_start: null,
        span_end: null,
        matched_terms: [],
        expected_value: null,
        guidance: null,
        preferred_language: null,
        created_at: "2026-05-07T01:00:00Z",
        updated_at: "2026-05-07T01:00:00Z",
      },
    ],
    results: [
      {
        rule_id: "governing-law-california",
        title: "Governing law should be California",
        rule_type: "preferred_value",
        clause_type: "governing_law",
        severity: "medium",
        status: "fail",
        message:
          "Preferred value 'California' not found in any 'governing_law' clause.",
        clause_id: null,
        clause_ordinal: null,
        clause_heading: null,
        evidence_text: null,
        span_start: null,
        span_end: null,
        matched_terms: [],
        expected_value: "California",
        description: null,
        guidance: GUIDANCE_TEXT,
        preferred_language: PREFERRED_LANGUAGE_BLOCK,
      },
      {
        rule_id: "bare-rule",
        title: "Bare rule with no firm guidance",
        rule_type: "required_clause",
        clause_type: "indemnity",
        severity: "low",
        status: "fail",
        message: "No clause of type 'indemnity' was found in the contract.",
        clause_id: null,
        clause_ordinal: null,
        clause_heading: null,
        evidence_text: null,
        span_start: null,
        span_end: null,
        matched_terms: [],
        expected_value: null,
        description: null,
        guidance: null,
        preferred_language: null,
      },
    ],
    ...overrides,
  };
}

describe("ReviewPanel — playbook guidance", () => {
  beforeEach(() => {
    vi.mocked(getPlaybooks).mockResolvedValue([PLAYBOOK_SUMMARY]);
    vi.mocked(listPlaybookReviewRuns).mockResolvedValue([RUN_SUMMARY]);
    vi.mocked(getPlaybookReviewRun).mockResolvedValue(makeRun());
    vi.mocked(createPlaybookReviewRun).mockResolvedValue(makeRun());
    vi.mocked(updateFindingStatus).mockImplementation(
      async (_contractId, findingId, status) => {
        const run = makeRun();
        const finding = run.findings.find((f) => f.id === findingId);
        if (!finding) throw new Error("test setup error");
        return { ...finding, finding_status: status };
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the firm-authored guidance and preferred language for a failed finding", async () => {
    render(
      <ReviewPanel
        contractId={CONTRACT_ID}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText("Governing law should be California"),
      ).toBeInTheDocument(),
    );

    const guidanceSection = await screen.findByLabelText("Playbook guidance");
    expect(guidanceSection).toBeInTheDocument();
    expect(guidanceSection).toHaveTextContent(GUIDANCE_TEXT);
    expect(guidanceSection).toHaveTextContent(
      "This Agreement shall be governed by the laws of the State of California",
    );
    expect(guidanceSection).toHaveTextContent("California");
  });

  it("does not render a Playbook guidance section for a finding with no firm-authored fields", async () => {
    render(
      <ReviewPanel
        contractId={CONTRACT_ID}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );

    await screen.findByText("Governing law should be California");
    await screen.findByText("Bare rule with no firm guidance");

    const sections = screen.getAllByLabelText("Playbook guidance");
    expect(sections).toHaveLength(1);
  });

  it("preserves the reviewer status buttons alongside the guidance section", async () => {
    render(
      <ReviewPanel
        contractId={CONTRACT_ID}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );

    await screen.findByLabelText("Playbook guidance");

    expect(
      screen.getAllByRole("button", { name: /mark reviewed/i }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: /mark ignored/i }).length,
    ).toBeGreaterThan(0);
  });

  it("renders matched terms inside the guidance section when present", async () => {
    const customRun = makeRun({
      findings: [
        {
          id: FINDING_ID,
          organization_id: RUN_SUMMARY.organization_id,
          contract_id: CONTRACT_ID,
          playbook_id: PLAYBOOK_ID,
          review_run_id: RUN_ID,
          rule_id: "assignment-consent",
          rule_title: "Assignment requires consent",
          rule_type: "text_contains",
          clause_type: "assignment",
          severity: "medium",
          status: "fail",
          finding_status: "open",
          message: "Clause is missing some required terms.",
          clause_id: null,
          evidence_text: null,
          span_start: null,
          span_end: null,
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
          title: "Assignment requires consent",
          rule_type: "text_contains",
          clause_type: "assignment",
          severity: "medium",
          status: "fail",
          message: "Clause is missing some required terms.",
          clause_id: null,
          clause_ordinal: null,
          clause_heading: null,
          evidence_text: null,
          span_start: null,
          span_end: null,
          matched_terms: ["consent"],
          expected_value: null,
          description: null,
          guidance: null,
          preferred_language: null,
        },
      ],
      passed_count: 0,
      failed_count: 1,
      rules_checked: 1,
    });
    vi.mocked(getPlaybookReviewRun).mockResolvedValue(customRun);

    render(
      <ReviewPanel
        contractId={CONTRACT_ID}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );

    const section = await screen.findByLabelText("Playbook guidance");
    expect(section).toHaveTextContent(/Matched terms:/);
    expect(section).toHaveTextContent("consent");
  });

  it("uses persisted playbook findings as the only review source and exposes remediation", async () => {
    render(
      <ReviewPanel
        contractId={CONTRACT_ID}
        selectedKey={null}
        onSelect={() => {}}
        clauses={[]}
        extractedFields={[]}
      />,
    );

    await screen.findByText("Governing law should be California");
    expect(
      screen.queryByTestId("deterministic-review-findings"),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /plan remediation/i }),
    ).toHaveLength(2);
  });
});
