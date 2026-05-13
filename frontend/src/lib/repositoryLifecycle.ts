import type { ContractArtifact, ContractDetail } from "../types/contracts";
import type { ContractMetadataView } from "../types/contractIntake";
import type { ContractApprovalGate } from "../types/docuseal";
import type { LifecycleStage } from "./requestLifecycle";

interface RepositoryLifecycleSignals {
  contract: ContractDetail;
  artifacts: ContractArtifact[];
  metadataView: ContractMetadataView | null;
  hasReviewData: boolean;
  approvalGate?: ContractApprovalGate | null;
}

export function deriveRepositoryLifecycleStages({
  contract,
  artifacts,
  metadataView,
  hasReviewData,
  approvalGate,
}: RepositoryLifecycleSignals): LifecycleStage[] {
  const hasSourceArtifact = artifacts.some((a) => a.artifact_type === "original_upload");
  const hasSignedPdf = artifacts.some((a) => a.artifact_type === "signed_pdf");
  const hasContractLoaded = Boolean(contract.id);
  const hasMetadataSignals = Boolean(metadataView) || contract.extracted_fields.length > 0;

  const source: LifecycleStage = {
    id: "source",
    label: "Source file",
    status: hasSourceArtifact || hasContractLoaded ? "complete" : "not_started",
    description: hasSourceArtifact || hasContractLoaded ? "A source agreement file is available." : "Awaiting the source agreement file.",
  };

  const metadata: LifecycleStage = {
    id: "metadata",
    label: "Metadata",
    status: hasMetadataSignals ? "current" : "not_started",
    description: hasMetadataSignals ? "Extraction results are available for metadata review." : "Metadata extraction has not produced fields yet.",
  };

  const review: LifecycleStage = {
    id: "review",
    label: "Review",
    status: hasReviewData ? "current" : "not_started",
    description: hasReviewData ? "Review findings are available for legal analysis." : "No review run or findings are available yet.",
  };

  const approval = deriveApprovalStage(approvalGate);

  const signature: LifecycleStage = {
    id: "signature",
    label: "Signature",
    status: contract.status === "executed" || hasSignedPdf ? "complete" : contract.status === "sent_for_signature" ? "current" : "not_started",
    description:
      contract.status === "executed" || hasSignedPdf
        ? "Signature is complete and a signed file is on record."
        : contract.status === "sent_for_signature"
          ? "Agreement has been sent for signature."
          : "Signature packet has not been sent yet.",
  };

  const executed: LifecycleStage = {
    id: "executed",
    label: "Executed",
    status: contract.status === "executed" || hasSignedPdf ? "complete" : "not_started",
    description: contract.status === "executed" || hasSignedPdf ? "Contract is executed and stored in the Repository." : "Execution is pending final signatures.",
  };

  return [source, metadata, review, approval, signature, executed];
}

function deriveApprovalStage(approvalGate?: ContractApprovalGate | null): LifecycleStage {
  if (!approvalGate) {
    return {
      id: "approval",
      label: "Approval",
      status: "not_started",
      description: "Approval status is not available yet.",
    };
  }
  if (!approvalGate.allowed) {
    return {
      id: "approval",
      label: "Approval",
      status: "blocked",
      description: approvalGate.reason ?? "Required approvals are currently blocking signature.",
    };
  }
  return {
    id: "approval",
    label: "Approval",
    status: "complete",
    description: "Approval requirements are satisfied.",
  };
}
