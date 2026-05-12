import { useEffect, useId, useMemo, useRef, useState } from "react";

import SupportingQuestionsPanel from "./SupportingQuestionsPanel";
import {
  composeDescription,
  getQuestionSetFor,
  summarizeAnswers,
  type SupportingAnswers,
} from "../lib/supportingQuestions";
import type { AgreementTemplate } from "../types/agreementTemplates";

/**
 * Submitted payload shape. Only `name`, `requestType`, `priority`,
 * `templateId`, and `supportingInfo` map to fields the existing
 * `POST /api/requests` endpoint accepts (as `title`, `request_type`,
 * `priority`, `linked_template_id`, and `description`). The remaining
 * fields are workflow-conveniences for the route notice only — they
 * must NOT be forwarded to the server.
 */
export interface MoveToReviewValues {
  name: string;
  requestType: string;
  templateId: string | null;
  priority: string;
  owner: string;
  department: string;
  supportingInfo: string;
}

interface Props {
  open: boolean;
  /** The single inbox item being routed. Null when multi-select or none. */
  itemTitle: string | null;
  /**
   * How many inbox items are currently selected. When > 1 the modal
   * stays in a disabled "single-item-only" state so we never silently
   * fan one form across multiple items.
   */
  selectedCount: number;
  demoMode: boolean;
  busy: boolean;
  /** Available agreement templates for the optional Template selector. */
  templates: AgreementTemplate[];
  templatesLoading: boolean;
  onCancel: () => void;
  onSubmit: (values: MoveToReviewValues) => void | Promise<void>;
}

const REQUEST_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "review_existing", label: "Review existing contract" },
  { value: "new_contract", label: "New contract" },
  { value: "nda_review", label: "NDA review" },
  { value: "vendor_agreement", label: "Vendor agreement" },
  { value: "customer_contract", label: "Customer contract" },
  { value: "employment_agreement", label: "Employment agreement" },
  { value: "amendment", label: "Amendment" },
  { value: "renewal", label: "Renewal" },
  { value: "other", label: "Other" },
];

const PRIORITY_OPTIONS = ["low", "normal", "high", "urgent"];

/**
 * PR #117 — Move to Review / supporting-information modal.
 *
 * Mirrors the Summize-style intake step that asks for the supporting
 * information legal needs before a Request enters the workflow. Kept
 * narrow:
 *
 *   • Only single-item routing is supported. If the user selected 2+
 *     items, the modal renders in a disabled state with an honest
 *     "one item at a time" notice rather than silently fanning out.
 *   • Approval tasks must never reach this modal — the parent gates
 *     that at the bulk-actions level.
 *   • Submitted fields the server accepts are forwarded; demo-only
 *     workflow conveniences (owner, department) are surfaced in the
 *     route notice and are NOT sent to the server.
 */
