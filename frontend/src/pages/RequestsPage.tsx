import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import ActivityExport from "../components/ActivityExport";
import ActivityTimeline from "../components/ActivityTimeline";
import Pill from "../components/ui/Pill";
import PageHeader from "../components/ui/PageHeader";
import WorkspaceCard from "../components/ui/WorkspaceCard";
import RequestApprovalStatusSection from "../components/RequestApprovalStatusSection";
import RequestConvertSection, {
  ConvertedContractLink,
} from "../components/RequestConvertSection";
import RequestUploadConvertSection from "../components/RequestUploadConvertSection";
import SupportingQuestionsPanel from "../components/SupportingQuestionsPanel";
import UploadReviewPanel from "../components/UploadReviewPanel";
import { demoPath, mountedPath } from "../lib/routes";
import { getRequestStage } from "../lib/requestStage";
import {
  ApiError,
  MissingDevUserError,
  cancelRequest,
  createRequest,
  listAgreementTemplates,
  listRequests,
  updateRequest,
} from "../lib/api";
import {
  DEEP_LINK_HIGHLIGHT_CLASS,
  scrollDeepLinkIntoView,
} from "../lib/deepLinkHighlight";
import {
  composeDescription,
  resolveQuestionSet,
  summarizeAnswers,
  type SupportingAnswers,
} from "../lib/supportingQuestions";
import type { AgreementTemplate } from "../types/agreementTemplates";
import type {
  ContractRequest,
  ConvertRequestToContractResponse,
  ConvertRequestUploadResponse,
} from "../types/requests";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; rows: ContractRequest[] }
  | { kind: "error"; message: string };

const PRIORITY_OPTIONS = ["low", "normal", "high", "urgent"] as const;
const REQUEST_TYPE_OPTIONS = [
  "new_contract",
  "review_existing",
  "amendment",
  "renewal",
  "other",
] as const;

