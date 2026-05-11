import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { ApiError, updateContractMetadata } from "../lib/api";
import { demoPath } from "../lib/routes";
import type {
  ContractMetadataUpdateRequest,
  ContractMetadataView,
  DuplicateContractCandidate,
  ExtractedContractMetadata,
} from "../types/contractIntake";

export type UploadReviewContext =
  | "repository_upload"
  | "request_upload";

interface ContractSummary {
  id: string;
  title: string;
}

interface Props {
  contract: ContractSummary;
  extractedMetadata?: ExtractedContractMetadata | null;
  duplicateCandidates?: DuplicateContractCandidate[];
  /** Optional initial saved state. When absent, the panel derives the
   *  "saved" view from ``contract.title`` + the suggested metadata
   *  (no values for counterparty/contract_type/effective_date until
   *  the user saves). */
  initialSavedMetadata?: ContractMetadataView | null;
  /** Optional callback fired after a successful save. */
  onSaved?: (view: ContractMetadataView) => void;
  context: UploadReviewContext;
  dataTestId?: string;
}

interface FormState {
  title: string;
  counterparty_name: string;
  contract_type: string;
  effective_date: string;
}

/**
 * Post-upload "Review upload" panel (PR #67).
 *
 * Layout:
 *   1. Confirmation header — "Your file was added to the Repository."
 *   2. Editable metadata section — pre-filled with the saved values
 *      when present, otherwise with the deterministic suggestions
 *      from PR #66. Empty strings on save clear the non-title fields.
 *   3. Duplicate-candidate section — warning when candidates exist,
 *      quiet "No obvious duplicates" line otherwise.
 *   4. Next-action link — "Open in Repository".
 *
 * The panel never auto-deletes duplicates, never auto-merges, and
 * never overwrites user-provided values. Duplicate dismissal is
 * client-side only ("Keep as new record" collapses the warning).
 */
