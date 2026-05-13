import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import ActivityExport from "../components/ActivityExport";
import ActivityTimeline from "../components/ActivityTimeline";
import EmptyState from "../components/EmptyState";
import Pill from "../components/ui/Pill";
import RequestApprovalStatusSection from "../components/RequestApprovalStatusSection";
import RequestConvertSection from "../components/RequestConvertSection";
import RequestUploadConvertSection from "../components/RequestUploadConvertSection";
import StatusBadge from "../components/StatusBadge";
import UploadReviewPanel from "../components/UploadReviewPanel";
import {
  ApiError,
  MissingDevUserError,
  getContracts,
  getRequest,
  getRequestApprovalStatus,
} from "../lib/api";
import { formatDateTime, humanizeFieldName } from "../lib/format";
import { mountedPath } from "../lib/routes";
import { getRequestStage } from "../lib/requestStage";
import { parseSupportingQuestionsBlock } from "../lib/supportingQuestions";
import type { ContractListItem } from "../types/contracts";
import type { RequestApprovalStatus } from "../types/requestApprovalStatus";
import type {
  ContractRequest,
  ConvertRequestToContractResponse,
  ConvertRequestUploadResponse,
} from "../types/requests";

type RequestState =
  | { kind: "loading" }
  | { kind: "loaded"; request: ContractRequest }
  | { kind: "error"; message: string; notFound?: boolean };

type ApprovalState =
  | { kind: "loading" }
  | { kind: "loaded"; status: RequestApprovalStatus }
  | { kind: "error"; message: string };

type LinkedRepositoryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; record: ContractListItem | null }
  | { kind: "error"; message: string };

export default function RequestDetailPage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const [requestState, setRequestState] = useState<RequestState>({
    kind: "loading",
  });
  const [approvalState, setApprovalState] = useState<ApprovalState>({
    kind: "loading",
  });
  const [linkedState, setLinkedState] = useState<LinkedRepositoryState>({
    kind: "idle",
  });
  const [uploadFeedback, setUploadFeedback] =
    useState<ConvertRequestUploadResponse | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!id) return;
    let aborted = false;
    setRequestState({ kind: "loading" });
    getRequest(id)
      .then((request) => {
        if (!aborted) setRequestState({ kind: "loaded", request });
      })
      .catch((err) => {
        if (aborted) return;
        const notFound = err instanceof ApiError && err.status === 404;
        setRequestState({
          kind: "error",
          message:
            err instanceof MissingDevUserError || err instanceof ApiError
              ? err.message
              : "Could not load request.",
          notFound,
        });
      });
    return () => {
      aborted = true;
    };
  }, [id, refreshKey]);

  useEffect(() => {
    if (!id) return;
    let aborted = false;
    setApprovalState({ kind: "loading" });
    getRequestApprovalStatus(id)
      .then((status) => {
        if (!aborted) setApprovalState({ kind: "loaded", status });
      })
      .catch((err) => {
        if (aborted) return;
        setApprovalState({
          kind: "error",
          message:
            err instanceof MissingDevUserError || err instanceof ApiError
              ? err.message
              : "Could not load approval status.",
        });
      });
    return () => {
      aborted = true;
    };
  }, [id, refreshKey]);

  const linkedContractId =
    requestState.kind === "loaded"
      ? requestState.request.linked_contract_id
      : null;

  useEffect(() => {
    if (!linkedContractId) {
      setLinkedState({ kind: "idle" });
      return;
    }
    let aborted = false;
    setLinkedState({ kind: "loading" });
    getContracts()
      .then((records) => {
        if (aborted) return;
        setLinkedState({
          kind: "loaded",
          record: records.find((r) => r.id === linkedContractId) ?? null,
        });
      })
      .catch((err) => {
        if (aborted) return;
        setLinkedState({
          kind: "error",
          message:
            err instanceof MissingDevUserError || err instanceof ApiError
              ? err.message
              : "Could not load linked Repository record.",
        });
      });
    return () => {
      aborted = true;
    };
  }, [linkedContractId, refreshKey]);

  if (requestState.kind === "loading") {
    return (
      <div className="space-y-4" data-testid="request-detail-loading">
        <BackLink />
        <p className="text-sm text-ink-muted">Loading request...</p>
      </div>
    );
  }

  if (requestState.kind === "error") {
    return (
      <div className="space-y-4" data-testid="request-detail-error">
        <BackLink />
        <EmptyState
          title={requestState.notFound ? "Request not found" : "Could not load request"}
          description={requestState.message}
        />
      </div>
    );
  }

  const { request } = requestState;

  function onConverted(response: ConvertRequestToContractResponse) {
    setRequestState({ kind: "loaded", request: response.request });
    setLinkedState({
      kind: "loaded",
      record: {
        ...response.contract,
      },
    });
    setRefreshKey((v) => v + 1);
  }

  function onUploaded(response: ConvertRequestUploadResponse) {
    setRequestState({ kind: "loaded", request: response.request });
    setLinkedState({
      kind: "loaded",
      record: {
        ...response.contract,
      },
    });
    setUploadFeedback(response);
    setRefreshKey((v) => v + 1);
  }

  return (
    <div className="space-y-5" data-testid="request-detail-page">
      <RequestHeader request={request} />
      <StagePanel request={request} approvalState={approvalState} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)]">
        <div className="space-y-4">
          <SummarySection request={request} linkedRecord={linkedState} />
          <LifecycleSection
            request={request}
            approvalState={approvalState}
            linkedRecord={linkedState}
          />
          <ConversionSection
            request={request}
            onConverted={onConverted}
            onUploaded={onUploaded}
          />
          {uploadFeedback && (
            <UploadReviewPanel
              contract={{
                id: uploadFeedback.contract.id,
                title: uploadFeedback.contract.title,
              }}
              extractedMetadata={uploadFeedback.extracted_metadata}
              duplicateCandidates={uploadFeedback.duplicate_candidates}
              context="request_upload"
              dataTestId="request-detail-upload-feedback"
            />
          )}
          <section
            className="rounded border border-rule p-4"
            data-testid="request-detail-approval"
          >
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <div>
                <h2 className="text-sm font-medium text-ink">
                  Approval status
                </h2>
                <p className="text-xs text-ink-subtle">
                  Approval Policies are rules that attach approval workflows to
                  matching requests. Approval Workflows are active approval
                  processes.
                </p>
              </div>
              <Link
                to={mountedPath(
                  `/approvals/workflows?request_id=${encodeURIComponent(request.id)}`,
                  location.pathname,
                )}
                className="text-xs text-ink-muted underline-offset-2 hover:underline"
              >
                View approval workflows
              </Link>
            </div>
            <RequestApprovalStatusSection
              key={`approval-${refreshKey}`}
              requestId={request.id}
            />
          </section>
          <section
            className="rounded border border-rule p-4"
            data-testid="request-detail-activity"
          >
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <div>
                <h2 className="text-sm font-medium text-ink">Activity</h2>
                <p className="text-xs text-ink-subtle">
                  Timeline events and export controls for this Request.
                </p>
              </div>
              <ActivityExport kind="request" requestId={request.id} />
            </div>
            <ActivityTimeline
              key={`activity-${refreshKey}`}
              kind="request"
              requestId={request.id}
            />
          </section>
        </div>

        <LinkedRepositorySection
          request={request}
          linkedRecord={linkedState}
        />
      </div>
    </div>
  );
}

