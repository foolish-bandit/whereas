import { describe, expect, it } from "vitest";

import { getRequestStage } from "../requestStage";
import type { ApprovalStageSignal, RequestStageSignal } from "../requestStage";

function req(overrides: Partial<RequestStageSignal> = {}): RequestStageSignal {
  return {
    id: "req-abc",
    status: "open",
    linked_contract_id: null,
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalStageSignal> = {}): ApprovalStageSignal {
  return {
    has_active_workflows: false,
    has_rejected_workflows: false,
    ready_for_signature: null,
    blocking_reason: null,
    ...overrides,
  };
}

describe("getRequestStage", () => {
  describe("cancelled always wins", () => {
    it("returns Closed for cancelled with no other signals", () => {
      const s = getRequestStage(req({ status: "cancelled" }));
      expect(s.label).toBe("Closed");
      expect(s.tone).toBe("neutral");
      expect(s.nextActionLabel).toBeNull();
    });

    it("returns Closed for cancelled even with linked contract and approval signal", () => {
      const s = getRequestStage(
        req({ status: "cancelled", linked_contract_id: "c-1" }),
        approval({ ready_for_signature: true }),
      );
      expect(s.label).toBe("Closed");
      expect(s.tone).toBe("neutral");
    });
  });

  describe("approval-aware blocked states", () => {
    it("returns Blocked when has_rejected_workflows is true", () => {
      const s = getRequestStage(req(), approval({ has_rejected_workflows: true }));
      expect(s.label).toBe("Blocked");
      expect(s.tone).toBe("danger");
      expect(s.nextActionSuffix).toContain("/approvals/workflows");
      expect(s.nextActionSuffix).toContain("req-abc");
    });

    it("returns Blocked for blocking_reason rejected_approval_workflows", () => {
      const s = getRequestStage(
        req(),
        approval({ blocking_reason: "rejected_approval_workflows" }),
      );
      expect(s.label).toBe("Blocked");
      expect(s.tone).toBe("danger");
    });

    it("returns Blocked for blocking_reason required_approval_policy_unmet", () => {
      const s = getRequestStage(
        req(),
        approval({ blocking_reason: "required_approval_policy_unmet" }),
      );
      expect(s.label).toBe("Blocked");
      expect(s.tone).toBe("danger");
    });

    it("returns Blocked for blocking_reason cancelled_without_completed_approval", () => {
      const s = getRequestStage(
        req(),
        approval({ blocking_reason: "cancelled_without_completed_approval" }),
      );
      expect(s.label).toBe("Blocked");
      expect(s.tone).toBe("danger");
    });
  });

  describe("waiting on approvals", () => {
    it("returns Waiting on approvals when has_active_workflows is true", () => {
      const s = getRequestStage(req(), approval({ has_active_workflows: true }));
      expect(s.label).toBe("Waiting on approvals");
      expect(s.tone).toBe("warning");
      expect(s.nextActionSuffix).toContain("/approvals/workflows");
    });
  });

  describe("ready for signature", () => {
    it("returns Ready for signature when ready_for_signature is true with linked contract", () => {
      const s = getRequestStage(
        req({ linked_contract_id: "c-1" }),
        approval({ ready_for_signature: true }),
      );
      expect(s.label).toBe("Ready for signature");
      expect(s.tone).toBe("success");
      expect(s.nextActionLabel).toBe("Open Repository record");
      expect(s.nextActionSuffix).toBe("/repository/c-1");
    });

    it("returns Ready for signature with null next-action when no linked contract yet", () => {
      const s = getRequestStage(
        req({ linked_contract_id: null }),
        approval({ ready_for_signature: true }),
      );
      expect(s.label).toBe("Ready for signature");
      expect(s.tone).toBe("success");
      expect(s.nextActionLabel).toBeNull();
      expect(s.nextActionSuffix).toBeNull();
    });
  });

  describe("linked contract (no blocking approval)", () => {
    it("returns Converted to Repository when linked + completed", () => {
      const s = getRequestStage(
        req({ status: "completed", linked_contract_id: "c-2" }),
      );
      expect(s.label).toBe("Converted to Repository");
      expect(s.tone).toBe("success");
      expect(s.nextActionSuffix).toBe("/repository/c-2");
    });

    it("returns In review when linked + not completed", () => {
      const s = getRequestStage(
        req({ status: "in_progress", linked_contract_id: "c-3" }),
      );
      expect(s.label).toBe("In review");
      expect(s.tone).toBe("neutral");
      expect(s.nextActionSuffix).toBe("/repository/c-3");
    });
  });

  describe("status-only fallbacks", () => {
    it("returns Complete for completed with no linked contract", () => {
      const s = getRequestStage(req({ status: "completed" }));
      expect(s.label).toBe("Complete");
      expect(s.tone).toBe("success");
      expect(s.nextActionLabel).toBeNull();
    });

    it("returns Blocked for status=blocked", () => {
      const s = getRequestStage(req({ status: "blocked" }));
      expect(s.label).toBe("Blocked");
      expect(s.tone).toBe("danger");
      expect(s.nextActionSuffix).toBe("/requests/req-abc");
    });

    it("returns In review for in_progress", () => {
      const s = getRequestStage(req({ status: "in_progress" }));
      expect(s.label).toBe("In review");
      expect(s.tone).toBe("neutral");
      expect(s.nextActionSuffix).toBe("/requests/req-abc");
    });

    it("returns Awaiting review for open", () => {
      const s = getRequestStage(req({ status: "open" }));
      expect(s.label).toBe("Awaiting review");
      expect(s.tone).toBe("neutral");
      expect(s.nextActionSuffix).toBe("/requests/req-abc");
    });

    it("returns Needs review for an unknown status", () => {
      const s = getRequestStage(req({ status: "something_new" }));
      expect(s.label).toBe("Needs review");
      expect(s.tone).toBe("neutral");
      expect(s.nextActionSuffix).toBe("/requests/req-abc");
    });
  });

  describe("URL encoding", () => {
    it("encodes special characters in request ID in nextActionSuffix", () => {
      const s = getRequestStage(req({ id: "req/with spaces", status: "open" }));
      expect(s.nextActionSuffix).toBe("/requests/req%2Fwith%20spaces");
    });

    it("encodes special characters in linked_contract_id", () => {
      const s = getRequestStage(
        req({ status: "completed", linked_contract_id: "c/with spaces" }),
      );
      expect(s.nextActionSuffix).toBe("/repository/c%2Fwith%20spaces");
    });
  });

  describe("approval signal priority over status", () => {
    it("blocked approval wins over linked_contract_id + in_progress status", () => {
      const s = getRequestStage(
        req({ status: "in_progress", linked_contract_id: "c-1" }),
        approval({ has_rejected_workflows: true }),
      );
      expect(s.label).toBe("Blocked");
      expect(s.nextActionSuffix).toContain("/approvals/workflows");
    });

    it("active workflows win over linked_contract_id", () => {
      const s = getRequestStage(
        req({ status: "in_progress", linked_contract_id: "c-1" }),
        approval({ has_active_workflows: true }),
      );
      expect(s.label).toBe("Waiting on approvals");
    });
  });

  describe("null / undefined approval signal", () => {
    it("falls through to status when approval is null", () => {
      const s = getRequestStage(req({ status: "in_progress" }), null);
      expect(s.label).toBe("In review");
    });

    it("falls through to status when approval is undefined", () => {
      const s = getRequestStage(req({ status: "open" }), undefined);
      expect(s.label).toBe("Awaiting review");
    });
  });
});