export default function UploadReviewPanel({
  contract,
  extractedMetadata,
  duplicateCandidates,
  initialSavedMetadata,
  onSaved,
  context,
  dataTestId,
}: Props) {
  const initialForm = useMemo<FormState>(
    () => buildInitialForm(contract, initialSavedMetadata, extractedMetadata),
    [contract, initialSavedMetadata, extractedMetadata],
  );
  const [form, setForm] = useState<FormState>(initialForm);
  const [savedView, setSavedView] = useState<ContractMetadataView | null>(
    initialSavedMetadata ?? null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateDismissed, setDuplicateDismissed] = useState(false);

  // Reset the form when the underlying contract changes (e.g. user
  // navigates from one converted request to another). Without this,
  // closing + reopening a different row would still show the prior
  // form state.
  useEffect(() => {
    setForm(initialForm);
    setSavedView(initialSavedMetadata ?? null);
    setDuplicateDismissed(false);
    setError(null);
  }, [contract.id, initialForm, initialSavedMetadata]);

  const dupes = duplicateCandidates ?? [];
  const headerCopy =
    context === "request_upload"
      ? "Your file was added to the Repository and linked to this request. Confirm the details below."
      : "Your file was added to the Repository. Confirm the details below.";

  async function onSave(): Promise<void> {
    setSubmitting(true);
    setError(null);
    const payload: ContractMetadataUpdateRequest = {
      title: form.title.trim() || null,
      counterparty_name: form.counterparty_name.trim()
        ? form.counterparty_name.trim()
        : "",
      contract_type: form.contract_type.trim()
        ? form.contract_type.trim()
        : "",
      effective_date: form.effective_date || null,
    };
    try {
      const next = await updateContractMetadata(contract.id, payload);
      setSavedView(next);
      // Reset the form to the canonical saved values so empty inputs
      // post-save show empty rather than the prior suggestion.
      setForm({
        title: next.title,
        counterparty_name: next.counterparty_name ?? "",
        contract_type: next.contract_type ?? "",
        effective_date: next.effective_date ?? "",
      });
      onSaved?.(next);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Could not save details.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="mt-3 space-y-3 rounded border border-rule bg-canvas p-3 text-sm"
      data-testid={dataTestId ?? "upload-review-panel"}
    >
      <header data-testid="upload-review-header">
        <p className="text-sm font-medium text-ink">Review upload</p>
        <p className="mt-1 text-xs text-ink-muted">{headerCopy}</p>
      </header>

      <section
        className="grid gap-2 rounded border border-rule p-3"
        data-testid="upload-review-form"
        aria-label="Confirm contract details"
      >
        <p className="text-xs font-medium text-ink">Confirm details</p>
        <FormField
          label="Title"
          value={form.title}
          onChange={(v) => setForm((f) => ({ ...f, title: v }))}
          suggestion={extractedMetadata?.suggested_title ?? null}
          savedValue={savedView?.title ?? null}
          inputTestId="upload-review-title"
        />
        <FormField
          label="Contract type"
          value={form.contract_type}
          onChange={(v) => setForm((f) => ({ ...f, contract_type: v }))}
          suggestion={extractedMetadata?.likely_contract_type ?? null}
          savedValue={savedView?.contract_type ?? null}
          inputTestId="upload-review-contract-type"
        />
        <FormField
          label="Counterparty"
          value={form.counterparty_name}
          onChange={(v) => setForm((f) => ({ ...f, counterparty_name: v }))}
          suggestion={extractedMetadata?.possible_counterparty_name ?? null}
          savedValue={savedView?.counterparty_name ?? null}
          inputTestId="upload-review-counterparty"
        />
        <FormField
          label="Effective date"
          value={form.effective_date}
          onChange={(v) => setForm((f) => ({ ...f, effective_date: v }))}
          suggestion={extractedMetadata?.effective_date ?? null}
          savedValue={savedView?.effective_date ?? null}
          inputTestId="upload-review-effective-date"
          inputType="date"
          placeholder="YYYY-MM-DD"
        />
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="rounded border border-ink bg-ink px-3 py-1.5 text-xs text-canvas disabled:opacity-50"
            onClick={onSave}
            disabled={submitting}
            data-testid="upload-review-save"
          >
            {submitting ? "Saving…" : "Save details"}
          </button>
          {error && (
            <span
              className="text-xs text-danger"
              data-testid="upload-review-error"
            >
              {error}
            </span>
          )}
          {savedView && savedView.changed_fields.length > 0 && !submitting && !error && (
            <span
              className="text-xs text-success"
              data-testid="upload-review-saved"
            >
              Saved {savedView.changed_fields.length} field
              {savedView.changed_fields.length === 1 ? "" : "s"}.
            </span>
          )}
        </div>
        {extractedMetadata?.warnings && extractedMetadata.warnings.length > 0 && (
          <p
            className="text-[11px] text-ink-subtle"
            data-testid="upload-review-warnings"
          >
            Auto-detection notes:{" "}
            {extractedMetadata.warnings.join(", ")}
          </p>
        )}
      </section>

      <section
        data-testid="upload-review-duplicates"
        aria-label="Possible duplicate records"
      >
        {dupes.length > 0 && !duplicateDismissed ? (
          <div
            className="rounded border border-warning-ring bg-warning-soft px-3 py-2 text-xs text-ink"
            data-testid="upload-review-duplicate-warning"
          >
            <p className="font-medium">
              Possible duplicate record{dupes.length === 1 ? "" : "s"} found
            </p>
            <p className="mt-1 text-ink-muted">
              Whereas didn&apos;t auto-merge anything. Open a candidate to
              confirm, or keep this upload as a new record.
            </p>
            <ul className="mt-2 space-y-1">
              {dupes.map((c) => (
                <li
                  key={c.contract_id}
                  data-testid="upload-review-duplicate-row"
                >
                  <Link
                    to={demoPath(
                      `/repository/${encodeURIComponent(c.contract_id)}`,
                    )}
                    className="font-medium text-ink underline hover:text-accent-ring"
                    data-testid="upload-review-duplicate-link"
                  >
                    {c.title}
                  </Link>
                  <span className="ml-2 text-ink-subtle">
                    · {humanReason(c.reason)} ({c.confidence})
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap gap-3">
              <button
                type="button"
                className="text-xs text-ink-subtle underline hover:text-ink"
                onClick={() => setDuplicateDismissed(true)}
                data-testid="upload-review-keep-as-new"
              >
                Keep as new record
              </button>
            </div>
          </div>
        ) : (
          <p
            className="text-xs text-ink-subtle"
            data-testid="upload-review-no-duplicates"
          >
            {dupes.length === 0
              ? "No obvious duplicates found."
              : "Duplicate warning dismissed. The new record stays in Repository."}
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Link
          to={demoPath(`/repository/${encodeURIComponent(contract.id)}`)}
          className="rounded border border-rule px-3 py-1 text-xs text-ink hover:bg-canvas-muted"
          data-testid="upload-review-open-in-repository"
        >
          Open in Repository
        </Link>
      </div>
    </div>
  );
}

function buildInitialForm(
  contract: ContractSummary,
  saved: ContractMetadataView | null | undefined,
  extracted: ExtractedContractMetadata | null | undefined,
): FormState {
  return {
    title: saved?.title ?? contract.title ?? "",
    counterparty_name:
      saved?.counterparty_name ??
      extracted?.possible_counterparty_name ??
      "",
    contract_type:
      saved?.contract_type ?? extracted?.likely_contract_type ?? "",
    effective_date: saved?.effective_date ?? extracted?.effective_date ?? "",
  };
}

interface FormFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  suggestion: string | null;
  savedValue: string | null;
  inputTestId: string;
  inputType?: string;
  placeholder?: string;
}

function FormField({
  label,
  value,
  onChange,
  suggestion,
  savedValue,
  inputTestId,
  inputType,
  placeholder,
}: FormFieldProps) {
  const showSuggestion =
    suggestion != null && suggestion !== "" && suggestion !== value;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink">{label}</span>
      <input
        type={inputType ?? "text"}
        className="rounded border border-rule px-2 py-1 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        data-testid={inputTestId}
      />
      {showSuggestion && (
        <span
          className="text-[11px] text-ink-subtle"
          data-testid={`${inputTestId}-suggestion`}
        >
          Suggested: {suggestion}
        </span>
      )}
      {savedValue && savedValue !== value && (
        <span className="text-[11px] text-ink-subtle">
          Saved value: {savedValue}
        </span>
      )}
    </label>
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