export default function MoveToReviewModal(props: Props) {
  const {
    open,
    itemTitle,
    selectedCount,
    demoMode,
    busy,
    templates,
    templatesLoading,
    onCancel,
    onSubmit,
  } = props;

  const titleId = useId();
  const [name, setName] = useState("");
  const [requestType, setRequestType] = useState("review_existing");
  const [templateId, setTemplateId] = useState("");
  const [priority, setPriority] = useState("normal");
  const [owner, setOwner] = useState("");
  const [department, setDepartment] = useState("");
  const [supportingInfo, setSupportingInfo] = useState("");
  const [supportingAnswers, setSupportingAnswers] = useState<SupportingAnswers>(
    {},
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [requestTypeError, setRequestTypeError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const multiItem = selectedCount > 1;

  // Default the name to the selected item's title when the modal opens.
  useEffect(() => {
    if (!open) return;
    setName(itemTitle ?? "");
    setNameError(null);
    setRequestTypeError(null);
    setSupportingAnswers({});
    // Focus the name input on open so keyboard users can start typing.
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, [open, itemTitle]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  const activeTemplates = useMemo(
    () => templates.filter((t) => t.status === "active"),
    [templates],
  );

  if (!open) return null;

  function handleSubmit() {
    if (multiItem) return;
    const trimmedName = name.trim();
    let valid = true;
    if (!trimmedName) {
      setNameError("Request name is required.");
      nameInputRef.current?.focus();
      valid = false;
    } else {
      setNameError(null);
    }
    if (!requestType) {
      setRequestTypeError("Request type is required.");
      valid = false;
    } else {
      setRequestTypeError(null);
    }
    if (!valid) return;
    // PR #126 — fold structured supporting-question answers into the
    // existing free-text `supportingInfo` field. The parent will map
    // that to the request's `description`, so this stays inside the
    // existing backend contract — no new schema, no new endpoint.
    const summary = summarizeAnswers(
      getQuestionSetFor(requestType, null),
      supportingAnswers,
    );
    const composedSupportingInfo = composeDescription(
      summary,
      supportingInfo,
    ).trim();
    void onSubmit({
      name: trimmedName,
      requestType,
      templateId: templateId ? templateId : null,
      priority,
      owner: owner.trim(),
      department: department.trim(),
      supportingInfo: composedSupportingInfo,
    });
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget && !busy) onCancel();
  }

  const submitDisabled = busy || multiItem;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="move-to-review-modal"
      onClick={handleBackdropClick}
    >
      <div className="w-full max-w-xl rounded border border-rule bg-canvas p-5 text-sm text-ink shadow-xl">
        <h2
          id={titleId}
          className="text-base font-semibold text-ink"
          data-testid="move-to-review-modal-title"
        >
          Move to Review
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          Add the supporting information legal needs before this becomes a
          Request.
        </p>

        {multiItem ? (
          <p
            className="mt-4 rounded border border-warning-ring bg-warning-soft px-3 py-2 text-xs text-warning"
            data-testid="move-to-review-multi-notice"
          >
            Move to Review currently supports one intake item at a time.
            Reduce the selection to a single item to continue.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-ink-muted sm:col-span-2">
              <span>
                Request name
                <span aria-hidden="true" className="text-danger"> *</span>
              </span>
              <input
                ref={nameInputRef}
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="move-to-review-name"
                aria-invalid={nameError ? "true" : "false"}
                aria-describedby={
                  nameError ? `${titleId}-name-error` : undefined
                }
              />
              {nameError && (
                <span
                  id={`${titleId}-name-error`}
                  className="block text-xs text-danger"
                  data-testid="move-to-review-name-error"
                >
                  {nameError}
                </span>
              )}
            </label>
            <label className="space-y-1 text-xs text-ink-muted">
              <span>
                Request type
                <span aria-hidden="true" className="text-danger"> *</span>
              </span>
              <select
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={requestType}
                onChange={(e) => setRequestType(e.target.value)}
                data-testid="move-to-review-request-type"
                aria-invalid={requestTypeError ? "true" : "false"}
              >
                <option value="" disabled>
                  Select a type
                </option>
                {REQUEST_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {requestTypeError && (
                <span
                  className="block text-xs text-danger"
                  data-testid="move-to-review-request-type-error"
                >
                  {requestTypeError}
                </span>
              )}
            </label>
            <label className="space-y-1 text-xs text-ink-muted">
              <span>Agreement template</span>
              <select
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                data-testid="move-to-review-template"
                disabled={templatesLoading}
              >
                <option value="">
                  {templatesLoading
                    ? "Loading templates…"
                    : "No template / third-party paper"}
                </option>
                {activeTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-ink-muted">
              <span>Priority</span>
              <select
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                data-testid="move-to-review-priority"
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-ink-muted">
              <span>Owner / requester</span>
              <input
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="Name or email"
                data-testid="move-to-review-owner"
              />
            </label>
            <label className="space-y-1 text-xs text-ink-muted">
              <span>Department / business unit</span>
              <input
                className="w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="e.g. Sales, Engineering"
                data-testid="move-to-review-department"
              />
            </label>
            <label className="space-y-1 text-xs text-ink-muted sm:col-span-2">
              <span>Supporting information</span>
              <textarea
                className="h-24 w-full rounded border border-rule px-2 py-1 text-sm text-ink"
                value={supportingInfo}
                onChange={(e) => setSupportingInfo(e.target.value)}
                placeholder="Counterparty, deal value, jurisdiction, urgency, anything legal should know up-front."
                data-testid="move-to-review-supporting-info"
              />
            </label>
            <div className="sm:col-span-2">
              <SupportingQuestionsPanel
                requestType={requestType}
                contractType={null}
                answers={supportingAnswers}
                onChange={setSupportingAnswers}
                testIdPrefix="move-to-review-supporting-questions"
              />
            </div>
          </div>
        )}

        {!demoMode && !multiItem && (
          <p
            className="mt-4 rounded border border-info-ring bg-info-soft px-3 py-2 text-xs text-info"
            data-testid="move-to-review-real-note"
          >
            Submitting creates a Request via the existing Requests API using
            only the fields it accepts (name, request type, template, priority,
            supporting information). Owner and department are workflow
            conveniences and aren&apos;t sent to the server.
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded border border-rule bg-canvas px-3 py-1 text-xs text-ink hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onCancel}
            disabled={busy}
            data-testid="move-to-review-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded border border-ink bg-ink px-3 py-1 text-xs font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={handleSubmit}
            disabled={submitDisabled}
            data-testid="move-to-review-submit"
          >
            {busy ? "Routing…" : "Send for review"}
          </button>
        </div>
      </div>
    </div>
  );
}