function RequestHeader({ request }: { request: ContractRequest }) {
  return (
    <header className="space-y-3" data-testid="request-detail-header">
      <BackLink />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink">{request.title}</h1>
          <p className="mt-1 text-xs text-ink-subtle">
            Created {formatDateTime(request.created_at)}
            {request.updated_at ? ` · updated ${formatDateTime(request.updated_at)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={request.status} />
          {request.priority && <TagPill label={humanize(request.priority)} />}
          {request.request_type && <TagPill label={humanize(request.request_type)} />}
          {request.contract_type && <TagPill label={request.contract_type} />}
        </div>
      </div>
    </header>
  );
}

function StagePanel({
  request,
  approvalState,
}: {
  request: ContractRequest;
  approvalState: ApprovalState;
}) {
  const location = useLocation();
  const approvalSignal =
    approvalState.kind === "loaded" ? approvalState.status.summary : null;
  const stage = getRequestStage(request, approvalSignal);

  return (
    <div
      className="flex flex-col gap-3 rounded border border-rule bg-canvas-subtle p-4 sm:flex-row sm:items-start sm:justify-between"
      data-testid="request-stage-panel"
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-medium text-ink-subtle">Current stage</p>
          <Pill tone={stage.tone} variant="soft" data-testid="request-stage-pill">
            {stage.label}
          </Pill>
        </div>
        <p className="text-sm text-ink-muted" data-testid="request-stage-explanation">
          {stage.explanation}
        </p>
      </div>
      {stage.nextActionLabel && stage.nextActionSuffix && (
        <Link
          to={mountedPath(stage.nextActionSuffix, location.pathname)}
          className="inline-flex w-fit shrink-0 items-center justify-center rounded border border-ink bg-ink px-3 py-1.5 text-xs text-canvas hover:opacity-90"
          data-testid="request-stage-next-action"
        >
          {stage.nextActionLabel}
        </Link>
      )}
    </div>
  );
}

function SummarySection({
  request,
  linkedRecord,
}: {
  request: ContractRequest;
  linkedRecord: LinkedRepositoryState;
}) {
  const linkedLabel =
    request.linked_contract_id == null
      ? "None"
      : linkedRecord.kind === "loaded" && linkedRecord.record
        ? linkedRecord.record.title
        : request.linked_contract_id;

  return (
    <section
      className="rounded border border-rule p-4"
      data-testid="request-detail-summary"
    >
      <h2 className="text-sm font-medium text-ink">Summary / Intake details</h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Request type" value={humanize(request.request_type)} />
        <Field label="Contract type" value={request.contract_type ?? "Not set"} />
        <Field label="Priority" value={humanize(request.priority)} />
        <Field label="Counterparty" value={request.counterparty_name ?? "Not set"} />
        <Field label="Requester" value={request.requester_name ?? request.requester_email ?? "Not set"} />
        <Field label="Due date" value={request.due_date ?? "Not set"} />
        <Field
          label="Agreement Template"
          value={request.linked_template_id ? "Linked" : "Not linked"}
        />
        <Field label="Repository record" value={linkedLabel} />
      </dl>
      <DescriptionSection description={request.description} />
    </section>
  );
}

function DescriptionSection({
  description,
}: {
  description: string | null | undefined;
}) {
  if (!description) return null;
  const parsed = parseSupportingQuestionsBlock(description);
  if (!parsed) {
    return (
      <p className="mt-4 text-sm text-ink-muted" data-testid="request-description">
        {description}
      </p>
    );
  }
  return (
    <div className="mt-4 space-y-3" data-testid="request-supporting-questions">
      <div>
        <p className="text-xs font-medium text-ink-subtle">Supporting questions</p>
        <p
          className="text-xs text-ink-subtle"
          data-testid="request-supporting-questions-label"
        >
          {parsed.label}
        </p>
        <dl className="mt-2 space-y-2">
          {parsed.rows.map((row, idx) => (
            <div key={idx} data-testid="request-supporting-question-row">
              <dt className="text-xs text-ink-subtle">{row.question || "—"}</dt>
              <dd className="text-sm text-ink">{row.answer || "—"}</dd>
            </div>
          ))}
        </dl>
      </div>
      {parsed.remainingDescription && (
        <div data-testid="request-additional-context">
          <p className="text-xs font-medium text-ink-subtle">Additional context</p>
          <p className="mt-1 text-sm text-ink-muted">
            {parsed.remainingDescription}
          </p>
        </div>
      )}
    </div>
  );
}

function LifecycleSection({
  request,
  approvalState,
  linkedRecord,
}: {
  request: ContractRequest;
  approvalState: ApprovalState;
  linkedRecord: LinkedRepositoryState;
}) {
  const message = lifecycleMessage(request, approvalState);
  return (
    <section
      className="rounded border border-rule bg-canvas-subtle p-4"
      data-testid="request-detail-lifecycle"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-medium text-ink">Lifecycle / next action</h2>
          <p className="mt-1 text-sm text-ink-muted">{message}</p>
          {approvalState.kind === "error" && (
            <p className="mt-2 text-xs text-danger">{approvalState.message}</p>
          )}
        </div>
        {request.linked_contract_id && (
          <RepositoryLink
            contractId={request.linked_contract_id}
            label="Open Repository record"
            testId="request-lifecycle-repository-link"
            pathname={location.pathname}
          />
        )}
      </div>
      {approvalState.kind === "loaded" &&
        approvalState.status.summary.blocking_reason_text && (
          <p
            className="mt-3 rounded border border-warning bg-warning/10 px-3 py-2 text-xs text-ink"
            data-testid="request-lifecycle-blocking"
          >
            {approvalState.status.summary.blocking_reason_text}
          </p>
        )}
      {linkedRecord.kind === "error" && (
        <p className="mt-3 text-xs text-danger">{linkedRecord.message}</p>
      )}
    </section>
  );
}

function ConversionSection({
  request,
  onConverted,
  onUploaded,
}: {
  request: ContractRequest;
  onConverted: (response: ConvertRequestToContractResponse) => void;
  onUploaded: (response: ConvertRequestUploadResponse) => void;
}) {
  const location = useLocation();

  if (request.linked_contract_id) {
    return (
      <section
        className="rounded border border-rule p-4"
        data-testid="request-detail-conversion-disabled"
      >
        <h2 className="text-sm font-medium text-ink">Move to Repository</h2>
        <p className="mt-1 text-sm text-ink-muted">
          This request is linked to a Repository record. Generation and upload
          actions are not available once a Repository record exists.
        </p>
        <div className="mt-3">
          <Link
            to={mountedPath(
              `/repository/${encodeURIComponent(request.linked_contract_id)}`,
              location.pathname,
            )}
            className="inline-flex w-fit items-center justify-center rounded border border-ink bg-ink px-3 py-1.5 text-xs text-canvas hover:opacity-90"
            data-testid="request-conversion-repository-link"
          >
            Open Repository record
          </Link>
        </div>
      </section>
    );
  }

  if (request.status === "cancelled") {
    return (
      <section
        className="rounded border border-rule p-4"
        data-testid="request-detail-conversion-disabled"
      >
        <h2 className="text-sm font-medium text-ink">Move to Repository</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Cancelled requests cannot be converted to a Repository record.
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded border border-rule p-4"
      data-testid="request-detail-conversion"
    >
      <h2 className="text-sm font-medium text-ink">Move to Repository</h2>
      <p className="mt-1 text-xs text-ink-subtle">
        Create a Repository record by generating from an Agreement Template or
        by uploading an existing source document.
      </p>
      {request.linked_template_id ? (
        <RequestConvertSection request={request} onConverted={onConverted} />
      ) : (
        <p
          className="mt-3 text-xs text-ink-subtle"
          data-testid="request-detail-no-template"
        >
          No Agreement Template is linked. Link one to generate a draft, or
          upload an existing source file below to create a Repository record
          directly.
        </p>
      )}
      <RequestUploadConvertSection request={request} onConverted={onUploaded} />
    </section>
  );
}

function LinkedRepositorySection({
  request,
  linkedRecord,
}: {
  request: ContractRequest;
  linkedRecord: LinkedRepositoryState;
}) {
  return (
    <aside
      className="h-fit rounded border border-rule p-4"
      data-testid="request-detail-linked-repository"
    >
      <h2 className="text-sm font-medium text-ink">Linked Repository</h2>
      {!request.linked_contract_id ? (
        <p className="mt-2 text-sm text-ink-muted">
          No Repository record has been created from this Request yet.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {linkedRecord.kind === "loading" && (
            <p className="text-sm text-ink-muted">Loading Repository metadata...</p>
          )}
          {linkedRecord.kind === "loaded" && linkedRecord.record && (
            <div>
              <p className="font-medium text-ink" data-testid="linked-repository-title">
                {linkedRecord.record.title}
              </p>
              <p className="mt-1 text-xs text-ink-subtle">
                Status: {linkedRecord.record.status}
              </p>
            </div>
          )}
          {linkedRecord.kind === "loaded" && !linkedRecord.record && (
            <p className="text-sm text-ink-muted">
              Repository metadata was not available in the current list view.
            </p>
          )}
          {linkedRecord.kind === "error" && (
            <p className="text-sm text-danger">{linkedRecord.message}</p>
          )}
          <RepositoryLink
            contractId={request.linked_contract_id}
            label="Open Repository record"
            testId="request-detail-repository-link"
            pathname={location.pathname}
          />
        </div>
      )}
    </aside>
  );
}

function lifecycleMessage(
  request: ContractRequest,
  approvalState: ApprovalState,
): string {
  if (request.status === "cancelled") {
    return "This Request is cancelled.";
  }
  if (approvalState.kind === "loaded") {
    const summary = approvalState.status.summary;
    if (summary.has_active_workflows) {
      return "Approval is pending. Review the current Approval Workflow step before signature.";
    }
    if (summary.has_rejected_workflows || summary.blocking_reason) {
      return "Approval is blocked. Use the approval links below to resolve the workflow or policy issue.";
    }
    if (summary.ready_for_signature === true) {
      return "Ready for signature. Sending to DocuSeal remains a separate Repository action.";
    }
  }
  if (request.linked_contract_id) {
    return "This Request is linked to a Repository record.";
  }
  if (request.status === "open") {
    return "Ready to generate or upload an agreement.";
  }
  return "Continue intake from the available conversion and approval sections.";
}

function RepositoryLink({
  contractId,
  label,
  testId,
  pathname,
}: {
  contractId: string;
  label: string;
  testId: string;
  pathname: string;
}) {
  return (
    <Link
      to={mountedPath(`/repository/${encodeURIComponent(contractId)}`, pathname)}
      className="inline-flex w-fit items-center justify-center rounded border border-ink bg-ink px-3 py-1.5 text-xs text-canvas hover:opacity-90"
      data-testid={testId}
    >
      {label}
    </Link>
  );
}

function BackLink() {
  const location = useLocation();
  return (
    <Link
      to={mountedPath("/requests", location.pathname)}
      className="text-xs text-ink-muted underline-offset-2 hover:underline"
    >
      Back to Requests
    </Link>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value || "Not set"}</dd>
    </div>
  );
}

function TagPill({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-rule px-2 py-0.5 text-xs text-ink-muted">
      {label}
    </span>
  );
}

function humanize(value: string | null): string {
  return value ? humanizeFieldName(value) : "Not set";
}
