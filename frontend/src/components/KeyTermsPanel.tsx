import type { ContractArtifact, ContractDetail } from "../types/contracts";
import type { ContractMetadataView } from "../types/contractIntake";
import { isDemoMode } from "../lib/env";
import { pickCurrentDocumentLabel } from "../lib/artifacts";
import { formatDate } from "../lib/format";
import Pill from "./ui/Pill";
import type { PillTone } from "./ui/Pill";

export interface KeyTermsPanelProps {
  contract: ContractDetail;
  metadata: ContractMetadataView | null;
  artifacts: ContractArtifact[];
  /** Called when the user clicks "Review metadata" on a missing field. */
  onReviewMetadata?: () => void;
}

// ---------------------------------------------------------------------------
// Demo-only obligation data
// Rendered only when isDemoMode() === true; clearly labelled in the UI.
// ---------------------------------------------------------------------------
interface DemoObligation {
  id: string;
  summary: string;
  category: string;
  dueLabel: string;
}

const DEMO_OBLIGATIONS: Record<string, DemoObligation[]> = {
  "00000000-0000-4000-8000-000000000001": [
    {
      id: "o1",
      summary:
        "Notify counterparty of any material breach within 5 business days of discovery",
      category: "Notice",
      dueLabel: "Ongoing",
    },
    {
      id: "o2",
      summary:
        "Return or destroy all Confidential Information promptly upon termination",
      category: "Post-termination",
      dueLabel: "On termination",
    },
  ],
  "00000000-0000-4000-8000-000000000002": [
    {
      id: "o1",
      summary:
        "Deliver monthly status reports to counterparty by the 5th of each month",
      category: "Reporting",
      dueLabel: "Monthly",
    },
    {
      id: "o2",
      summary:
        "Maintain cyber liability insurance with minimum $2M per-occurrence coverage",
      category: "Insurance",
      dueLabel: "Ongoing",
    },
  ],
};

// ---------------------------------------------------------------------------
// Derived status helpers
// ---------------------------------------------------------------------------

function signatureStatusInfo(
  contract: ContractDetail,
  artifacts: ContractArtifact[],
): { label: string; tone: PillTone } {
  if (contract.status === "executed") {
    const hasSigned = artifacts.some((a) => a.artifact_type === "signed_pdf");
    return hasSigned
      ? { label: "Signed PDF received", tone: "success" }
      : { label: "Executed", tone: "success" };
  }
  if (contract.status === "sent_for_signature") {
    return { label: "Out for signature", tone: "info" };
  }
  return { label: "Not sent", tone: "neutral" };
}

function executedStatusInfo(
  contract: ContractDetail,
): { label: string; tone: PillTone } {
  switch (contract.status) {
    case "executed":
      return { label: "Executed", tone: "success" };
    case "sent_for_signature":
      return { label: "Awaiting execution", tone: "info" };
    case "ready":
      return { label: "Not yet executed", tone: "neutral" };
    case "extracting":
      return { label: "Processing", tone: "neutral" };
    case "failed":
      return { label: "Processing failed", tone: "warning" };
    default:
      return { label: "Uploaded", tone: "neutral" };
  }
}

function sourceFileStatus(artifacts: ContractArtifact[]): string {
  const original = artifacts.find((a) => a.artifact_type === "original_upload");
  return original ? "Available" : "Not set";
}

// ---------------------------------------------------------------------------
// Row primitive
// ---------------------------------------------------------------------------

interface KeyTermRowProps {
  label: string;
  /** Rendered as plain text when no pill is provided. */
  value?: string | null;
  /** When provided, renders a Pill instead of plain text. */
  pill?: { label: string; tone: PillTone };
  /**
   * When true (and onReviewMetadata is provided), shows a "Review metadata"
   * action link beside the missing value.
   */
  reviewable?: boolean;
  onReviewMetadata?: () => void;
  "data-testid"?: string;
}