export default function RequestsPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const location = useLocation();
  const [includeCancelled, setIncludeCancelled] = useState(false);
  // Track which rows have their approval-status section expanded.
  // Lazy-load on toggle so a long list doesn't fire N approval-status
  // requests on first render.
  const [expandedApprovalIds, setExpandedApprovalIds] = useState<Set<string>>(
    () => new Set(),
  );
  // PR #61: ?request_id=<id> is the remediation deep-link target.
  // When present, we auto-expand the row's approval status, scroll
  // it into view, and apply a subtle highlight. If the id isn't in
  // the current list/filter, we surface a notice so the user isn't
  // silently dropped on the floor.
  const [searchParams] = useSearchParams();
  const deepLinkRequestId = searchParams.get("request_id");
  const deepLinkRowRef = useRef<HTMLLIElement | null>(null);

  const [title, setTitle] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [contractType, setContractType] = useState("");
  const [requestType, setRequestType] = useState("");
  const [priority, setPriority] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [titleTouched, setTitleTouched] = useState(false);
  // PR #126 — optional guided supporting questions, keyed by question
  // id. The map is summarised into `description` at submit time so we
  // never send unsupported fields to the server.
  const [supportingAnswers, setSupportingAnswers] = useState<SupportingAnswers>(
    {},
  );
  // Template-aware supporting questions: the selected template is
  // used only as a *signal* for which question set to render. We do
  // not forward `linked_template_id` from this form — that stays the
  // job of the existing post-create RequestConvertSection so the
  // submit payload shape is unchanged.
  const [templateId, setTemplateId] = useState("");
  const [templates, setTemplates] = useState<AgreementTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);

  useEffect(() => {
    let aborted = false;
    setState({ kind: "loading" });
    listRequests({ include_cancelled: includeCancelled })
      .then((rows) => {
        if (!aborted) setState({ kind: "loaded", rows });
      })
      .catch((err) => {
        if (aborted) return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
        } else {
          setState({ kind: "error", message: "Could not load requests." });
        }
      });
    return () => {
      aborted = true;
    };
  }, [includeCancelled]);

  useEffect(() => {
    if (titleTouched) return;
    const next = [counterparty.trim(), contractType.trim()].filter(Boolean).join(" ");
    setTitle(next);
  }, [counterparty, contractType, titleTouched]);

  // Best-effort lazy load of active Agreement Templates so the
  // intake form can offer a template selector. The selector only
  // drives supporting-question matching; we tolerate failures by
  // leaving the list empty (the selector simply doesn't render
  // additional options).
  useEffect(() => {
    let aborted = false;
    setTemplatesLoading(true);
    listAgreementTemplates({ include_archived: false })
      .then((rows) => {
        if (!aborted) setTemplates(rows);
      })
      .catch(() => {
        // Optional helper — silent fail keeps the form usable.
      })
      .finally(() => {
        if (!aborted) setTemplatesLoading(false);
      });
    return () => {
      aborted = true;
    };
  }, []);

  const activeTemplates = useMemo(
    () => templates.filter((t) => t.status === "active"),
    [templates],
  );
  const selectedTemplate = useMemo(
    () =>
      templateId
        ? activeTemplates.find((t) => t.id === templateId) ?? null
        : null,
    [activeTemplates, templateId],
  );
  const resolvedQuestionSet = useMemo(
    () =>
      resolveQuestionSet({
        template: selectedTemplate,
        requestType,
        contractType,
      }),
    [selectedTemplate, requestType, contractType],
  );

  function applyDueDateOffset(days: number) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    setDueDate(d.toISOString().slice(0, 10));
  }

  async function onCreate() {
    if (!title.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      // PR #126 — fold structured supporting-question answers into the
      // existing description field. The backend doesn't have a typed
      // surface for these answers, so we summarise them so reviewers
      // see them in the Request detail without inventing new schema.
      //
      // The Template-Aware Supporting Questions PR resolves the set
      // through the same precedence the panel renders, so the summary
      // label matches whatever the user saw (e.g. an NDA template
      // selection produces an "NDA review" summary even when the
      // request type is generic).
      const summary = summarizeAnswers(
        resolvedQuestionSet.set,
        supportingAnswers,
      );
      const composed = composeDescription(summary, description);
      const row = await createRequest({
        title: title.trim(),
        description: composed.trim() || null,
        contract_type: contractType.trim() || null,
        request_type: requestType || null,
        priority: priority || null,
        counterparty_name: counterparty.trim() || null,
        due_date: dueDate || null,
      });
      setTitle("");
      setCounterparty("");
      setContractType("");
      setRequestType("");
      setPriority("");
      setDueDate("");
      setDescription("");
      setSupportingAnswers({});
      setTemplateId("");
      setState((prev) =>
        prev.kind === "loaded"
          ? { kind: "loaded", rows: [row, ...prev.rows] }
          : prev,
      );
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Could not create request.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function onMarkInProgress(id: string) {
    try {
      const row = await updateRequest(id, { status: "in_progress" });
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: prev.rows.map((r) => (r.id === id ? row : r)),
            }
          : prev,
      );
    } catch {
      // Best-effort UI; surface via reload if it matters.
    }
  }

  async function onComplete(id: string) {
    try {
      const row = await updateRequest(id, { status: "completed" });
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: prev.rows.map((r) => (r.id === id ? row : r)),
            }
          : prev,
      );
    } catch {
      // best-effort
    }
  }

  async function onCancel(id: string) {
    try {
      await cancelRequest(id);
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: includeCancelled
                ? prev.rows.map((r) =>
                    r.id === id ? { ...r, status: "cancelled" } : r,
                  )
                : prev.rows.filter((r) => r.id !== id),
            }
          : prev,
      );
    } catch {
      // best-effort
    }
  }

  function onToggleApprovalStatus(id: string) {
    setExpandedApprovalIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Auto-expand the deep-link target's approval status as soon as the
  // matching row resolves in the loaded list. We don't pre-emptively
  // open it before load — that would race the row render — and we
  // don't *collapse* it after the user has interacted.
  const deepLinkRowFound =
    deepLinkRequestId !== null &&
    state.kind === "loaded" &&
    state.rows.some((r) => r.id === deepLinkRequestId);
  useEffect(() => {
    if (!deepLinkRequestId) return;
    if (!deepLinkRowFound) return;
    setExpandedApprovalIds((prev) => {
      if (prev.has(deepLinkRequestId)) return prev;
      const next = new Set(prev);
      next.add(deepLinkRequestId);
      return next;
    });
  }, [deepLinkRequestId, deepLinkRowFound]);

  useEffect(() => {
    if (!deepLinkRequestId) return;
    if (!deepLinkRowFound) return;
    scrollDeepLinkIntoView(deepLinkRowRef.current);
  }, [deepLinkRequestId, deepLinkRowFound]);

  function onConverted(response: ConvertRequestToContractResponse) {
    // The backend has already linked + completed the request and
    // resolved the inbox item. Mirror that locally so the row's status
    // chip and convert section update without a refetch.
    setState((prev) =>
      prev.kind === "loaded"
        ? {
            kind: "loaded",
            rows: prev.rows.map((r) =>
              r.id === response.request.id ? response.request : r,
            ),
          }
        : prev,
    );
  }

  // PR #66 — cache the upload-intake suggestions + duplicate
  // warnings keyed by request id so the row keeps the feedback
  // visible after the upload-convert section collapses.
  const [uploadFeedback, setUploadFeedback] = useState<
    Record<string, ConvertRequestUploadResponse>
  >({});

  function onUploaded(response: ConvertRequestUploadResponse) {
    // Same state-swap as the template path — both intake paths end with
    // request.status='completed' and linked_contract_id set, so the UI
    // can collapse them onto the same in-place update.
    setState((prev) =>
      prev.kind === "loaded"
        ? {
            kind: "loaded",
            rows: prev.rows.map((r) =>
              r.id === response.request.id ? response.request : r,
            ),
          }
        : prev,
    );
    setUploadFeedback((prev) => ({
      ...prev,
      [response.request.id]: response,
    }));
  }

  return (
    <div className="space-y-5" data-testid="requests-page">
      <PageHeader
        title="Requests"
        description="The natural place to start work. Create a new request, generate an agreement from a reusable template, or triage the request queue."
        actions={
          <label className="flex items-center gap-2 text-xs text-ink-subtle">
            <input
              type="checkbox"
              checked={includeCancelled}
              onChange={(e) => setIncludeCancelled(e.target.checked)}
            />
            Show cancelled
          </label>
        }
      />

      <RequestsWorkspaceCards />


      <section
        id="new-request"
        className="grid gap-2 rounded border border-rule p-3"
        data-testid="requests-create"
      >
        <h2 className="text-sm font-medium text-ink">New request</h2>
        <input
          className="rounded border border-rule px-2 py-1 text-sm"
          placeholder="Title (e.g. NDA with Acme Corp)"
          value={title}
          onChange={(e) => {
            setTitleTouched(true);
            setTitle(e.target.value);
          }}
        />
        {state.kind === "loaded" && (
          <>
            <datalist id="counterparty-suggestions">
              {Array.from(
                new Set(
                  state.rows
                    .map((r) => r.counterparty_name?.trim())
                    .filter((v): v is string => Boolean(v)),
                ),
              ).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <datalist id="contract-type-suggestions">
              {Array.from(
                new Set(
                  [
                    "NDA",
                    "MSA",
                    "SOW",
                    "DPA",
                    ...state.rows
                      .map((r) => r.contract_type?.trim())
                      .filter((v): v is string => Boolean(v)),
                  ],
                ),
              ).map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Counterparty"
            value={counterparty}
            onChange={(e) => setCounterparty(e.target.value)}
            list="counterparty-suggestions"
          />
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Contract type (NDA, MSA, SOW, ...)"
            value={contractType}
            onChange={(e) => setContractType(e.target.value)}
            list="contract-type-suggestions"
          />
          <select
            className="rounded border border-rule px-2 py-1 text-sm"
            value={requestType}
            onChange={(e) => setRequestType(e.target.value)}
          >
            <option value="">Request type (optional)</option>
            {REQUEST_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt.replace("_", " ")}
              </option>
            ))}
          </select>
          <select
            className="rounded border border-rule px-2 py-1 text-sm"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="">Priority (optional)</option>
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <input
            type="date"
            className="rounded border border-rule px-2 py-1 text-sm"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
            <span>Quick due date:</span>
            <button type="button" className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted" onClick={() => applyDueDateOffset(3)}>+3d</button>
            <button type="button" className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted" onClick={() => applyDueDateOffset(7)}>+1w</button>
            <button type="button" className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted" onClick={() => applyDueDateOffset(14)}>+2w</button>
          </div>
          <select
            className="rounded border border-rule px-2 py-1 text-sm sm:col-span-2"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            data-testid="requests-create-template"
            disabled={templatesLoading && activeTemplates.length === 0}
            aria-label="Agreement template (tailors supporting questions)"
          >
            <option value="">
              {templatesLoading && activeTemplates.length === 0
                ? "Loading agreement templates…"
                : "Agreement template (optional — tailors supporting questions)"}
            </option>
            {activeTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <textarea
          className="rounded border border-rule px-2 py-1 text-sm"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="requests-create-description"
        />
        <SupportingQuestionsPanel
          requestType={requestType}
          contractType={contractType}
          answers={supportingAnswers}
          onChange={setSupportingAnswers}
          set={resolvedQuestionSet.set}
          hint={
            resolvedQuestionSet.source === "template"
              ? "Questions are tailored from the selected Agreement Template."
              : null
          }
          testIdPrefix="requests-create-supporting-questions"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:opacity-50 sm:w-fit sm:py-1.5"
            onClick={onCreate}
            disabled={creating || !title.trim()}
            data-testid="requests-create-submit"
          >
            {creating ? "Creating…" : "Create request"}
          </button>
          {createError && <span className="text-xs text-danger">{createError}</span>}
        </div>
      </section>

      {state.kind === "loading" && (
        <p className="text-sm text-ink-muted">Loading requests…</p>
      )}
      {state.kind === "error" && (
        <p className="text-sm text-danger">{state.message}</p>
      )}
      {state.kind === "loaded" && deepLinkRequestId && !deepLinkRowFound && (
        <p
          className="rounded border border-warning bg-warning/10 px-3 py-2 text-xs text-ink"
          data-testid="requests-deep-link-not-found"
        >
          The linked request <code>{deepLinkRequestId}</code> was not found in
          the current view. Toggle “Show cancelled” if it may have been
          cancelled, or check the request id.
        </p>
      )}
      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title="No requests yet"
          description="Create a request above to start the intake flow. New requests appear here first, then move into approvals and the Repository as work progresses."
        />
      )}
      {state.kind === "loaded" && state.rows.length > 0 && (
        <ul
          id="queue"
          className="space-y-2"
          data-testid="requests-list"
        >
          {state.rows.map((row) => {
            const isDeepLinkTarget = row.id === deepLinkRequestId;
            const stage = getRequestStage(row);
            return (
            <li
              key={row.id}
              ref={isDeepLinkTarget ? deepLinkRowRef : undefined}
              className={`rounded border p-3 text-sm ${
                isDeepLinkTarget
                  ? DEEP_LINK_HIGHLIGHT_CLASS
                  : "border-rule"
              }`}
              data-testid="requests-row"
              data-deep-link-target={isDeepLinkTarget ? "true" : undefined}
              aria-label={
                isDeepLinkTarget ? "Linked request from approval gate" : undefined
              }
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <Link
                    to={mountedPath(`/requests/${encodeURIComponent(row.id)}`, location.pathname)}
                    className="font-medium text-ink underline-offset-2 hover:underline"
                    data-testid="request-title-link"
                  >
                    {row.title}
                  </Link>
                  <p className="text-xs text-ink-subtle">
                    {row.contract_type ?? "Untyped"} ·{" "}
                    <span data-testid="request-status">{row.status}</span>
                    {row.priority ? ` · ${row.priority}` : ""}
                    {row.due_date ? ` · due ${row.due_date}` : ""}
                  </p>
                  <div className="mt-1.5" data-testid="request-stage">
                    <Pill
                      tone={stage.tone}
                      variant="soft"
                      data-testid="request-stage-pill"
                    >
                      {stage.label}
                    </Pill>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {row.status === "open" && (
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                      onClick={() => onMarkInProgress(row.id)}
                    >
                      Start
                    </button>
                  )}
                  {row.status !== "completed" && row.status !== "cancelled" && (
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                      onClick={() => onComplete(row.id)}
                    >
                      Complete
                    </button>
                  )}
                  {row.status !== "cancelled" && (
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
                      onClick={() => onCancel(row.id)}
                    >
                      Cancel
                    </button>
                  )}
                  <Link
                    to={mountedPath(`/requests/${encodeURIComponent(row.id)}`, location.pathname)}
                    className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                    data-testid="request-view-link"
                  >
                    View
                  </Link>
                </div>
              </div>
              {row.counterparty_name && (
                <p className="mt-2 text-xs text-ink-subtle">
                  Counterparty: {row.counterparty_name}
                </p>
              )}
              {row.description && (
                <p className="mt-2 text-sm text-ink-muted">{row.description}</p>
              )}

              {row.status !== "cancelled" && row.linked_contract_id && (
                <div
                  className="mt-3 flex flex-wrap items-baseline gap-2 text-xs"
                  data-testid="request-converted-link"
                >
                  <span className="text-ink-subtle">Linked Repository record:</span>
                  <ConvertedContractLink
                    contractId={row.linked_contract_id}
                  />
                </div>
              )}

              {uploadFeedback[row.id] && (
                <UploadReviewPanel
                  contract={{
                    id: uploadFeedback[row.id].contract.id,
                    title: uploadFeedback[row.id].contract.title,
                  }}
                  extractedMetadata={
                    uploadFeedback[row.id].extracted_metadata
                  }
                  duplicateCandidates={
                    uploadFeedback[row.id].duplicate_candidates
                  }
                  context="request_upload"
                  dataTestId="request-upload-feedback"
                />
              )}

              {row.status !== "cancelled" &&
                !row.linked_contract_id &&
                row.linked_template_id && (
                  <RequestConvertSection
                    request={row}
                    onConverted={onConverted}
                  />
                )}

              {row.status !== "cancelled" &&
                !row.linked_contract_id &&
                !row.linked_template_id && (
                  <p
                    className="mt-3 text-xs text-ink-subtle"
                    data-testid="request-no-template-hint"
                  >
                    Link an agreement template to this request to generate a
                    draft agreement, or upload an external agreement below.
                  </p>
                )}

              {row.status !== "cancelled" && !row.linked_contract_id && (
                <RequestUploadConvertSection
                  request={row}
                  onConverted={onUploaded}
                />
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                  onClick={() => onToggleApprovalStatus(row.id)}
                  data-testid="request-approval-toggle"
                  aria-expanded={expandedApprovalIds.has(row.id)}
                >
                  {expandedApprovalIds.has(row.id)
                    ? "Hide approval status"
                    : "View approval status"}
                </button>
              </div>
              {expandedApprovalIds.has(row.id) && (
                <>
                  <RequestApprovalStatusSection requestId={row.id} />
                  <div className="mt-3" data-testid="request-activity-section">
                    <p className="text-xs font-medium text-ink">Activity</p>
                    <ActivityTimeline kind="request" requestId={row.id} />
                    <ActivityExport kind="request" requestId={row.id} />
                  </div>
                </>
              )}
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface WorkspaceCard {
  to: string;
  title: string;
  description: string;
  testId: string;
  variant: "primary" | "default";
}

const WORKSPACE_CARDS: WorkspaceCard[] = [
  {
    to: demoPath("/requests#new-request"),
    title: "New request",
    description:
      "Ask legal or commercial to review or create an agreement. The request lands in the queue below.",
    testId: "requests-card-new",
    variant: "primary",
  },
  {
    to: demoPath("/requests/templates"),
    title: "Start from template",
    description:
      "Generate a draft agreement from an approved template. Templates fill counterparty, dates, and other variables for you.",
    testId: "requests-card-start-from-template",
    variant: "primary",
  },
  {
    to: demoPath("/requests#queue"),
    title: "Upload third-party agreement",
    description:
      "Convert a request into a Repository contract from a PDF or Word document — counterparty paper, signed exhibit, or any external agreement.",
    testId: "requests-card-upload",
    variant: "primary",
  },
  {
    to: demoPath("/requests/templates"),
    title: "Agreement templates",
    description:
      "Manage reusable agreement templates and their variables.",
    testId: "requests-card-manage-templates",
    variant: "default",
  },
  {
    to: demoPath("/requests#queue"),
    title: "Request queue",
    description:
      "Track open and completed intake requests in the list below.",
    testId: "requests-card-queue",
    variant: "default",
  },
];

function RequestsWorkspaceCards() {
  return (
    <section
      className="grid gap-3 sm:grid-cols-2"
      data-testid="requests-workspace-cards"
      aria-label="Requests workspace"
    >
      {WORKSPACE_CARDS.map((card) => {
        const isAnchor = card.to.includes("#");
        const hash = isAnchor ? `#${card.to.split("#")[1]}` : undefined;
        if (isAnchor && hash) {
          return (
            <WorkspaceCard
              key={card.testId}
              href={hash}
              title={card.title}
              description={card.description}
              testId={card.testId}
              variant={card.variant}
            />
          );
        }
        return (
          <WorkspaceCard
            key={card.testId}
            to={card.to}
            title={card.title}
            description={card.description}
            testId={card.testId}
            variant={card.variant}
          />
        );
      })}
    </section>
  );
}
