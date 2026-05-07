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
  createDevSetup,
  downloadContract,
  getContract,
  getContracts,
  getSetupStatus,
  uploadContract,
} from "../api";
import { clearDevUserId, setDevUserId } from "../devUser";
import { __resetMockState } from "../mockApi";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("api client", () => {
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
    await expect(getContracts()).rejects.toBeInstanceOf(MissingDevUserError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes X-Whereas-Dev-User on every call", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await getContracts();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Headers;
    expect(headers.get("X-Whereas-Dev-User")).toBe(VALID_UUID);
  });

  it("maps non-2xx responses with structured detail to ApiError", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Contract not found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(getContract("abc")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Contract not found.",
    });
  });

  it("maps 401 to a friendly default message when no detail is provided", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    try {
      await getContracts();
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.message).toBe(
        "The development user ID is missing or invalid.",
      );
    }
  });

  it("handles object-shaped detail (e.g., upload duplicate response)", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            message: "This organization has already uploaded this file.",
            existing_contract_id: "abc",
          },
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await expect(
      uploadContract({ file: new File(["a"], "a.pdf"), title: "t" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "This organization has already uploaded this file.",
    });
  });

  it("converts network errors into a non-throwing ApiError", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(getContracts()).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
    });
  });

  it("scrubs known secret keys from list responses", async () => {
    setDevUserId(VALID_UUID);
    const payload = [
      {
        id: "1",
        title: "MSA",
        status: "ready",
        mime_type: "application/pdf",
        file_hash_sha256: "abc",
        page_count: 3,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        // simulate a regression where the backend leaks internals
        s3_key: "secret-bucket/key",
        wrapped_dek: "deadbeef",
      },
    ];
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await getContracts();
    const [first] = result;
    expect(first).not.toHaveProperty("s3_key");
    expect(first).not.toHaveProperty("wrapped_dek");
    expect(first.id).toBe("1");
  });

  it("returns blob and filename from download endpoint", async () => {
    setDevUserId(VALID_UUID);
    fetchMock.mockResolvedValue(
      new Response(new Blob(["%PDF-"], { type: "application/pdf" }), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="MSA.pdf"',
        },
      }),
    );

    const result = await downloadContract("abc");
    expect(result.filename).toBe("MSA.pdf");
    expect(result.mimeType).toBe("application/pdf");
  });

  describe("demo-mode dispatch", () => {
    it("does not call fetch when VITE_WHEREAS_DEMO_MODE=true", async () => {
      vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
      const list = await getContracts();
      expect(list.length).toBeGreaterThan(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not require a dev user id in demo mode", async () => {
      vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
      // No setDevUserId call; would throw MissingDevUserError in real mode.
      await expect(getContracts()).resolves.toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("uploads via mockApi without calling fetch in demo mode", async () => {
      vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
      const file = new File(["x"], "demo.pdf", { type: "application/pdf" });
      const result = await uploadContract({ file, title: "Demo" });
      expect(result.title).toBe("Demo");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("real mode still calls fetch when VITE_WHEREAS_DEMO_MODE is absent", async () => {
      // env is reset in beforeEach, so demo flag is unset here.
      setDevUserId(VALID_UUID);
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await getContracts();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('real mode still calls fetch when VITE_WHEREAS_DEMO_MODE is "false"', async () => {
      vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "false");
      setDevUserId(VALID_UUID);
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await getContracts();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("first-run setup", () => {
    it("getSetupStatus calls /api/setup/status without dev user header", async () => {
      // No setDevUserId — bootstrap endpoints must not require it.
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            setup_required: true,
            organization_count: 0,
            user_count: 0,
            dev_mode_enabled: true,
            message: "Run setup.",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      const status = await getSetupStatus();
      expect(status.setup_required).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toContain("/api/setup/status");
      const headers = (init as RequestInit).headers as Headers;
      expect(headers.has("X-Whereas-Dev-User")).toBe(false);
    });

    it("createDevSetup posts JSON without dev user header", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            organization_id: "11111111-1111-4111-8111-111111111111",
            user_id: "22222222-2222-4222-8222-222222222222",
            dev_user_id: "22222222-2222-4222-8222-222222222222",
            organization_name: "Local Workspace",
            user_email: "dev@whereas.local",
            message: "Created new development workspace.",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      const result = await createDevSetup({ organization_name: "Acme" });
      expect(result.dev_user_id).toBe(
        "22222222-2222-4222-8222-222222222222",
      );

      const [, init] = fetchMock.mock.calls[0];
      const reqInit = init as RequestInit;
      expect(reqInit.method).toBe("POST");
      const headers = reqInit.headers as Headers;
      expect(headers.has("X-Whereas-Dev-User")).toBe(false);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(reqInit.body).toBe(
        JSON.stringify({ organization_name: "Acme" }),
      );
    });

    it("surfaces a friendly message when setup is blocked in production", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: "First-run setup is disabled in production.",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      await expect(getSetupStatus()).rejects.toMatchObject({
        name: "ApiError",
        status: 403,
        message: "First-run setup is disabled in production.",
      });
    });

    it("throws ApiError instead of dispatching when demo mode is on", async () => {
      vi.stubEnv("VITE_WHEREAS_DEMO_MODE", "true");
      await expect(getSetupStatus()).rejects.toBeInstanceOf(ApiError);
      await expect(
        createDevSetup({ organization_name: "X" }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
