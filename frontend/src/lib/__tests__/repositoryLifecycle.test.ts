import { describe, expect, it } from "vitest";

import { deriveRepositoryLifecycleStages } from "../repositoryLifecycle";
import type { ContractArtifact, ContractDetail } from "../../types/contracts";
import type { ContractApprovalGate } from "../../types/docuseal";

function contract(overrides: Partial<ContractDetail> = {}): ContractDetail {
  return {
    id: "contract-1",
    title: "Test Contract",
    status: "ready",
    mime_type: "application/pdf",
    file_hash_sha256: "hash",
    page_count: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    full_text: null,
    extracted_fields: [],
    clauses: [],
    ...overrides,
  };
}

function stageById(id: string, gate?: ContractApprovalGate | null) {
  const stages = deriveRepositoryLifecycleStages({
    contract: contract(),
    artifacts: [] as ContractArtifact[],
    metadataView: null,
    hasReviewData: false,
    approvalGate: gate,
  });
  const stage = stages.find((s) => s.id === id);
  if (!stage) throw new Error(`Stage ${id} not found`);
  return stage;
}

describe("deriveRepositoryLifecycleStages", () => {
  it("marks approval as blocked using generic text when gate is not allowed", () => {
    const approval = stageById("approval", {
      allowed: false,
      code: "active_approval_workflows",
      request_id: "req-1",
      blocking_workflow_ids: ["wf-1"],
      completed_workflow_ids: [],
      active_count: 1,
      rejected_count: 0,
      cancelled_count: 0,
      completed_count: 0,
      required_policy_ids: [],
      missing_policy_ids: [],
      required_policies: [],
      missing_policies: [],
    });

    expect(approval.status).toBe("blocked");
    expect(approval.description).toBe("Required approvals are currently blocking signature.");
  });
});
