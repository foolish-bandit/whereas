/**
 * Client-side helper: maps existing ContractRequest fields and an
 * optional approval summary into a user-facing stage label, explanation,
 * and next-action hint.
 *
 * All derivation is from existing API fields — no new backend state is
 * required. Callers on the list view pass no approval signal (approval
 * status is lazy-loaded per row). Callers on the detail view pass the
 * loaded approval summary for richer stage resolution.
 */
import type { PillTone } from "../components/ui/Pill";

export interface RequestStageInfo {
  /** Short stage label, e.g. "Awaiting review". */
  label: string;
  /** One-line explanation of what this stage means. */
  explanation: string;
  /** Button/link label for the primary next action, or null if none. */
  nextActionLabel: string | null;
  /**
   * Route suffix to apply mountedPath() to before navigating.
   * Example: "/requests/id", "/repository/id",
   *          "/approvals/workflows?request_id=id"
   */
  nextActionSuffix: string | null;
  tone: PillTone;
}

export interface RequestStageSignal {
  id: string;
  status: string;
  linked_contract_id: string | null;
  linked_template_id?: string | null;
}

export interface ApprovalStageSignal {
  has_active_workflows: boolean;
  has_rejected_workflows: boolean;
  ready_for_signature: boolean | null;
  blocking_reason: string | null;
}

export function getRequestStage(
  request: RequestStageSignal,
  approval?: ApprovalStageSignal | null,
): RequestStageInfo {
  const { id, status, linked_contract_id } = request;
  const encodedId = encodeURIComponent(id);

  // Cancelled always wins — no further processing.
  if (status === "cancelled") {
    return {
      label: "Closed",
      explanation: "This request has been cancelled.",
      nextActionLabel: null,
      nextActionSuffix: null,
      tone: "neutral",
    };
  }

  // Approval-aware stages require a loaded approval summary.
  if (approval) {
    const isBlocked =
      approval.has_rejected_workflows ||
      approval.blocking_reason === "rejected_approval_workflows" ||
      approval.blocking_reason === "required_approval_policy_unmet" ||
      approval.blocking_reason === "cancelled_without_completed_approval";

    if (isBlocked) {
      return {
        label: "Blocked",
        explanation:
          "An approval workflow issue is blocking progress. Resolve or restart the workflow before continuing.",
        nextActionLabel: "View approval workflows",
        nextActionSuffix: `/approvals/workflows?request_id=${encodedId}`,
        tone: "danger",
      };
    }

    if (approval.has_active_workflows) {
      return {
        label: "Waiting on approvals",
        explanation:
          "Required approval workflows are in progress. All steps must complete before signature.",
        nextActionLabel: "View approval workflows",
        nextActionSuffix: `/approvals/workflows?request_id=${encodedId}`,
        tone: "warning",
      };
    }

    if (approval.ready_for_signature === true) {
      return {
        label: "Ready for signature",
        explanation:
          "Approvals are complete. Send for signature from the linked Repository record.",
        nextActionLabel: linked_contract_id ? "Open Repository record" : null,
        nextActionSuffix: linked_contract_id
          ? `/repository/${encodeURIComponent(linked_contract_id)}`
          : null,
        tone: "success",
      };
    }
  }

  // Linked Repository record present (no blocking approval issue).
  if (linked_contract_id) {
    if (status === "completed") {
      return {
        label: "Converted to Repository",
        explanation:
          "An agreement has been created and linked to the Repository.",
        nextActionLabel: "Open Repository record",
        nextActionSuffix: `/repository/${encodeURIComponent(linked_contract_id)}`,
        tone: "success",
      };
    }
    return {
      label: "In review",
      explanation:
        "An agreement is linked. Review it in the Repository and continue the approval process.",
      nextActionLabel: "Open Repository record",
      nextActionSuffix: `/repository/${encodeURIComponent(linked_contract_id)}`,
      tone: "neutral",
    };
  }

  // Status-only fallbacks.
  if (status === "completed") {
    return {
      label: "Complete",
      explanation: "This request has been completed.",
      nextActionLabel: null,
      nextActionSuffix: null,
      tone: "success",
    };
  }

  if (status === "blocked") {
    return {
      label: "Blocked",
      explanation:
        "This request is blocked and requires action before it can continue.",
      nextActionLabel: "Open request",
      nextActionSuffix: `/requests/${encodedId}`,
      tone: "danger",
    };
  }

  if (status === "in_progress") {
    return {
      label: "In review",
      explanation:
        "This request is under active review. Generate or upload an agreement to continue.",
      nextActionLabel: "Open request",
      nextActionSuffix: `/requests/${encodedId}`,
      tone: "neutral",
    };
  }

  if (status === "open") {
    return {
      label: "Awaiting review",
      explanation: "This request is ready for review and agreement preparation.",
      nextActionLabel: "Open request",
      nextActionSuffix: `/requests/${encodedId}`,
      tone: "neutral",
    };
  }

  // Unknown status — safe fallback.
  return {
    label: "Needs review",
    explanation: "Review the request details and take the next step.",
    nextActionLabel: "Open request",
    nextActionSuffix: `/requests/${encodedId}`,
    tone: "neutral",
  };
}
