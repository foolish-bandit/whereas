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
  downloadContract,
  getContract,
  getContracts,
  uploadContract,
} from "../api";
import { clearDevUserId, setDevUserId } from "../devUser";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("api client", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    clearDevUserId();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
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
});
