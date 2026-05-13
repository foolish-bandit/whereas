import { describe, expect, it } from "vitest";

import {
  deriveRequestLifecycleStages,
  type LifecycleRequestSignal,
} from "../requestLifecycle";
import type { RequestApprovalSummary } from "../../types/requestApprovalStatus";

function req(overrides: Partial<LifecycleRequestSignal> = {}): LifecycleRequestSignal {
  return { status: "open", linked_contract_id: null, ...overrides };
}

function approval(overrides: Partial<RequestApprovalSummary> = {}): RequestApprovalSummary {
  return {
    has_required_policies: true,
    has_active_workflows: false,
    has_rejected_workflows: false,
    has_completed_workflows: false,
    all_required_policy_workflows_completed: false,
    ready_for_signature: null,
    blocking_reason: null,
    blocking_reason_text: null,
    ...overrides,
  };
}

function stageById(stages: ReturnType<typeof deriveRequestLifecycleStages>, id: string) {
  const s = stages.find((x) => x.id === id);
  if (!s) throw new Error(`Stage "${id}" not found`);
  return s;
}

describe("deriveRequestLifecycleStages", () => {
  describe("always returns six ordered stages", () => {
    it("returns ids in order: intake, draft, approval, repository, signature, executed", () => {
      const stages = deriveRequestLifecycleStages(req(), undefined, undefined);
      expect(stages.map((s) => s.id)).toEqual([
        "intake",
        "draft",
        "approval",
        "repository",
        "signature",
        "executed",
      ]);
    });
  });

  describe("intake", () => {
    it("is always complete", () => {
      for (const status of ["open", "in_progress", "completed", "cancelled"]) {
        const stages = deriveRequestLifecycleStages(req({ status }), undefined, undefined);
        expect(stageById(stages, "intake").status).toBe("complete");
      }
    });
  });

  describe("draft / upload stage", () => {
    it("is current when no linked contract and request is open", () => {
      const stages = deriveRequestLifecycleStages(req(), undefined, undefined);
      expect(stageById(stages, "draft").status).toBe("current");
    });

    it("is complete when linked_contract_id is present", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        undefined,
        undefined,
      );
      expect(stageById(stages, "draft").status).toBe("complete");
    });

    it("is not_started when request is cancelled and no linked contract", () => {
      const stages = deriveRequestLifecycleStages(
        req({ status: "cancelled" }),
        undefined,
        undefined,
      );
      expect(stageById(stages, "draft").status).toBe("not_started");
    });
  });

  describe("approval stage", () => {
    it("is not_started when approval is undefined (not yet loaded)", () => {
      const stages = deriveRequestLifecycleStages(req(), undefined, undefined);
      expect(stageById(stages, "approval").status).toBe("not_started");
    });

    it("is not_started when approval is null", () => {
      const stages = deriveRequestLifecycleStages(req(), null, undefined);
      expect(stageById(stages, "approval").status).toBe("not_started");
    });

    it("is blocked when has_rejected_workflows is true", () => {
      const stages = deriveRequestLifecycleStages(
        req(),
        approval({ has_rejected_workflows: true }),
        undefined,
      );
      expect(stageById(stages, "approval").status).toBe("blocked");
    });

    it("is blocked for rejected_approval_workflows blocking_reason", () => {
      const stages = deriveRequestLifecycleStages(
        req(),
        approval({ blocking_reason: "rejected_approval_workflows" }),
        undefined,
      );
      expect(stageById(stages, "approval").status).toBe("blocked");
    });

    it("is blocked for required_approval_policy_unmet blocking_reason", () => {
      const stages = deriveRequestLifecycleStages(
        req(),
        approval({ blocking_reason: "required_approval_policy_unmet" }),
        undefined,
      );
      expect(stageById(stages, "approval").status).toBe("blocked");
    });

    it("is blocked for cancelled_without_completed_approval blocking_reason", () => {
      const stages = deriveRequestLifecycleStages(
        req(),
        approval({ blocking_reason: "cancelled_without_completed_approval" }),
        undefined,
      );
      expect(stageById(stages, "approval").status).toBe("blocked");
    });

    it("uses blocking_reason_text as description when blocked", () => {
      const stages = deriveRequestLifecycleStages(
        req(),
        approval({
          has_rejected_workflows: true,
          blocking_reason_text: "A workflow was rejected.",
        }),
        undefined,
      );
      expect(stageById(stages, "approval").description).toBe("A workflow was rejected.");
    });

    it("falls back to generic description when blocked and no blocking_reason_text", () => {
      const stages = deriveRequestLifecycleStages(
        req(),
        approval({ has_rejected_workflows: true, blocking_reason_text: null }),
        undefined,
      );
      expect(stageById(stages, "approval").description).toContain("blocking");
    });

    it("is current when has_active_workflows is true", () => {
      const stages = deriveRequestLifecycleStages(
        req(),
        approval({ has_active_workflows: true }),
        undefined,
      );
      expect(stageById(stages, "approval").status).toBe("current");
    });

    it("is complete when all_required_policy_workflows_completed is true", () => {
      const stages = deriveRequestLifecycleStages(
        req(),
        approval({ all_required_policy_workflows_completed: true }),
        undefined,
      );
      expect(stageById(stages, "approval").status).toBe("complete");
    });

    it("is complete when ready_for_signature is true", () => {
      const stages = deriveRequestLifecycleStages(
        req(),
        approval({ ready_for_signature: true }),
        undefined,
      );
      expect(stageById(stages, "approval").status).toBe("complete");
    });

    it("is complete when no required policies exist", () => {
      const stages = deriveRequestLifecycleStages(
        req(),
        approval({ has_required_policies: false }),
        undefined,
      );
      expect(stageById(stages, "approval").status).toBe("complete");
    });

    it("is current (not not_started) when draft exists but no workflow started", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        approval({ has_required_policies: true, has_active_workflows: false }),
        undefined,
      );
      expect(stageById(stages, "approval").status).toBe("current");
    });

    it("is not_started when no draft and no workflow", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: null }),
        approval({ has_required_policies: true }),
        undefined,
      );
      expect(stageById(stages, "approval").status).toBe("not_started");
    });
  });

  describe("repository stage", () => {
    it("is not_started when no linked contract", () => {
      const stages = deriveRequestLifecycleStages(req(), undefined, undefined);
      expect(stageById(stages, "repository").status).toBe("not_started");
    });

    it("is complete when linked_contract_id is present", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        undefined,
        undefined,
      );
      expect(stageById(stages, "repository").status).toBe("complete");
    });
  });

  describe("signature stage", () => {
    it("is not_started by default", () => {
      const stages = deriveRequestLifecycleStages(req(), undefined, undefined);
      expect(stageById(stages, "signature").status).toBe("not_started");
    });

    it("is current when linked contract status is sent_for_signature", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        undefined,
        "sent_for_signature",
      );
      expect(stageById(stages, "signature").status).toBe("current");
    });

    it("is complete when linked contract status is executed", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        undefined,
        "executed",
      );
      expect(stageById(stages, "signature").status).toBe("complete");
    });

    it("is current when draft exists and approval is complete", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        approval({ all_required_policy_workflows_completed: true }),
        "ready",
      );
      expect(stageById(stages, "signature").status).toBe("current");
    });

    it("is not_started when draft exists but approval is not complete", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        approval({ has_active_workflows: true }),
        "ready",
      );
      expect(stageById(stages, "signature").status).toBe("not_started");
    });
  });

  describe("executed stage", () => {
    it("is not_started by default", () => {
      const stages = deriveRequestLifecycleStages(req(), undefined, undefined);
      expect(stageById(stages, "executed").status).toBe("not_started");
    });

    it("is complete only when linked contract status is executed", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        undefined,
        "executed",
      );
      expect(stageById(stages, "executed").status).toBe("complete");
    });

    it("is not_started when linked contract status is sent_for_signature", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        undefined,
        "sent_for_signature",
      );
      expect(stageById(stages, "executed").status).toBe("not_started");
    });

    it("is not_started when contract status is ready", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        undefined,
        "ready",
      );
      expect(stageById(stages, "executed").status).toBe("not_started");
    });
  });

  describe("end-to-end scenarios", () => {
    it("open request without linked contract — only intake complete, draft current", () => {
      const stages = deriveRequestLifecycleStages(
        req({ status: "open" }),
        undefined,
        undefined,
      );
      expect(stageById(stages, "intake").status).toBe("complete");
      expect(stageById(stages, "draft").status).toBe("current");
      expect(stageById(stages, "approval").status).toBe("not_started");
      expect(stageById(stages, "repository").status).toBe("not_started");
      expect(stageById(stages, "signature").status).toBe("not_started");
      expect(stageById(stages, "executed").status).toBe("not_started");
    });

    it("request with linked contract, approval pending — draft+repo complete, approval current", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        approval({ has_active_workflows: true }),
        "ready",
      );
      expect(stageById(stages, "intake").status).toBe("complete");
      expect(stageById(stages, "draft").status).toBe("complete");
      expect(stageById(stages, "approval").status).toBe("current");
      expect(stageById(stages, "repository").status).toBe("complete");
      expect(stageById(stages, "signature").status).toBe("not_started");
      expect(stageById(stages, "executed").status).toBe("not_started");
    });

    it("request with linked contract, approval blocked", () => {
      const stages = deriveRequestLifecycleStages(
        req({ linked_contract_id: "c-1" }),
        approval({ has_rejected_workflows: true, blocking_reason_text: "Rejected." }),
        "ready",
      );
      expect(stageById(stages, "approval").status).toBe("blocked");
      expect(stageById(stages, "approval").description).toBe("Rejected.");
    });

    it("fully executed contract — all stages complete", () => {
      const stages = deriveRequestLifecycleStages(
        req({ status: "completed", linked_contract_id: "c-1" }),
        approval({
          all_required_policy_workflows_completed: true,
          ready_for_signature: true,
        }),
        "executed",
      );
      for (const stage of stages) {
        expect(stage.status).toBe("complete");
      }
    });
  });
});
