import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { ApiError } from "../api";
import { fieldHasValidSpan } from "../fields";
import {
  __resetMockState,
  downloadContract,
  getContract,
  getContracts,
  uploadContract,
} from "../mockApi";
import { MOCK_FAILED_ID, MOCK_LIST, MOCK_NDA_ID } from "../mockData";

describe("mockApi", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    __resetMockState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetMockState();
  });

  it("returns the static sample list", async () => {
    const list = await getContracts();
    expect(list).toHaveLength(MOCK_LIST.length);
    expect(list.map((c) => c.id)).toEqual(MOCK_LIST.map((c) => c.id));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the NDA detail with valid span offsets for every field", async () => {
    const detail = await getContract(MOCK_NDA_ID);
    expect(detail.id).toBe(MOCK_NDA_ID);
    expect(detail.full_text).not.toBeNull();
    expect(detail.extracted_fields.length).toBeGreaterThan(0);
    for (const f of detail.extracted_fields) {
      expect(fieldHasValidSpan(f)).toBe(true);
      // span_text should match the slice of full_text it claims to cite
      const fullText = detail.full_text!;
      expect(fullText.slice(f.span_start!, f.span_end!)).toBe(f.span_text);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the failed-extraction sample with no fields", async () => {
    const detail = await getContract(MOCK_FAILED_ID);
    expect(detail.status).toBe("failed");
    expect(detail.extracted_fields).toEqual([]);
  });

  it("throws ApiError(404) for unknown contract ids", async () => {
    await expect(getContract("does-not-exist")).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(getContract("does-not-exist")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("upload synthesizes a contract and never calls fetch", async () => {
    const file = new File(["x"], "demo-msa.pdf", {
      type: "application/pdf",
    });
    const result = await uploadContract({ file, title: "Demo MSA" });
    expect(result.title).toBe("Demo MSA");
    expect(result.status).toBe("ready");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("upload makes the new contract visible in the list and detail endpoints", async () => {
    const file = new File(["x"], "session-upload.pdf", {
      type: "application/pdf",
    });
    const created = await uploadContract({ file });
    const list = await getContracts();
    expect(list[0].id).toBe(created.id);
    const detail = await getContract(created.id);
    expect(detail.id).toBe(created.id);
    expect(detail.full_text).not.toBeNull();
  });

  it("download returns a non-empty placeholder Blob", async () => {
    const result = await downloadContract(MOCK_NDA_ID);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.mimeType).toBe("text/plain");
    expect(result.filename).toMatch(/\.demo\.txt$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts cleanly when the AbortSignal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      getContracts({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
