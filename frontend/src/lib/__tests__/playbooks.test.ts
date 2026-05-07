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
  PlaybookValidationError,
  createPlaybook,
  deactivatePlaybook,
  getPlaybook,
  getPlaybooks,
  validatePlaybook,
} from "../api";
import { clearDevUserId, setDevUserId } from "../devUser";
import { __resetMockState } from "../mockApi";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const VALID_YAML =
  'name: "Test Playbook"\nrules:\n  - id: r1\n    title: t\n    clause_type: x\n    severity: low\n    rule_type: required_clause\n';

describe("playbooks api client", () => {
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

  it("getPlaybooks adds include_inactive=true when requested", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await getPlaybooks({ includeInactive: true });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/playbooks?include_inactive=true");
  });

  it("getPlaybooks omits the query string by default", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await getPlaybooks();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/\/api\/playbooks$/);
  });

  it("validatePlaybook posts the YAML string and surfaces the response", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          schema_version: "1.0",
          name: "Test Playbook",
          description: null,
          jurisdiction: null,
          contract_type: null,
          version: "1.0",
          rule_count: 1,
          rules: [
            {
              id: "r1",
              title: "t",
              rule_type: "required_clause",
              clause_type: "x",
              severity: "low",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await validatePlaybook(VALID_YAML);
    expect(result.name).toBe("Test Playbook");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ yaml_source: VALID_YAML });
  });

  it("validatePlaybook surfaces structured 400 errors as PlaybookValidationError", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            ok: false,
            errors: [
              { message: "rule_type missing", path: "rules.0.rule_type" },
              { message: "severity invalid", path: "rules.0.severity" },
            ],
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await validatePlaybook("not really yaml");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlaybookValidationError);
      const v = err as PlaybookValidationError;
      expect(v.issues).toHaveLength(2);
      expect(v.issues[0].path).toBe("rules.0.rule_type");
      // Subclass of ApiError so existing handlers still see status=400.
      expect(v).toBeInstanceOf(ApiError);
      expect(v.status).toBe(400);
    }
  });

  it("createPlaybook returns the persisted playbook detail", async () => {
    setDevUserId(VALID_UUID);
    const persisted = {
      id: "abc",
      name: "Test Playbook",
      description: null,
      jurisdiction: null,
      contract_type: null,
      version: "1.0",
      is_active: true,
      rule_count: 1,
      created_at: "2026-05-07T00:00:00Z",
      updated_at: "2026-05-07T00:00:00Z",
      yaml_source: VALID_YAML,
      parsed_rules: { name: "Test Playbook", rules: [] },
      rules: [],
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(persisted), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await createPlaybook(VALID_YAML);
    expect(result.id).toBe("abc");
    expect(result.name).toBe("Test Playbook");
  });

  it("createPlaybook escalates 400 with PlaybookValidationError", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: { ok: false, errors: [{ message: "bad", path: null }] },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(createPlaybook("garbage")).rejects.toBeInstanceOf(
      PlaybookValidationError,
    );
  });

  it("createPlaybook propagates non-validation 4xx as ApiError", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: "A playbook named 'X' already exists in this organization.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      await createPlaybook(VALID_YAML);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(PlaybookValidationError);
      const e = err as ApiError;
      expect(e.status).toBe(409);
    }
  });

  it("deactivatePlaybook DELETEs the resource", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "abc",
          name: "Test",
          description: null,
          jurisdiction: null,
          contract_type: null,
          version: "1.0",
          is_active: false,
          rule_count: 0,
          created_at: "2026-05-07T00:00:00Z",
          updated_at: "2026-05-07T00:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await deactivatePlaybook("abc");
    expect(result.is_active).toBe(false);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("DELETE");
  });

  it("getPlaybook returns the detail and scrubs secret keys", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "abc",
          name: "Test",
          description: null,
          jurisdiction: null,
          contract_type: null,
          version: "1.0",
          is_active: true,
          rule_count: 0,
          created_at: "2026-05-07T00:00:00Z",
          updated_at: "2026-05-07T00:00:00Z",
          yaml_source: VALID_YAML,
          parsed_rules: { rules: [] },
          rules: [],
          // simulate a regression: backend leaks an s3 key
          s3_key: "should-be-scrubbed",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await getPlaybook("abc");
    expect(result).not.toHaveProperty("s3_key");
    expect(result.id).toBe("abc");
  });

  describe("demo mode", () => {
    it("getPlaybooks returns the static mock list without fetching", async () => {
      vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
      const list = await getPlaybooks();
      expect(list.length).toBeGreaterThan(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("getPlaybooks default hides deactivated playbooks", async () => {
      vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
      const active = await getPlaybooks();
      const all = await getPlaybooks({ includeInactive: true });
      expect(active.length).toBeLessThan(all.length);
      expect(active.every((p) => p.is_active)).toBe(true);
    });

    it("validatePlaybook is intentionally disabled in demo mode", async () => {
      vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
      await expect(validatePlaybook(VALID_YAML)).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("createPlaybook is intentionally disabled in demo mode", async () => {
      vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
      await expect(createPlaybook(VALID_YAML)).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("deactivatePlaybook is intentionally disabled in demo mode", async () => {
      vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
      await expect(deactivatePlaybook("abc")).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
