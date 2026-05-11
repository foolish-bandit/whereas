import { Link } from "react-router-dom";

import { demoPath } from "../lib/routes";
import type {
  DuplicateContractCandidate,
  ExtractedContractMetadata,
} from "../types/contractIntake";

interface Props {
  extracted?: ExtractedContractMetadata | null;
  duplicates?: DuplicateContractCandidate[];
  /** Optional dataTestId override so the parent can disambiguate
   *  between multiple instances (e.g. one per intake surface). */
  dataTestId?: string;
}

/**
 * Shared post-upload feedback (PR #66) for the Repository upload page
 * and the per-request convert-upload section.
 *
 * Renders two informational blocks when either has content:
 *   * "We noticed this looks like an NDA effective 2026-05-01"
 *   * "Possible duplicates" — links to the matching contract rows.
 *
 * Both are deliberately quiet: missing data simply hides the block
 * (an empty list is a no-op, not a "no duplicates" banner). The
 * intent is to add visibility without taking the decision out of the
 * user's hands — duplicate detection is warning-only on this PR.
 */
export default function UploadIntakeFeedback({
  extracted,
  duplicates,
  dataTestId,
}: Props): JSX.Element | null {
  const hasMetadata = hasAnyMetadata(extracted);
  const dupes = duplicates ?? [];
  if (!hasMetadata && dupes.length === 0) return null;

  return (
    <div
      className="mt-3 space-y-2"
      data-testid={dataTestId ?? "upload-intake-feedback"}
    >
      {dupes.length > 0 && (
        <div
          className="rounded border border-warning-ring bg-warning-soft px-3 py-2 text-xs text-ink"
          data-testid="upload-duplicate-warning"
        >
          <p className="font-medium">
            Possible duplicate{dupes.length === 1 ? "" : "s"} in Repository
          </p>
          <p className="mt-1 text-ink-muted">
            This upload matched {dupes.length} existing contract
            {dupes.length === 1 ? "" : "s"}. Open one to confirm whether
            it&apos;s the same agreement.
          </p>
          <ul className="mt-2 space-y-1">
            {dupes.map((c) => (
              <li key={c.contract_id} data-testid="upload-duplicate-row">
                <Link
                  to={demoPath(`/contracts/${encodeURIComponent(c.contract_id)}`)}
                  className="font-medium text-ink underline hover:text-accent-ring"
                >
                  {c.title}
                </Link>
                <span className="ml-2 text-ink-subtle">
                  · {humanReason(c.reason)} ({c.confidence})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {hasMetadata && extracted && (
        <div
          className="rounded border border-rule bg-canvas-subtle px-3 py-2 text-xs text-ink-muted"
          data-testid="upload-extracted-metadata"
        >
          <p className="font-medium text-ink">Auto-detected from this file</p>
          <dl className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
            {extracted.likely_contract_type && (
              <Row
                label="Contract type"
                value={extracted.likely_contract_type}
                testId="upload-meta-contract-type"
              />
            )}
            {extracted.possible_counterparty_name && (
              <Row
                label="Counterparty"
                value={extracted.possible_counterparty_name}
                testId="upload-meta-counterparty"
              />
            )}
            {extracted.effective_date && (
              <Row
                label="Effective date"
                value={extracted.effective_date}
                testId="upload-meta-effective-date"
              />
            )}
            {extracted.suggested_title && (
              <Row
                label="Suggested title"
                value={extracted.suggested_title}
                testId="upload-meta-suggested-title"
              />
            )}
          </dl>
          <p className="mt-1 text-[11px] text-ink-subtle">
            Suggestions only. Review before relying on them.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="flex gap-2" data-testid={testId}>
      <dt className="text-ink-subtle">{label}:</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function hasAnyMetadata(meta: ExtractedContractMetadata | null | undefined): boolean {
  if (!meta) return false;
  return Boolean(
    meta.suggested_title ||
      meta.likely_contract_type ||
      meta.possible_counterparty_name ||
      meta.effective_date,
  );
}

function humanReason(reason: DuplicateContractCandidate["reason"]): string {
  switch (reason) {
    case "exact_file_hash":
      return "exact file match";
    case "similar_title_and_counterparty":
      return "matching title and counterparty";
    case "similar_title":
      return "matching title";
    default:
      return reason;
  }
}
