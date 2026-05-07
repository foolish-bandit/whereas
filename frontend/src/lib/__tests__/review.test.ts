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
  reviewContractWithPlaybook,
} from "../api";
import { clearDevUserId, setDevUserId } from "../devUser";
import {
  __resetMockState,
  reviewContractWithPlaybook as mockReview,
} from "../mockApi";
import { MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID } from "../mockData";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("reviewContractWithPlaybook (live mode)", () => {
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

  it("throws MissingDevUserError before calling fetch when no dev user is set", async () => {
    await expect(
      reviewContractWithPlaybook("c", "p"),
    ).rejects.toBeInstanceOf(MissingDevUserError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to /api/contracts/{id}/playbook-review with the playbook id", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          playbook_id: "p1",
          playbook_name: "n",
          contract_id: "c1",
          rules_checked: 0,
          passed_count: 0,
          failed_count: 0,
          results: [],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await reviewContractWithPlaybook("c1", "p1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/contracts/c1/playbook-review");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ playbook_id: "p1" });
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get("X-Whereas-Dev-User")).toBe(VALID_UUID);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("maps 404 to ApiError", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Playbook not found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      reviewContractWithPlaybook("c1", "p1"),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Playbook not found.",
    });
  });

  it("maps 409 to ApiError with detail", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: "Contract has no segmented clauses to review yet.",
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await expect(
      reviewContractWithPlaybook("c1", "p1"),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
    });
  });

  it("scrubs storage/encryption keys from the response defensively", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          playbook_id: "p1",
          playbook_name: "n",
          contract_id: "c1",
          rules_checked: 0,
          passed_count: 0,
          failed_count: 0,
          results: [],
          // Should never appear, but scrub belt-and-suspenders.
          wrapped_dek: "leaked",
          s3_key: "leaked",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await reviewContractWithPlaybook("c1", "p1");
    expect(result).not.toHaveProperty("wrapped_dek");
    expect(result).not.toHaveProperty("s3_key");
  });
});

describe("mockApi.reviewContractWithPlaybook (demo mode)", () => {
  beforeEach(() => {
    __resetMockState();
  });

  afterEach(() => {
    __resetMockState();
  });

  it("returns the canned NDA review with 1 pass and 2 fails", async () => {
    const result = await mockReview(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    expect(result.contract_id).toBe(MOCK_NDA_ID);
    expect(result.playbook_id).toBe(MOCK_NDA_PLAYBOOK_ID);
    expect(result.rules_checked).toBe(3);
    expect(result.passed_count).toBe(1);
    expect(result.failed_count).toBe(2);
    expect(result.results).toHaveLength(3);
    const passed = result.results.filter((r) => r.status === "pass");
    expect(passed).toHaveLength(1);
    expect(passed[0].rule_id).toBe("confidentiality-definition-required");
  });

  it("includes evidence spans on the rules that have a matching clause", async () => {
    const result = await mockReview(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
    const conf = result.results.find(
      (r) => r.rule_id === "confidentiality-definition-required",
    );
    expect(conf).toBeDefined();
    expect(typeof conf!.span_start).toBe("number");
    expect(typeof conf!.span_end).toBe("number");
    const gov = result.results.find(
      (r) => r.rule_id === "governing-law-california",
    );
    expect(gov).toBeDefined();
    // The fail surfaces the governing-law clause as evidence.
    expect(typeof gov!.span_start).toBe("number");
    // Assignment had no matching clause; no evidence.
    const assign = result.results.find(
      (r) => r.rule_id === "assignment-consent-required",
    );
    expect(assign).toBeDefined();
    expect(assign!.span_start).toBeNull();
    expect(assign!.clause_id).toBeNull();
  });

  it("404s when contract does not exist", async () => {
    await expect(mockReview("does-not-exist", MOCK_NDA_PLAYBOOK_ID))
      .rejects.toMatchObject({
        name: "ApiError",
        status: 404,
      });
  });

  it("404s when playbook does not exist", async () => {
    await expect(mockReview(MOCK_NDA_ID, "does-not-exist"))
      .rejects.toMatchObject({
        name: "ApiError",
        status: 404,
      });
  });

  it("does not call fetch in demo mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await mockReview(MOCK_NDA_ID, MOCK_NDA_PLAYBOOK_ID);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// `ApiError` import is intentional even though TypeScript's narrowing
// satisfies most uses via toMatchObject — keeping the import asserts
// the symbol still ships from `../api` for downstream consumers.
void ApiError;
