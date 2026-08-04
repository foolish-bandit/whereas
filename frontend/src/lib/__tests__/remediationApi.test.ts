import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviationFinding } from "../../types/findings";
import type { FindingRemediationPlan } from "../../types/remediation";
import {
  __resetRemediationDemoState,
  createFindingRemediationTask,
  getFindingRemediationPlan,
} from "../remediationApi";
import { MissingDevUserError } from "../api";

const CONTRACT_ID = "00000000-0000-4000-8000-000000000001";
const FINDING_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";

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
  evidence_text: "PRIVATE EVIDENCE",
  span_start: 0,
  span_end: 16,
  matched_terms: [],
  expected_value: "California",
  guidance: "Use approved language.",
  preferred_language: "APPROVED LEGAL TEXT",
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
  suggested_language: FINDING.preferred_language,
  source_type: "playbook_preferred_language",
  source_id: FINDING.playbook_id,
  source_name: FINDING.rule_title,
  rationale: "Firm-authored preferred language was stored with this rule.",
  scope_warning: null,
  existing_task: null,
};

describe("remediationApi", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    __resetRemediationDemoState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("calls the tenant-authenticated live endpoint and forwards abort signals", async () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "false");
    window.localStorage.setItem("whereas.devUserId", USER_ID);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(PLAN), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = await getFindingRemediationPlan(CONTRACT_ID, FINDING, {
      signal: controller.signal,
    });

    expect(result).toEqual(PLAN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://localhost:8000/api/contracts/${CONTRACT_ID}/findings/${FINDING_ID}/remediation`,
    );
    expect(init.method).toBe("GET");
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get("X-Whereas-Dev-User")).toBe(USER_ID);
  });

  it("refuses a live request when no development user is configured", async () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "false");
    vi.stubGlobal("fetch", vi.fn());

    await expect(
      getFindingRemediationPlan(CONTRACT_ID, FINDING),
    ).rejects.toBeInstanceOf(MissingDevUserError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses approved demo language without network access", async () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getFindingRemediationPlan(CONTRACT_ID, FINDING);

    expect(result.suggested_language).toBe(FINDING.preferred_language);
    expect(result.source_type).toBe("playbook_preferred_language");
    expect(result.source_id).toBe(FINDING.playbook_id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses one demo task and keeps legal text out of task metadata", async () => {
    vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");

    const first = await createFindingRemediationTask(
      CONTRACT_ID,
      FINDING,
      {},
    );
    const second = await createFindingRemediationTask(
      CONTRACT_ID,
      FINDING,
      {},
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(second.plan.existing_task?.id).toBe(first.task.id);
    const metadata = JSON.stringify(first.task.metadata_json);
    expect(metadata).toContain(FINDING_ID);
    expect(metadata).not.toContain("PRIVATE EVIDENCE");
    expect(metadata).not.toContain("APPROVED LEGAL TEXT");
  });
});
