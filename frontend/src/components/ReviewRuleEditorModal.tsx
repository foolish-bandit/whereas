import { useEffect, useId, useRef, useState } from "react";

import {
  REVIEW_RULE_CONTRACT_TYPES,
  REVIEW_RULE_SEVERITIES,
  type ReviewRuleInput,
  type ReviewRuleSeverity,
  type ReviewRuleStatus,
} from "../types/reviewRules";

interface Props {
  open: boolean;
  demoMode: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: ReviewRuleInput) => void | Promise<void>;
}

const EMPTY: ReviewRuleInput = {
  issue: "",
  contract_type: "Any",
  severity: "medium",
  standard_position: "",
  fallback_position: "",
  canned_response: "",
  example_clause: "",
  status: "active",
};

/**
 * PR #118 — Add Review Rule modal.
 *
 * Used by the Playbooks grid foundation. Demo mode: parent appends the
 * row to local state. Real mode: parent renders a route notice saying
 * the grid is demo-only and points at the existing YAML playbook
 * authoring flow — this modal never posts to the server.
 */
export default function ReviewRuleEditorModal(props: Props) {
  const { open, demoMode, busy, onCancel, onSubmit } = props;

  const titleId = useId();
  const [values, setValues] = useState<ReviewRuleInput>(EMPTY);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [standardError, setStandardError] = useState<string | null>(null);
  const issueRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues(EMPTY);
    setIssueError(null);
    setStandardError(null);
    issueRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  function update<K extends keyof ReviewRuleInput>(
    key: K,
    next: ReviewRuleInput[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: next }));
  }

  function handleSubmit() {
    const issue = values.issue.trim();
    const standard = values.standard_position.trim();
    let valid = true;
    if (!issue) {
      setIssueError("Issue is required.");
      issueRef.current?.focus();
      valid = false;
    } else {
      setIssueError(null);
    }
    if (!standard) {
      setStandardError("Standard position is required.");
      valid = false;
    } else {
      setStandardError(null);
    }
    if (!valid) return;
    void onSubmit({
      ...values,
      issue,
      standard_position: standard,
      fallback_position: values.fallback_position.trim(),
      canned_response: values.canned_response.trim(),
      example_clause: values.example_clause.trim(),
    });
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget && !busy) onCancel();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="review-rule-modal"
      onClick={handleBackdropClick}
    >
      <div className="w-full max-w-2xl rounded border border-rule bg-canvas p-5 text-sm text-ink shadow-xl">
        <h2
          id={titleId}
          className="text-base font-semibold text-ink"
          data-testid="review-rule-modal-title"
        >
          Add review rule
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          Capture an issue plus the firm&apos;s standard position, optional
          fallback, canned response, and a short example clause.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-ink-muted sm:col-span-2">
            <span>
              Issue / topic
              <span aria-hidden="true" className="text-danger"> *</span>
            </span>
            <input
              ref={issueRef}
              className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={values.issue}
              onChange={(e) => update("issue", e.target.value)}
              placeholder="e.g. Limitation of liability uncapped"
              data-testid="review-rule-issue"
              aria-invalid={issueError ? "true" : "false"}
              aria-describedby={
                issueError ? `${titleId}-issue-error` : undefined
              }
            />
            {issueError && (
              <span
                id={`${titleId}-issue-error`}
                className="block text-xs text-danger"
                data-testid="review-rule-issue-error"
              >
                {issueError}
              </span>
            )}
          </label>
          <label className="space-y-1 text-xs text-ink-muted">
            <span>Contract type</span>
            <select
              className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={values.contract_type}
              onChange={(e) => update("contract_type", e.target.value)}
              data-testid="review-rule-contract-type"
            >
              {REVIEW_RULE_CONTRACT_TYPES.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-ink-muted">
            <span>Severity / risk</span>
            <select
              className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={values.severity}
              onChange={(e) =>
                update("severity", e.target.value as ReviewRuleSeverity)
              }
              data-testid="review-rule-severity"
            >
              {REVIEW_RULE_SEVERITIES.map((opt) => (
                <option key={opt} value={opt}>
                  {opt.charAt(0).toUpperCase() + opt.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-ink-muted sm:col-span-2">
            <span>
              Standard position
              <span aria-hidden="true" className="text-danger"> *</span>
            </span>
            <textarea
              className="h-20 w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={values.standard_position}
              onChange={(e) => update("standard_position", e.target.value)}
              placeholder="The firm's preferred outcome on this issue."
              data-testid="review-rule-standard"
              aria-invalid={standardError ? "true" : "false"}
              aria-describedby={
                standardError ? `${titleId}-standard-error` : undefined
              }
            />
            {standardError && (
              <span
                id={`${titleId}-standard-error`}
                className="block text-xs text-danger"
                data-testid="review-rule-standard-error"
              >
                {standardError}
              </span>
            )}
          </label>
          <label className="space-y-1 text-xs text-ink-muted sm:col-span-2">
            <span>Fallback position</span>
            <textarea
              className="h-16 w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={values.fallback_position}
              onChange={(e) => update("fallback_position", e.target.value)}
              placeholder="Acceptable second-best if the standard can't be obtained."
              data-testid="review-rule-fallback"
            />
          </label>
          <label className="space-y-1 text-xs text-ink-muted sm:col-span-2">
            <span>Canned response</span>
            <textarea
              className="h-16 w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={values.canned_response}
              onChange={(e) => update("canned_response", e.target.value)}
              placeholder="Pre-written reviewer reply suggesting the change."
              data-testid="review-rule-canned"
            />
          </label>
          <label className="space-y-1 text-xs text-ink-muted sm:col-span-2">
            <span>Example clause</span>
            <textarea
              className="h-16 w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={values.example_clause}
              onChange={(e) => update("example_clause", e.target.value)}
              placeholder="Short, safe sample language a reviewer can paste."
              data-testid="review-rule-example"
            />
          </label>
          <label className="space-y-1 text-xs text-ink-muted">
            <span>Status</span>
            <select
              className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
              value={values.status}
              onChange={(e) =>
                update("status", e.target.value as ReviewRuleStatus)
              }
              data-testid="review-rule-status"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>

        {!demoMode && (
          <p
            className="mt-4 rounded border border-info-ring bg-info-soft px-3 py-2 text-xs text-info"
            data-testid="review-rule-real-note"
          >
            The Playbooks grid is a workspace foundation today. Adds stay in
            this browser session and are not persisted to the server — the
            authoritative source is still the YAML playbook files below.
            Clause Manager integration is future work.
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded border border-rule bg-canvas px-3 py-1 text-xs text-ink hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onCancel}
            disabled={busy}
            data-testid="review-rule-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded border border-ink bg-ink px-3 py-1 text-xs font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={handleSubmit}
            disabled={busy}
            data-testid="review-rule-submit"
          >
            {busy ? "Adding…" : "Add review rule"}
          </button>
        </div>
      </div>
    </div>
  );
}
