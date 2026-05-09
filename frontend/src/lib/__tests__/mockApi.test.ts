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
  convertRequestToContract,
  createRequest,
  downloadContract,
  generateAgreementFromTemplate,
  getContract,
  getContractClauses,
  getContracts,
  listInboxItems,
  listRequests,
  uploadContract,
} from "../mockApi";
import { MOCK_FAILED_ID, MOCK_LIST, MOCK_NDA_ID } from "../mockData";

const NDA_TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";
const MSA_TEMPLATE_ID = "22222222-2222-4222-8222-222222222222";

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

  it("returns the NDA detail with valid span offsets for every clause", async () => {
    const detail = await getContract(MOCK_NDA_ID);
    expect(detail.clauses.length).toBeGreaterThan(0);
    const fullText = detail.full_text!;
    const seenOrdinals = new Set<number>();
    for (const c of detail.clauses) {
      // Span integrity invariant.
      expect(fullText.slice(c.span_start, c.span_end)).toBe(c.text);
      // Ordinals are unique per contract.
      expect(seenOrdinals.has(c.ordinal)).toBe(false);
      seenOrdinals.add(c.ordinal);
      expect(c.segmentation_method).toBe("heuristic_v1");
    }
  });

  it("getContractClauses returns clauses sorted by ordinal", async () => {
    const clauses = await getContractClauses(MOCK_NDA_ID);
    expect(clauses.length).toBeGreaterThan(0);
    const ordinals = clauses.map((c) => c.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
  });

  it("getContractClauses throws ApiError(404) for unknown ids", async () => {
    await expect(getContractClauses("does-not-exist")).rejects.toMatchObject({
      status: 404,
    });
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

  describe("generateAgreementFromTemplate (demo)", () => {
    it("returns a generated contract + artifact for the canned NDA", async () => {
      const result = await generateAgreementFromTemplate(NDA_TEMPLATE_ID, {
        title: "Acme NDA",
        variable_values: {
          counterparty_name: "Acme Inc.",
          effective_date: "2026-05-08",
        },
      });
      expect(result.contract.title).toBe("Acme NDA");
      expect(result.artifact.artifact_type).toBe("generated_docx");
      expect(result.artifact.source).toBe("template_generation");
      expect(result.variables_used.sort()).toEqual([
        "counterparty_name",
        "effective_date",
      ]);
      // Storage internals must never appear in the demo response.
      const json = JSON.stringify(result);
      expect(json).not.toContain("storage_key");
      expect(json).not.toContain("wrapped_dek");
    });

    it("rejects unknown variables", async () => {
      await expect(
        generateAgreementFromTemplate(NDA_TEMPLATE_ID, {
          variable_values: {
            counterparty_name: "Acme",
            effective_date: "2026-05-08",
            mystery: "x",
          },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("rejects when a required variable is missing", async () => {
      await expect(
        generateAgreementFromTemplate(NDA_TEMPLATE_ID, {
          variable_values: { counterparty_name: "Acme" },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("returns 409 when the template has no original upload", async () => {
      // The MSA fixture has no original_upload artifact in the demo data.
      await expect(
        generateAgreementFromTemplate(MSA_TEMPLATE_ID, {
          variable_values: {},
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("convertRequestToContract (demo)", () => {
    it("converts a session request, links the new contract, and resolves the inbox item", async () => {
      const request = await createRequest({
        title: "Demo NDA conversion",
        linked_template_id: NDA_TEMPLATE_ID,
      });

      const result = await convertRequestToContract(request.id, {
        title: "Acme NDA",
        variable_values: {
          counterparty_name: "Acme Inc.",
          effective_date: "2026-05-08",
        },
      });

      expect(result.contract.title).toBe("Acme NDA");
      expect(result.artifact.artifact_type).toBe("generated_docx");
      expect(result.request.linked_contract_id).toBe(result.contract.id);
      expect(result.request.status).toBe("completed");
      // Storage internals never appear in the demo response.
      const json = JSON.stringify(result);
      expect(json).not.toContain("storage_key");
      expect(json).not.toContain("wrapped_dek");

      // The list endpoint should now show the request as completed and
      // the linked inbox item as completed (so the work-queue surface
      // mirrors the change without a refetch hack).
      const requests = await listRequests();
      const updated = requests.find((r) => r.id === request.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.linked_contract_id).toBe(result.contract.id);

      const inbox = await listInboxItems({ include_dismissed: true });
      const linked = inbox.find((i) => i.request_id === request.id);
      expect(linked?.status).toBe("completed");
    });

    it("rejects a request with no linked template", async () => {
      const request = await createRequest({ title: "No template" });
      await expect(
        convertRequestToContract(request.id, { variable_values: {} }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("rejects a cancelled request", async () => {
      const request = await createRequest({
        title: "Doomed",
        linked_template_id: NDA_TEMPLATE_ID,
      });
      // Mark as cancelled by mutating the status through the patch API.
      const { updateRequest } = await import("../mockApi");
      await updateRequest(request.id, { status: "cancelled" });
      await expect(
        convertRequestToContract(request.id, {
          variable_values: {
          counterparty_name: "Acme",
          effective_date: "2026-05-08",
        },
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("rejects a request that has already been converted", async () => {
      const request = await createRequest({
        title: "Convert twice",
        linked_template_id: NDA_TEMPLATE_ID,
      });
      await convertRequestToContract(request.id, {
        variable_values: {
          counterparty_name: "Acme",
          effective_date: "2026-05-08",
        },
      });
      await expect(
        convertRequestToContract(request.id, {
          variable_values: {
          counterparty_name: "Acme",
          effective_date: "2026-05-08",
        },
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });
});
