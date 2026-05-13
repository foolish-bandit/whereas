import type { RequestApprovalSummary } from "../types/requestApprovalStatus";

export type LifecycleStageStatus = "complete" | "current" | "blocked" | "not_started";

export interface LifecycleStage {
  id: string;
  label: string;
  status: LifecycleStageStatus;
  description?: string;
  /** Optional navigation target for an action button within the stage. */
  actionLabel?: string;
  href?: string;
}

export interface LifecycleRequestSignal {
  status: string;
  linked_contract_id: string | null;
}

/**
 * Derive the six contract lifecycle stages from existing request fields.
 * All derivation is from data already on the client — no new backend state
 * is required or invented.
 *
 * @param request        - Minimal request fields needed for derivation.
 * @param approval       - Loaded approval summary, or null/undefined when not yet available.
 * @param linkedContractStatus - Status string of the linked contract record, if any.
 */
export function deriveRequestLifecycleStages(
  request: LifecycleRequestSignal,
  approval: RequestApprovalSummary | null | undefined,
  linkedContractStatus: string | null | undefined,
): LifecycleStage[] {
  const hasDraft = Boolean(request.linked_contract_id);
  const cancelled = request.status === "cancelled";

  // 1. Intake — always complete once the request record exists.
  const intake: LifecycleStage = {
    id: "intake",
    label: "Intake",
    status: "complete",
    description: "Request submitted.",
  };

  // 2. Draft / Upload — complete when a linked repository record exists.
  const draft: LifecycleStage = {
    id: "draft",
    label: "Draft / Upload",
    status: hasDraft ? "complete" : cancelled ? "not_started" : "current",
    description: hasDraft
      ? "Agreement document ready."
      : "Generate from template or upload third-party paper.",
  };

  // 3. Approval — based on the loaded approval summary.
  let approvalStageStatus: LifecycleStageStatus;
  let approvalDescription: string;

  if (!approval) {
    // Not yet loaded — show honest unknown state rather than fake completion.
    approvalStageStatus = "not_started";
    approvalDescription = "Approval status loading.";
  } else {
    const isBlocked =
      approval.has_rejected_workflows ||
      approval.blocking_reason === "rejected_approval_workflows" ||
      approval.blocking_reason === "required_approval_policy_unmet" ||
      approval.blocking_reason === "cancelled_without_completed_approval";

    if (isBlocked) {
      approvalStageStatus = "blocked";
      approvalDescription =
        approval.blocking_reason_text ?? "An approval issue is blocking progress.";
    } else if (approval.has_active_workflows) {
      approvalStageStatus = "current";
      approvalDescription = "Approval workflow in progress.";
    } else if (
      approval.all_required_policy_workflows_completed ||
      approval.ready_for_signature === true
    ) {
      approvalStageStatus = "complete";
      approvalDescription = "All required approvals completed.";
    } else if (!approval.has_required_policies) {
      // No policies match this request — approval is not required.
      approvalStageStatus = "complete";
      approvalDescription = "No approval policies required.";
    } else if (hasDraft) {
      // Draft exists but no workflow has been started yet.
      approvalStageStatus = "current";
      approvalDescription = "Ready for approval — no workflow started yet.";
    } else {
      approvalStageStatus = "not_started";
      approvalDescription = "Approval begins once a draft is ready.";
    }
  }

  const approvalStage: LifecycleStage = {
    id: "approval",
    label: "Approval",
    status: approvalStageStatus,
    description: approvalDescription,
  };

  // 4. Repository — complete when a linked contract record exists.
  const repository: LifecycleStage = {
    id: "repository",
    label: "Repository",
    status: hasDraft ? "complete" : "not_started",
    description: hasDraft ? "Linked to the Repository." : "No Repository record yet.",
  };

  // 5. Signature — based on the linked contract's status field.
  let signatureStatus: LifecycleStageStatus;
  let signatureDescription: string;

  if (linkedContractStatus === "executed") {
    signatureStatus = "complete";
    signatureDescription = "Document fully executed.";
  } else if (linkedContractStatus === "sent_for_signature") {
    signatureStatus = "current";
    signatureDescription = "Sent for signature via DocuSeal.";
  } else if (hasDraft && approvalStageStatus === "complete") {
    signatureStatus = "current";
    signatureDescription = "Ready to send for signature.";
  } else {
    signatureStatus = "not_started";
    signatureDescription = "Signature pending.";
  }

  const signature: LifecycleStage = {
    id: "signature",
    label: "Signature",
    status: signatureStatus,
    description: signatureDescription,
  };

  // 6. Executed — complete only when the linked contract is marked executed.
  const executed: LifecycleStage = {
    id: "executed",
    label: "Executed",
    status: linkedContractStatus === "executed" ? "complete" : "not_started",
    description:
      linkedContractStatus === "executed"
        ? "Contract fully executed."
        : "Awaiting full execution.",
  };

  return [intake, draft, approvalStage, repository, signature, executed];
}
