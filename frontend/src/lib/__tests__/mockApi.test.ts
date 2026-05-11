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
  downloadContractArtifact,
  generateAgreementFromTemplate,
  getContract,
  getContractApprovalGate,
  getContractClauses,
  getContracts,
  getDashboardSummary,
  getRequestApprovalStatus,
  archiveApprovalWorkflowTemplate,
  createApprovalWorkflowTemplate,
  instantiateApprovalWorkflowTemplate,
  listApprovalWorkflowTemplates,
  listApprovalPolicies,
  createApprovalPolicy,
  updateApprovalPolicy,
  archiveApprovalPolicy,
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

  it("downloadContractArtifact (PR #70) returns a per-version placeholder Blob", async () => {
    const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const result = await downloadContractArtifact(MOCK_NDA_ID, artifactId);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.mimeType).toBe("text/plain");
    expect(result.filename).toMatch(/\.demo\.txt$/);
    // The synthetic filename references the artifact id so users can
    // distinguish multiple version downloads in demo mode.
    expect(result.filename).toContain(artifactId.slice(0, 8));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloadContractArtifact (PR #70) returns 404 for unknown contract id", async () => {
    await expect(
      downloadContractArtifact("does-not-exist", "art-1"),
    ).rejects.toBeInstanceOf(ApiError);
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

  describe("getDashboardSummary (demo)", () => {
    it("returns counts and lists derived from the mock fixtures", async () => {
      const summary = await getDashboardSummary();

      // Smoke: every count exists and is a non-negative integer.
      for (const value of Object.values(summary.counts)) {
        expect(typeof value).toBe("number");
        expect(value).toBeGreaterThanOrEqual(0);
      }

      // The seeded MOCK_REQUESTS includes one open NDA, one in_progress
      // MSA renewal, and one completed DPA.
      expect(summary.counts.open_requests).toBeGreaterThanOrEqual(1);
      expect(summary.counts.in_progress_requests).toBeGreaterThanOrEqual(1);

      // No storage internals must end up in the response.
      const json = JSON.stringify(summary);
      expect(json).not.toContain("storage_key");
      expect(json).not.toContain("wrapped_dek");

      // Lists are bounded.
      expect(summary.upcoming.requests_due_soon.length).toBeLessThanOrEqual(5);
      expect(summary.upcoming.inbox_items_due_soon.length).toBeLessThanOrEqual(
        5,
      );
      expect(
        summary.recent_activity.recent_contracts.length,
      ).toBeLessThanOrEqual(5);
    });

    it("excludes cancelled requests from the recent feed", async () => {
      const summary = await getDashboardSummary();
      for (const r of summary.recent_activity.recent_requests) {
        expect(r.status).not.toBe("cancelled");
      }
    });
  });

  describe("approval workflow templates (PR #51)", () => {
    it("creates a template, instantiates it, and only opens an inbox item for the first step", async () => {
      const template = await createApprovalWorkflowTemplate({
        name: "Standard Legal Review",
        description: "One legal approver, then finance",
        template_type: "legal_review",
        steps: [
          { step_order: 1, title: "Legal review", due_in_days: 3 },
          { step_order: 2, title: "Finance review", due_in_days: 5 },
        ],
      });
      expect(template.steps.map((s) => s.title)).toEqual([
        "Legal review",
        "Finance review",
      ]);

      const run = await instantiateApprovalWorkflowTemplate(template.id, {
        name: "Acme NDA approval",
        request_id: "req-1",
      });
      expect(run.status).toBe("active");
      expect(run.steps.length).toBe(2);
      expect(run.steps[0].inbox_item_id).not.toBeNull();
      expect(run.steps[1].inbox_item_id).toBeNull();

      // Inbox surface should carry exactly one approval item.
      const inbox = await listInboxItems({ item_type: "approval" });
      expect(inbox.length).toBe(1);
      expect(inbox[0].title).toContain("Legal review");

      // Source workflow template metadata is preserved on the run.
      expect(run.metadata_json).toMatchObject({
        source_workflow_template_id: template.id,
        source_workflow_template_name: template.name,
      });

      // No storage internals leak.
      const json = JSON.stringify(run);
      expect(json).not.toContain("storage_key");
      expect(json).not.toContain("wrapped_dek");
    });

    it("excludes archived templates from the default list", async () => {
      const template = await createApprovalWorkflowTemplate({
        name: "Archive me",
        steps: [{ step_order: 1, title: "Step" }],
      });
      await archiveApprovalWorkflowTemplate(template.id);
      const defaultList = await listApprovalWorkflowTemplates();
      expect(defaultList.find((t) => t.id === template.id)).toBeUndefined();
      const withArchived = await listApprovalWorkflowTemplates({
        include_archived: true,
      });
      expect(
        withArchived.find((t) => t.id === template.id)?.status,
      ).toBe("archived");
    });

    it("refuses to instantiate an archived template", async () => {
      const template = await createApprovalWorkflowTemplate({
        name: "No Soup",
        steps: [{ step_order: 1, title: "Step" }],
      });
      await archiveApprovalWorkflowTemplate(template.id);
      await expect(
        instantiateApprovalWorkflowTemplate(template.id, {
          name: "After archive",
          request_id: "req-1",
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("request approval visibility (PR #56)", () => {
    it("creates a workflow from a template and surfaces it on the request status", async () => {
      const request = await createRequest({
        title: "NDA visibility",
        request_type: "new_contract",
        contract_type: "NDA",
        priority: "high",
      });
      const template = await createApprovalWorkflowTemplate({
        name: "Visibility Template",
        steps: [
          { step_order: 1, title: "Legal review", due_in_days: 2 },
        ],
      });
      const run = await instantiateApprovalWorkflowTemplate(template.id, {
        name: "Visibility run",
        request_id: request.id,
      });
      expect(run.status).toBe("active");

      const status = await getRequestApprovalStatus(request.id);
      expect(status.workflow_runs).toHaveLength(1);
      expect(status.workflow_runs[0].id).toBe(run.id);
      expect(status.summary.has_active_workflows).toBe(true);
      expect(status.summary.blocking_reason).toBe("active_approval_workflows");

      // Storage internals never reach the visibility surface.
      const json = JSON.stringify(status);
      expect(json).not.toContain("storage_key");
      expect(json).not.toContain("wrapped_dek");
    });

    it("returns an empty visibility surface when no policies/workflows match", async () => {
      const request = await createRequest({
        title: "Floating",
        request_type: "other",
      });
      const status = await getRequestApprovalStatus(request.id);
      expect(status.matching_policies).toEqual([]);
      expect(status.workflow_runs).toEqual([]);
      expect(status.summary.has_active_workflows).toBe(false);
      expect(status.summary.has_required_policies).toBe(false);
      expect(status.summary.blocking_reason).toBeNull();
      expect(status.summary.ready_for_signature).toBeNull();
    });
  });

  describe("activity timeline (PR #58)", () => {
    it("emits workflow_created + step_activated when a template is instantiated", async () => {
      const { getRequestActivity } = await import("../mockApi");
      const request = await createRequest({
        title: "Timeline test",
        request_type: "new_contract",
        contract_type: "NDA",
      });
      const template = await createApprovalWorkflowTemplate({
        name: "Timeline Template",
        steps: [{ step_order: 1, title: "Legal review" }],
      });
      await instantiateApprovalWorkflowTemplate(template.id, {
        name: "Timeline run",
        request_id: request.id,
      });

      const tl = await getRequestActivity(request.id);
      const types = tl.items.map((i) => i.event_type);
      expect(types).toContain("approval.workflow.created");
      expect(types).toContain("approval.step.activated");
      // The created+activated pair fires at the same instant on
      // instantiation, so the relative order between just those two is
      // intentionally unasserted; what matters is that both surface
      // and the timeline is sorted DESC by occurred_at across runs.

      // No storage internals in the projected items.
      const json = JSON.stringify(tl);
      expect(json).not.toContain("storage_key");
      expect(json).not.toContain("wrapped_dek");
      expect(json).not.toContain("decision_note");
    });

    it("returns an empty timeline for a request with no workflows", async () => {
      const { getRequestActivity } = await import("../mockApi");
      const request = await createRequest({ title: "No timeline" });
      const tl = await getRequestActivity(request.id);
      expect(tl.items).toEqual([]);
    });
  });

  describe("approval policies (demo)", () => {
    it("excludes archived by default and includes them when requested", async () => {
      const activeOnly = await listApprovalPolicies();
      expect(activeOnly.some((p) => p.status === "archived")).toBe(false);

      const withArchived = await listApprovalPolicies({ include_archived: true });
      expect(withArchived.some((p) => p.status === "archived")).toBe(true);
    });

    it("creates, updates, and archives a policy", async () => {
      const created = await createApprovalPolicy({
        name: "Demo policy",
        workflow_template_id: "wftpl-legal-review",
        request_type: "",
        contract_type: "",
        priority: "",
        agreement_template_id: "",
      });
      expect(created.request_type).toBeNull();
      expect(created.contract_type).toBeNull();
      expect(created.priority).toBeNull();
      expect(created.agreement_template_id).toBeNull();

      const patched = await updateApprovalPolicy(created.id, { description: "Updated" });
      expect(patched.description).toBe("Updated");

      const archived = await archiveApprovalPolicy(created.id);
      expect(archived.status).toBe("archived");
    });

    it("returns ApiError(409) for duplicate active names", async () => {
      await expect(createApprovalPolicy({
        name: "NDA Legal Review policy",
        workflow_template_id: "wftpl-legal-review",
      })).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("getContractApprovalGate (PR #59)", () => {
    it("includes named required/missing policy summaries on the policy-blocked demo", async () => {
      const gate = await getContractApprovalGate("contract-policy-blocked");
      expect(gate.allowed).toBe(false);
      expect(gate.code).toBe("required_approval_policy_unmet");
      expect(gate.required_policies).toBeDefined();
      expect(gate.missing_policies).toBeDefined();
      expect(gate.missing_policies?.[0]?.name).toBe("Standard Legal Review");
      // Back-compat id fields stay present and aligned with the named lists.
      expect(gate.required_policy_ids).toEqual(
        gate.required_policies?.map((p) => p.id),
      );
      expect(gate.missing_policy_ids).toEqual(
        gate.missing_policies?.map((p) => p.id),
      );
    });

    it("returns empty summary lists when the gate allows", async () => {
      const gate = await getContractApprovalGate("contract-clean");
      expect(gate.allowed).toBe(true);
      expect(gate.required_policies).toEqual([]);
      expect(gate.missing_policies).toEqual([]);
      // Back-compat id fields are still present so older clients keep working.
      expect(gate.required_policy_ids).toEqual([]);
      expect(gate.missing_policy_ids).toEqual([]);
    });
  });

});
