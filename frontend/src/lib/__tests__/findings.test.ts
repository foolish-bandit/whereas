import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import {
  ApiError,
  MissingDevUserError,
  createPlaybookReviewRun,
  getPlaybookReviewRun,
  listContractFindings,
  listPlaybookReviewRuns,
  updateFindingStatus,
} from "../api";
import { clearDevUserId, setDevUserId } from "../devUser";
import {
  __resetMockState,
  createPlaybookReviewRun as mockCreate,
  getPlaybookReviewRun as mockGetRun,
  listContractFindings as mockListFindings,
  listPlaybookReviewRuns as mockListRuns,
  updateFindingStatus as mockUpdate,
} from "../mockApi";
import { MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID } from "../mockData";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("persisted-review API client (live mode)", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    clearDevUserId();
    vi.unstubAllEnvs();
    __resetMockState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearDevUserId();
    __resetMockState();
  });

  it("createPlaybookReviewRun throws MissingDevUserError before fetch", async () => {
    await expect(createPlaybookReviewRun("c", "p")).rejects.toBeInstanceOf(
      MissingDevUserError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createPlaybookReviewRun POSTs to the runs endpoint with playbook_id", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "r1",
          organization_id: "o",
          contract_id: "c1",
          playbook_id: "p1",
          playbook_name: "n",
          rules_checked: 0,
          passed_count: 0,
          failed_count: 0,
          created_at: "2026-05-07T00:00:00Z",
          findings: [],
          results: [],
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await createPlaybookReviewRun("c1", "p1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/contracts/c1/playbook-review/runs");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ playbook_id: "p1" });
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get("X-Whereas-Dev-User")).toBe(VALID_UUID);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("listPlaybookReviewRuns GETs the runs endpoint", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await listPlaybookReviewRuns("c1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/contracts/c1/playbook-review/runs");
    expect((init as RequestInit).method).toBe("GET");
  });

  it("getPlaybookReviewRun GETs the run-detail endpoint", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "r1",
          organization_id: "o",
          contract_id: "c1",
          playbook_id: "p1",
          playbook_name: "n",
          rules_checked: 0,
          passed_count: 0,
          failed_count: 0,
          created_at: "2026-05-07T00:00:00Z",
          findings: [],
          results: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await getPlaybookReviewRun("c1", "r1");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/contracts/c1/playbook-review/runs/r1");
  });

  it("listContractFindings serialises filters to the query string", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await listContractFindings("c1", {
      playbook_id: "p1",
      finding_status: "open",
      severity: "high",
      include_superseded: true,
    });
    const [url] = fetchMock.mock.calls[0];
    const u = new URL(url as string);
    expect(u.pathname).toBe("/api/contracts/c1/findings");
    expect(u.searchParams.get("playbook_id")).toBe("p1");
    expect(u.searchParams.get("finding_status")).toBe("open");
    expect(u.searchParams.get("severity")).toBe("high");
    expect(u.searchParams.get("include_superseded")).toBe("true");
  });

  it("listContractFindings omits empty filters", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await listContractFindings("c1");
    const [url] = fetchMock.mock.calls[0];
    expect(typeof url).toBe("string");
    expect((url as string).endsWith("/api/contracts/c1/findings")).toBe(true);
  });

  it("updateFindingStatus PATCHes with the new status", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "f1",
          organization_id: "o",
          contract_id: "c1",
          playbook_id: "p1",
          review_run_id: "r1",
          rule_id: "x",
          rule_title: "x",
          rule_type: "required_clause",
          clause_type: "x",
          severity: "low",
          status: "fail",
          finding_status: "reviewed",
          message: "x",
          clause_id: null,
          evidence_text: null,
          span_start: null,
          span_end: null,
          matched_terms: [],
          expected_value: null,
          guidance: null,
          preferred_language: null,
          created_at: "2026-05-07T00:00:00Z",
          updated_at: "2026-05-07T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await updateFindingStatus("c1", "f1", "reviewed");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/contracts/c1/findings/f1");
    expect((init as RequestInit).method).toBe("PATCH");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ finding_status: "reviewed" });
  });

  it("createPlaybookReviewRun maps a 404 to ApiError", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Playbook not found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      createPlaybookReviewRun("c1", "p1"),
    ).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });

  it("createPlaybookReviewRun maps a 409 to ApiError", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: "Contract has no segmented clauses." }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(
      createPlaybookReviewRun("c1", "p1"),
    ).rejects.toMatchObject({ name: "ApiError", status: 409 });
  });

  it("scrubs storage/encryption keys from the response defensively", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "r1",
          organization_id: "o",
          contract_id: "c1",
          playbook_id: "p1",
          playbook_name: "n",
          rules_checked: 0,
          passed_count: 0,
          failed_count: 0,
          created_at: "2026-05-07T00:00:00Z",
          findings: [],
          results: [],
          wrapped_dek: "leaked",
          s3_key: "leaked",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    const run = await createPlaybookReviewRun("c1", "p1");
    expect(run).not.toHaveProperty("wrapped_dek");
    expect(run).not.toHaveProperty("s3_key");
  });
});

describe("persisted-review mock API (demo mode)", () => {
  beforeEach(() => {
    __resetMockState();
  });
  afterEach(() => {
    __resetMockState();
  });

  it("createPlaybookReviewRun persists findings and surfaces the run", async () => {
    const run = await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    expect(run.contract_id).toBe(MOCK_NDA_ID);
    expect(run.playbook_id).toBe(MOCK_NDA_PLAYBOOK_ID);
    expect(run.results).toHaveLength(3);
    expect(run.findings).toHaveLength(2);
    expect(run.passed_count).toBe(1);
    expect(run.failed_count).toBe(2);
  });

  it("listPlaybookReviewRuns returns the runs created during this session", async () => {
    await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    const runs = await mockListRuns(MOCK_NDA_ID);
    expect(runs).toHaveLength(2);
  });

  it("rerun supersedes prior open findings", async () => {
    const first = await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    const old = await mockGetRun(MOCK_NDA_ID, first.id);
    expect(old.findings.every((f) => f.finding_status === "superseded")).toBe(
      true,
    );
  });

  it("updateFindingStatus mutates the in-memory finding", async () => {
    const run = await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    const finding = run.findings[0];
    const updated = await mockUpdate(MOCK_NDA_ID, finding.id, "reviewed");
    expect(updated.finding_status).toBe("reviewed");
    const refetched = await mockListFindings(MOCK_NDA_ID, {
      finding_status: "reviewed",
    });
    expect(refetched.map((f) => f.id)).toContain(finding.id);
  });

  it("listContractFindings excludes superseded by default", async () => {
    await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    const findings = await mockListFindings(MOCK_NDA_ID);
    expect(findings.every((f) => f.finding_status !== "superseded")).toBe(
      true,
    );
  });

  it("listContractFindings can include superseded when asked", async () => {
    await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    const findings = await mockListFindings(MOCK_NDA_ID, {
      include_superseded: true,
    });
    expect(findings.some((f) => f.finding_status === "superseded")).toBe(
      true,
    );
  });

  it("does not call fetch in demo mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await mockCreate(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

void ApiError;
