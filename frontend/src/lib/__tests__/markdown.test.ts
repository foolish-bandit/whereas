import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { ApiError, getContractMarkdown } from "../api";
import { clearDevUserId, setDevUserId } from "../devUser";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const CONTRACT_ID = "22222222-2222-4222-8222-222222222222";

describe("getContractMarkdown", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setDevUserId(VALID_UUID);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDevUserId();
  });

  it("returns the parsed snapshot on 200", async () => {
    const payload = {
      id: "33333333-3333-4333-8333-333333333333",
      contract_id: CONTRACT_ID,
      markdown_text: "# MSA\n\nbody",
      source_kind: "original_upload",
      converter_name: "markitdown",
      converter_version: "0.0.1",
      conversion_status: "ready",
      conversion_warnings: null,
      created_at: "2026-05-08T00:00:00Z",
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await getContractMarkdown(CONTRACT_ID);

    expect(result).not.toBeNull();
    expect(result!.markdown_text).toContain("MSA");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(
      /\/api\/contracts\/[0-9a-f-]+\/markdown$/i,
    );
  });

  it("returns null on 404 instead of throwing", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Markdown snapshot not found." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await getContractMarkdown(CONTRACT_ID);
    expect(result).toBeNull();
  });

  it("propagates non-404 errors as ApiError", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(getContractMarkdown(CONTRACT_ID)).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("scrubs storage/encryption keys from the response", async () => {
    const payload = {
      id: "44444444-4444-4444-8444-444444444444",
      contract_id: CONTRACT_ID,
      markdown_text: "# t",
      source_kind: "original_upload",
      converter_name: "markitdown",
      converter_version: null,
      conversion_status: "ready",
      conversion_warnings: null,
      created_at: "2026-05-08T00:00:00Z",
      // Backend regression: should be filtered before it reaches a component.
      s3_key: "documents/secret.enc",
      wrapped_dek: "BASE64-bytes",
    } as Record<string, unknown>;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = (await getContractMarkdown(CONTRACT_ID)) as Record<
      string,
      unknown
    > | null;
    expect(result).not.toBeNull();
    expect("s3_key" in (result as object)).toBe(false);
    expect("wrapped_dek" in (result as object)).toBe(false);
  });
});