function KeyTermRow({
  label,
  value,
  pill,
  reviewable = false,
  onReviewMetadata,
  "data-testid": testId,
}: KeyTermRowProps) {
  const displayValue = value || "Not set";
  const isMissing = !pill && !value;

  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <dt className="text-[11px] uppercase tracking-wide text-ink-subtle">
        {label}
      </dt>
      <dd className="flex flex-wrap items-center gap-2 text-sm">
        {pill ? (
          <Pill tone={pill.tone} variant="soft">
            {pill.label}
          </Pill>
        ) : (
          <span className={isMissing ? "text-ink-subtle italic" : "text-ink"}>
            {displayValue}
          </span>
        )}
        {isMissing && reviewable && onReviewMetadata && (
          <button
            type="button"
            className="text-xs text-ink-muted underline hover:text-ink"
            onClick={onReviewMetadata}
            data-testid={testId ? `${testId}-review-action` : undefined}
          >
            Review metadata
          </button>
        )}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Obligations subsection
// ---------------------------------------------------------------------------

function ObligationsSection({
  contractId,
}: {
  contractId: string;
}) {
  const demoObligations =
    isDemoMode() ? (DEMO_OBLIGATIONS[contractId] ?? []) : [];

  return (
    <div
      className="mt-4 border-t border-rule pt-4"
      data-testid="key-terms-obligations"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        Obligations
      </h3>

      {demoObligations.length > 0 ? (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] italic text-ink-subtle">
            Demo data — example obligations for illustration only.
          </p>
          {demoObligations.map((ob) => (
            <div
              key={ob.id}
              className="rounded border border-rule bg-canvas-subtle p-2"
              data-testid="key-terms-obligation-row"
            >
              <p className="text-xs text-ink">{ob.summary}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <Pill tone="neutral" variant="outline">
                  {ob.category}
                </Pill>
                <Pill tone="neutral" variant="outline">
                  {ob.dueLabel}
                </Pill>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p
          className="mt-2 text-xs text-ink-subtle"
          data-testid="key-terms-obligations-empty"
        >
          No obligations have been captured yet. For MVP, Whereas tracks key
          dates and metadata; obligation extraction is planned.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function KeyTermsPanel({
  contract,
  metadata,
  artifacts,
  onReviewMetadata,
}: KeyTermsPanelProps) {
  const currentDoc = pickCurrentDocumentLabel(artifacts);
  const sigStatus = signatureStatusInfo(contract, artifacts);
  const execStatus = executedStatusInfo(contract);

  const counterparty = metadata?.counterparty_name ?? contract.counterparty;
  const contractType = metadata?.contract_type;
  const effectiveDate =
    metadata?.effective_date ?? contract.effective_date ?? null;
  const renewalDate = contract.renewal_date ?? null;
  const owner = contract.owner_display_name ?? null;

  return (
    <section
      className="mt-6 rounded border border-rule p-4"
      data-testid="key-terms-panel"
    >
      <h2 className="text-sm font-medium text-ink">Key Terms</h2>
      <p className="mt-1 text-xs text-ink-subtle">
        Operational summary drawn from repository metadata and document
        artifacts. Edit details to update extracted fields.
      </p>

      <dl
        className="mt-4 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2"
        data-testid="key-terms-grid"
      >
        <KeyTermRow
          label="Counterparty"
          value={counterparty}
          reviewable
          onReviewMetadata={onReviewMetadata}
          data-testid="key-term-counterparty"
        />
        <KeyTermRow
          label="Contract type"
          value={contractType}
          reviewable
          onReviewMetadata={onReviewMetadata}
          data-testid="key-term-contract-type"
        />
        <KeyTermRow
          label="Effective date"
          value={effectiveDate ? formatDate(effectiveDate) : null}
          reviewable
          onReviewMetadata={onReviewMetadata}
          data-testid="key-term-effective-date"
        />
        <KeyTermRow
          label="Renewal date"
          value={renewalDate ? formatDate(renewalDate) : null}
          data-testid="key-term-renewal-date"
        />
        <KeyTermRow
          label="Owner"
          value={owner}
          data-testid="key-term-owner"
        />
        <KeyTermRow
          label="Current document"
          value={currentDoc?.label ?? null}
          data-testid="key-term-current-document"
        />
        <KeyTermRow
          label="Signature status"
          pill={sigStatus}
          data-testid="key-term-signature-status"
        />
        <KeyTermRow
          label="Approval status"
          value={null}
          data-testid="key-term-approval-status"
        />
        <KeyTermRow
          label="Source file"
          value={sourceFileStatus(artifacts)}
          data-testid="key-term-source-file"
        />
        <KeyTermRow
          label="Executed / signed"
          pill={execStatus}
          data-testid="key-term-executed-status"
        />
      </dl>

      <ObligationsSection contractId={contract.id} />
    </section>
  );
}
