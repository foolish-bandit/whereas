import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import ActivityExport from "../components/ActivityExport";
import ActivityTimeline from "../components/ActivityTimeline";
import ApprovalGateRemediation from "../components/ApprovalGateRemediation";
import ClausesPanel from "../components/ClausesPanel";
import DocumentViewer from "../components/DocumentViewer";
import DuplicateMergePanel from "../components/DuplicateMergePanel";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import MarkdownPreview from "../components/MarkdownPreview";
import MetadataPanel from "../components/MetadataPanel";
import ReviewPanel from "../components/ReviewPanel";
import RightPanelTabs from "../components/RightPanelTabs";
import StatusBadge from "../components/StatusBadge";
import UploadReviewPanel from "../components/UploadReviewPanel";
import {
  ApiError,
  MissingDevUserError,
  compareContractArtifacts,
  downloadContract,
  downloadContractArtifact,
  previewContractArtifact,
  getContract,
  getContractArtifacts,
  getContractApprovalGate,
  getContractMetadata,
  sendContractToDocuseal,
} from "../lib/api";
import {
  artifactDisplayLabel,
  formatFileSize,
  getArtifactHistoryItems,
  pickCurrentDocumentLabel,
  pickPrimaryOriginCopy,
  type ArtifactHistoryItem,
  type LifecycleSlot,
} from "../lib/artifacts";
import { clauseHasValidSpan } from "../lib/clauses";
import { fieldKey } from "../lib/fields";
import {
  formatDate,
  formatDateTime,
  mimeExtension,
  mimeLabel,
  sanitizeFilename,
} from "../lib/format";
import type {
  Clause,
  ContractArtifact,
  ContractDetail,
  ExtractedField,
} from "../types/contracts";
import type { ContractMetadataView } from "../types/contractIntake";
import type { ReviewRunDetail } from "../types/findings";
import type { ArtifactCompareResponse } from "../types/compare";
import type {
  DocuSealSigner,
  ContractApprovalGate,
  SendContractToDocuSealResponse,
} from "../types/docuseal";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; contract: ContractDetail }
  | { kind: "error"; title: string; description: string };

type DownloadState =
  | { kind: "idle" }
  | { kind: "downloading" }
  | { kind: "error"; message: string };

/**
 * PR #70 — per-artifact download state keyed by artifact id. The
 * Document History row can render an inline "Download version" button
 * that maintains its own busy/error state independent of the header's
 * "Download current document" action.
 */
type ArtifactDownloadStateMap = Record<
  string,
  { kind: "downloading" } | { kind: "error"; message: string } | undefined
>;

/**
 * PR #71 — text-based version compare state for the Document History
 * panel. Lives next to the artifacts list because the comparison only
 * makes sense in the context of two artifacts on the same Repository
 * record. The base/compare selections are stored as artifact ids
 * (not the artifact objects themselves) so they survive a refresh of
 * the underlying artifacts list.
 */
type CompareSelection = {
  baseId: string | null;
  compareId: string | null;
};

type CompareState =
  | { kind: "idle" }
  | { kind: "comparing" }
  | { kind: "loaded"; result: ArtifactCompareResponse }
  | { kind: "error"; message: string };

type SidebarTab = "metadata" | "clauses" | "review";

type ArtifactsState =
  | { kind: "loading" }
  | { kind: "loaded"; artifacts: ContractArtifact[] }
  | { kind: "error" };

/**
 * The contract workspace defaults to the lightweight Markdown
 * preview because that's what users want for skimming. The
 * "original" view is the existing plain-text DocumentViewer, which
 * supports clause/field/finding span highlighting. Selecting
 * anything from the sidebar that has a span auto-switches to the
 * original view so the highlight is visible.
 */
type ViewerMode = "markdown" | "original";

export default function ContractWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SidebarTab>("metadata");
  const [viewerMode, setViewerMode] = useState<ViewerMode>("markdown");
  const [downloadState, setDownloadState] = useState<DownloadState>({
    kind: "idle",
  });
  const [artifactDownloads, setArtifactDownloads] =
    useState<ArtifactDownloadStateMap>({});
  const [compareSelection, setCompareSelection] = useState<CompareSelection>({
    baseId: null,
    compareId: null,
  });
  const [compareState, setCompareState] = useState<CompareState>({ kind: "idle" });
  const [activeRun, setActiveRun] = useState<ReviewRunDetail | null>(null);
  // Full artifact list drives the lifecycle strip, the Files section,
  // the Current-document label, and the Details origin copy. Mirrors
  // the priority used by the backend's download endpoint.
  const [artifactsState, setArtifactsState] = useState<ArtifactsState>({
    kind: "loading",
  });
  const [metadataView, setMetadataView] = useState<ContractMetadataView | null>(
    null,
  );

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    setSelectedKey(null);
    setActiveTab("metadata");
    setViewerMode("markdown");
    getContract(id, { signal: controller.signal })
      .then((contract) => setState({ kind: "loaded", contract }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof MissingDevUserError) {
          setState({
            kind: "error",
            title: "No development user ID configured",
            description:
              "Set a development user ID in Settings before opening a contract.",
          });
          return;
        }
        if (err instanceof ApiError) {
          setState({
            kind: "error",
            title:
              err.status === 404
                ? "Contract not found"
                : "Could not load contract",
            description: err.message,
          });
          return;
        }
        setState({
          kind: "error",
          title: "Could not load contract",
          description: "An unexpected error occurred.",
        });
      });
    return () => controller.abort();
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setArtifactsState({ kind: "loading" });
    getContractArtifacts(id, { signal: controller.signal })
      .then((rows) => {
        if (controller.signal.aborted) return;
        setArtifactsState({ kind: "loaded", artifacts: rows });
      })
      .catch(() => {
        // Artifact metadata is a hint, not load-bearing — the contract
        // workspace must remain usable even if the listing endpoint
        // fails or the user lacks access. Swallow here; primary errors
        // are surfaced via the contract load above.
        if (controller.signal.aborted) return;
        setArtifactsState({ kind: "error" });
      });
    return () => controller.abort();
  }, [id]);

  // PR #76 — re-fetch artifacts on demand. Used after a successful
  // duplicate merge so the moved artifacts appear in Document History
  // without forcing a full page reload.
  const reloadArtifacts = useCallback(async () => {
    if (!id) return;
    setArtifactsState({ kind: "loading" });
    try {
      const rows = await getContractArtifacts(id);
      setArtifactsState({ kind: "loaded", artifacts: rows });
    } catch {
      setArtifactsState({ kind: "error" });
    }
  }, [id]);

  // The metadata view is the merged "Repository details" projection
  // PR #67 added: title from the Contract row, counterparty / contract
  // type / effective date from the latest original_upload artifact's
  // metadata_json. Failure is silent — Details just falls back to the
  // raw Contract row's title and skips the optional fields.
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setMetadataView(null);
    getContractMetadata(id, { signal: controller.signal })
      .then((view) => {
        if (controller.signal.aborted) return;
        setMetadataView(view);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setMetadataView(null);
      });
    return () => controller.abort();
  }, [id]);

  const contract = state.kind === "loaded" ? state.contract : null;

  const selectedSpan = useMemo(() => {
    if (!contract || !selectedKey) return null;
    if (selectedKey.startsWith("clause:")) {
      const clauseId = selectedKey.slice("clause:".length);
      const clause = contract.clauses.find((c) => c.id === clauseId);
      if (!clause) return null;
      if (!clauseHasValidSpan(clause, contract.full_text)) return null;
      return { start: clause.span_start, end: clause.span_end };
    }
    if (selectedKey.startsWith("review:")) {
      // Review evidence keys resolve through the active review run.
      // Both the matcher's per-rule results and the persisted findings
      // copy span_start/span_end straight off the Clause row, which is
      // exact-span-grounded by construction.
      if (!activeRun) return null;
      const ruleId = selectedKey.slice("review:".length);
      const rule = activeRun.results.find((r) => r.rule_id === ruleId);
      if (rule && typeof rule.span_start === "number" && typeof rule.span_end === "number") {
        return { start: rule.span_start, end: rule.span_end };
      }
      const finding = activeRun.findings.find((f) => f.rule_id === ruleId);
      if (
        finding &&
        typeof finding.span_start === "number" &&
        typeof finding.span_end === "number"
      ) {
        return { start: finding.span_start, end: finding.span_end };
      }
      return null;
    }
    const field = contract.extracted_fields.find(
      (f) => fieldKey(f) === selectedKey,
    );
    if (!field) return null;
    if (
      typeof field.span_start !== "number" ||
      typeof field.span_end !== "number"
    ) {
      return null;
    }
    return { start: field.span_start, end: field.span_end };
  }, [contract, selectedKey, activeRun]);

  async function onDownload() {
    if (!contract) return;
    setDownloadState({ kind: "downloading" });
    try {
      const result = await downloadContract(contract.id);
      const ext = mimeExtension(contract.mime_type);
      const filename =
        result.filename ?? sanitizeFilename(contract.title, ext);
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadState({ kind: "idle" });
    } catch (err) {
      if (err instanceof MissingDevUserError) {
        setDownloadState({ kind: "error", message: err.message });
        return;
      }
      if (err instanceof ApiError) {
        setDownloadState({ kind: "error", message: err.message });
        return;
      }
      setDownloadState({
        kind: "error",
        message: "Download failed unexpectedly.",
      });
    }
  }

  async function onDownloadArtifact(artifact: ContractArtifact) {
    if (!contract) return;
    setArtifactDownloads((prev) => ({
      ...prev,
      [artifact.id]: { kind: "downloading" },
    }));
    try {
      const result = await downloadContractArtifact(contract.id, artifact.id);
      const ext = mimeExtension(artifact.mime_type ?? contract.mime_type);
      const filename =
        result.filename ??
        sanitizeFilename(artifact.filename ?? contract.title, ext);
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setArtifactDownloads((prev) => {
        const next = { ...prev };
        delete next[artifact.id];
        return next;
      });
    } catch (err) {
      const message =
        err instanceof MissingDevUserError
          ? err.message
          : err instanceof ApiError
            ? err.message
            : "Download failed unexpectedly.";
      setArtifactDownloads((prev) => ({
        ...prev,
        [artifact.id]: { kind: "error", message },
      }));
    }
  }

  async function onCompareArtifacts() {
    if (!contract) return;
    const { baseId, compareId } = compareSelection;
    if (!baseId || !compareId || baseId === compareId) return;
    setCompareState({ kind: "comparing" });
    try {
      const result = await compareContractArtifacts(
        contract.id,
        baseId,
        compareId,
      );
      setCompareState({ kind: "loaded", result });
    } catch (err) {
      const message =
        err instanceof MissingDevUserError
          ? err.message
          : err instanceof ApiError
            ? err.message
            : "Comparison failed unexpectedly.";
      setCompareState({ kind: "error", message });
    }
  }

  function onCompareSelectionChange(next: CompareSelection) {
    setCompareSelection(next);
    // Drop the previous compare result the moment the user changes a
    // side — keeping it around would show a stale diff against the
    // currently-selected artifacts.
    if (compareState.kind !== "idle") {
      setCompareState({ kind: "idle" });
    }
  }

  if (state.kind === "loading") {
    return (
      <div>
        <Link
          to="/demo/repository"
          className="text-sm text-ink-muted hover:text-ink"
        >
          ← Back to Repository
        </Link>
        <div className="mt-4">
          <LoadingSkeleton rows={4} />
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div>
        <Link
          to="/demo/repository"
          className="text-sm text-ink-muted hover:text-ink"
        >
          ← Back to Repository
        </Link>
        <div className="mt-4">
          <ErrorState
            title={state.title}
            description={state.description}
          />
        </div>
      </div>
    );
  }

  const artifacts =
    artifactsState.kind === "loaded" ? artifactsState.artifacts : [];

  return (
    <div>
      <Link
        to="/demo/repository"
        className="text-sm text-ink-muted hover:text-ink"
      >
        ← Back to Repository
      </Link>

      {state.contract.merged_into_contract_id ? (
        <div
          className="mt-3 rounded border border-warning-ring bg-warning-soft p-3 text-xs text-ink"
          role="status"
          data-testid="contract-merged-notice"
        >
          <p className="font-medium">
            This Repository record was merged into another Repository
            record.
          </p>
          <p className="mt-1 text-ink-muted">
            Its files were moved into the canonical record&apos;s Document
            History. No files were deleted.{" "}
            <Link
              to={`/demo/contracts/${encodeURIComponent(
                state.contract.merged_into_contract_id,
              )}`}
              className="font-medium text-ink underline hover:text-accent-ring"
              data-testid="contract-merged-notice-link"
            >
              Open the canonical Repository record.
            </Link>
          </p>
        </div>
      ) : null}

      <RepositoryHeader
        contract={state.contract}
        metadata={metadataView}
        artifactsState={artifactsState}
        downloadState={downloadState}
        onDownload={onDownload}
      />

      <DocumentLifecycleStrip
        contract={state.contract}
        state={artifactsState}
      />

      <SendToDocusealPanel contractId={state.contract.id} />

      <section
        className="mt-6 rounded border border-rule p-4"
        data-testid="contract-preview-section"
      >
        <h2 className="text-sm font-medium text-ink">Preview</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Text preview is a fast working representation. The current
          official document is what the Download action returns.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div>
            {viewerMode === "markdown" ? (
              <MarkdownPreview
                contractId={state.contract.id}
                rightSlot={
                  <ViewerModeToggle
                    mode={viewerMode}
                    onChange={setViewerMode}
                  />
                }
              />
            ) : (
              <DocumentViewer
                fullText={state.contract.full_text}
                selectedSpan={selectedSpan}
                selectionToken={selectedKey}
                rightSlot={
                  <ViewerModeToggle
                    mode={viewerMode}
                    onChange={setViewerMode}
                  />
                }
              />
            )}
          </div>
          <Sidebar
            contract={state.contract}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
              setSelectedKey(null);
            }}
            selectedKey={selectedKey}
            onSelect={(key) => {
              setSelectedKey(key);
              // The Markdown preview doesn't render span highlights;
              // auto-switch to the original text viewer when the user
              // picks a clause/field/finding so the citation is visible.
              if (key !== null) setViewerMode("original");
            }}
            onReviewRunChange={setActiveRun}
          />
        </div>
      </section>

      <DetailsSection
        contract={state.contract}
        metadata={metadataView}
        onMetadataSaved={setMetadataView}
        artifacts={artifacts}
      />

      {state.contract.merged_into_contract_id ? null : (
        <section
          className="mt-6 rounded border border-rule p-4"
          data-testid="contract-duplicate-merge-section"
        >
          <h2 className="text-sm font-medium text-ink">
            Possible duplicates
          </h2>
          <p className="mt-1 text-xs text-ink-subtle">
            Resolve a duplicate Repository record by merging it into
            this one. Files move into Document History; nothing is
            deleted.
          </p>
          <DuplicateMergePanel
            targetContractId={state.contract.id}
            onMerged={() => {
              // Refresh artifacts so the moved files show up in Document
              // History. The activity timeline lazily reloads on next
              // mount; for now keeping the rest of the page stable is
              // less surprising than a full detail refetch.
              void reloadArtifacts();
            }}
          />
        </section>
      )}

      <section
        className="mt-6 rounded border border-rule p-4"
        data-testid="contract-activity-section"
      >
        <h2 className="text-sm font-medium text-ink">Activity</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Approval and signature events recorded against this contract.
          Visibility only — the timeline does not change workflow or
          signature state.
        </p>
        <ActivityTimeline kind="contract" contractId={state.contract.id} />
        <ActivityExport kind="contract" contractId={state.contract.id} />
      </section>

      <DocumentHistorySection
        state={artifactsState}
        artifactDownloads={artifactDownloads}
        onDownloadArtifact={onDownloadArtifact}
        compareSelection={compareSelection}
        compareState={compareState}
        onCompareSelectionChange={onCompareSelectionChange}
        onCompare={onCompareArtifacts}
      />
    </div>
  );
}

interface SidebarProps {
  contract: ContractDetail;
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onReviewRunChange: (run: ReviewRunDetail | null) => void;
}

function Sidebar({
  contract,
  activeTab,
  onTabChange,
  selectedKey,
  onSelect,
  onReviewRunChange,
}: SidebarProps) {
  const tabs = [
    {
      id: "metadata" as const,
      label: "Metadata",
      count: contract.extracted_fields.length,
    },
    {
      id: "clauses" as const,
      label: "Clauses",
      count: contract.clauses.length,
    },
    {
      id: "review" as const,
      label: "Review",
    },
  ];
  return (
    <aside>
      <RightPanelTabs tabs={tabs} active={activeTab} onChange={onTabChange} />
      {activeTab === "metadata" && (
        <MetadataPanel
          fields={contract.extracted_fields}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      )}
      {activeTab === "clauses" && (
        <ClausesPanel
          clauses={contract.clauses}
          fullText={contract.full_text}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      )}
      {activeTab === "review" && (
        <ReviewPanel
          contractId={contract.id}
          selectedKey={selectedKey}
          onSelect={onSelect}
          onRunChange={onReviewRunChange}
        />
      )}
      <ReviewReminder
        fields={contract.extracted_fields}
        clauses={contract.clauses}
      />
    </aside>
  );
}

interface RepositoryHeaderProps {
  contract: ContractDetail;
  metadata: ContractMetadataView | null;
  artifactsState: ArtifactsState;
  downloadState: DownloadState;
  onDownload: () => void;
}

function RepositoryHeader({
  contract,
  metadata,
  artifactsState,
  downloadState,
  onDownload,
}: RepositoryHeaderProps) {
  const artifacts =
    artifactsState.kind === "loaded" ? artifactsState.artifacts : [];
  const currentDocument = pickCurrentDocumentLabel(artifacts);
  return (
    <div
      className="mt-2 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between"
      data-testid="repository-detail-header"
    >
      <div className="min-w-0 flex-1">
        <h1 className="break-words font-serif text-xl text-ink sm:text-2xl">
          {metadata?.title ?? contract.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          <StatusBadge status={contract.status} />
          {metadata?.contract_type && (
            <span data-testid="repository-detail-contract-type">
              {metadata.contract_type}
            </span>
          )}
          {metadata?.counterparty_name && (
            <span data-testid="repository-detail-counterparty">
              {metadata.counterparty_name}
            </span>
          )}
          <span>{mimeLabel(contract.mime_type)}</span>
          {contract.page_count != null && (
            <span>{contract.page_count} pages</span>
          )}
          <span>Added {formatDate(contract.created_at)}</span>
        </div>
        {currentDocument && (
          <p
            className="mt-2 text-xs text-ink-muted"
            data-testid="repository-current-document"
          >
            <span className="font-medium text-ink">Current document:</span>{" "}
            {currentDocument.label}
          </p>
        )}
        {artifactsState.kind === "loaded" && !currentDocument && (
          <p
            className="mt-2 text-xs text-ink-subtle"
            data-testid="repository-current-document-legacy"
          >
            Legacy original — uploaded before artifact tracking. The
            Download current document action still resolves from the
            contract record.
          </p>
        )}
      </div>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
        <button
          type="button"
          onClick={onDownload}
          disabled={downloadState.kind === "downloading"}
          className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:py-1.5"
        >
          {downloadState.kind === "downloading"
            ? "Preparing…"
            : "Download current document"}
        </button>
        {downloadState.kind === "error" && (
          <p className="max-w-xs text-xs text-danger sm:text-right">
            {downloadState.message}
          </p>
        )}
      </div>
    </div>
  );
}

interface LifecycleStripProps {
  contract: ContractDetail;
  state: ArtifactsState;
}

interface LifecycleSlotDescriptor {
  slot: LifecycleSlot;
  label: string;
  // Either the artifact backing this slot (if any) or a synthetic
  // descriptor for the Text preview slot (which is not a stored
  // artifact row).
  artifact: ContractArtifact | null;
  hasContent: boolean;
  createdAt: string | null;
  mimeHint: string | null;
}

function DocumentLifecycleStrip({ contract, state }: LifecycleStripProps) {
  // While loading or on a hard error we just hide the strip. The
  // header's Download current document button is the load-bearing affordance.
  if (state.kind !== "loaded") return null;
  const { artifacts } = state;

  const signed =
    artifacts.find((a) => a.artifact_type === "signed_pdf") ?? null;
  const generated =
    artifacts.find((a) => a.artifact_type === "generated_docx") ?? null;
  const original =
    artifacts.find((a) => a.artifact_type === "original_upload") ?? null;

  const slots: LifecycleSlotDescriptor[] = [
    {
      slot: "original_upload",
      label: original
        ? artifactDisplayLabel("original_upload", original.source)
        : "Source file",
      artifact: original,
      hasContent: original !== null,
      createdAt: original?.created_at ?? null,
      mimeHint: original?.mime_type ?? null,
    },
    {
      slot: "generated_docx",
      label: artifactDisplayLabel("generated_docx"),
      artifact: generated,
      hasContent: generated !== null,
      createdAt: generated?.created_at ?? null,
      mimeHint: generated?.mime_type ?? null,
    },
    {
      slot: "signed_pdf",
      label: artifactDisplayLabel("signed_pdf"),
      artifact: signed,
      hasContent: signed !== null,
      createdAt: signed?.created_at ?? null,
      mimeHint: signed?.mime_type ?? null,
    },
    {
      slot: "text_preview",
      label: "Text preview",
      artifact: null,
      // The contract has full_text iff parsing succeeded, which is the
      // same precondition the workspace uses to flip the Text preview
      // toggle to "ready". Markdown snapshot existence is loaded
      // lazily inside MarkdownPreview itself; here we just show that
      // a working preview is available at the page level.
      hasContent:
        typeof contract.full_text === "string" &&
        contract.full_text.length > 0,
      createdAt: null,
      mimeHint: null,
    },
  ];

  return (
    <section
      className="mt-4 rounded border border-rule p-3"
      data-testid="document-lifecycle-strip"
      aria-label="Document lifecycle"
    >
      <p className="text-xs font-medium text-ink">Document lifecycle</p>
      <p className="mt-0.5 text-[11px] text-ink-subtle">
        Files associated with this Repository record. The current
        official document is highlighted in the header.
      </p>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {slots.map((s) => (
          <LifecycleSlotCard key={s.slot} slot={s} />
        ))}
      </ul>
    </section>
  );
}

function LifecycleSlotCard({ slot }: { slot: LifecycleSlotDescriptor }) {
  const stateClass = slot.hasContent
    ? "border-rule bg-canvas-subtle"
    : "border-dashed border-rule bg-canvas";
  return (
    <li
      className={`rounded border ${stateClass} p-2 text-xs`}
      data-testid={`lifecycle-slot-${slot.slot}`}
      data-state={slot.hasContent ? "present" : "missing"}
    >
      <p className="font-medium text-ink">{slot.label}</p>
      {slot.hasContent ? (
        <>
          <p className="mt-1 text-[11px] text-ink-subtle">
            {slot.slot === "text_preview"
              ? "Available"
              : slot.createdAt
                ? `Added ${formatDate(slot.createdAt)}`
                : "Available"}
          </p>
          {slot.mimeHint && (
            <p className="mt-0.5 text-[11px] text-ink-subtle">
              {mimeLabel(slot.mimeHint)}
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 text-[11px] text-ink-subtle">Not yet available</p>
      )}
    </li>
  );
}

interface DetailsSectionProps {
  contract: ContractDetail;
  metadata: ContractMetadataView | null;
  onMetadataSaved: (view: ContractMetadataView) => void;
  artifacts: ContractArtifact[];
}

function DetailsSection({
  contract,
  metadata,
  onMetadataSaved,
  artifacts,
}: DetailsSectionProps) {
  const [editing, setEditing] = useState(false);
  const primaryOrigin = pickPrimaryOriginCopy(artifacts);
  return (
    <section
      className="mt-6 rounded border border-rule p-4"
      data-testid="contract-details-section"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-ink">Details</h2>
          <p className="mt-1 text-xs text-ink-subtle">
            Repository record metadata. Editing updates the saved
            details — the contract itself is not re-parsed.
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            className="text-xs underline text-ink-muted hover:text-ink"
            onClick={() => setEditing(true)}
            data-testid="contract-details-edit"
          >
            Edit details
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-3">
          <UploadReviewPanel
            contract={{ id: contract.id, title: metadata?.title ?? contract.title }}
            initialSavedMetadata={metadata}
            context="repository_upload"
            duplicateCandidates={[]}
            extractedMetadata={null}
            dataTestId="contract-details-edit-panel"
            onSaved={(next) => {
              onMetadataSaved(next);
              setEditing(false);
            }}
          />
          <div className="mt-2">
            <button
              type="button"
              className="text-xs underline text-ink-muted hover:text-ink"
              onClick={() => setEditing(false)}
              data-testid="contract-details-edit-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <dl
          className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2"
          data-testid="contract-details-list"
        >
          <DetailRow label="Title" value={metadata?.title ?? contract.title} />
          <DetailRow label="Status" value={<StatusBadge status={contract.status} />} />
          <DetailRow label="Contract type" value={metadata?.contract_type ?? "—"} />
          <DetailRow
            label="Counterparty"
            value={metadata?.counterparty_name ?? "—"}
          />
          <DetailRow
            label="Effective date"
            value={metadata?.effective_date ?? "—"}
          />
          <DetailRow label="Added" value={formatDate(contract.created_at)} />
          <DetailRow
            label="Last updated"
            value={formatDateTime(contract.updated_at)}
          />
          <DetailRow label="Source" value={primaryOrigin ?? "—"} />
        </dl>
      )}
    </section>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] uppercase tracking-wide text-ink-subtle">
        {label}
      </dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

/**
 * Document history (PR #69, extended in PR #70 / #71) — replaces the
 * older flat "Files" listing. Renders every safe ContractArtifact in
 * chronological order, marks the priority-winning artifact as the
 * current document to mirror the backend's download priority, and
 * exposes per-version download (PR #70) plus text-based version
 * compare (PR #71).
 *
 * The compare panel is intentionally narrow: it shows added/removed
 * line counts and a structured diff over extracted text. It is not
 * an official Word redline — downloading both versions is still the
 * authoritative path for legal review. The user-facing copy spells
 * that out so the panel cannot be mistaken for a real redline.
 */
function DocumentHistorySection({
  state,
  artifactDownloads,
  onDownloadArtifact,
  compareSelection,
  compareState,
  onCompareSelectionChange,
  onCompare,
}: {
  state: ArtifactsState;
  artifactDownloads: ArtifactDownloadStateMap;
  onDownloadArtifact: (artifact: ContractArtifact) => void;
  compareSelection: CompareSelection;
  compareState: CompareState;
  onCompareSelectionChange: (next: CompareSelection) => void;
  onCompare: () => void;
}) {
  const artifacts = state.kind === "loaded" ? state.artifacts : [];
  return (
    <section
      className="mt-6 rounded border border-rule p-4"
      data-testid="contract-files-section"
    >
      <h2 className="text-sm font-medium text-ink">Document history</h2>
      <p className="mt-1 text-xs text-ink-subtle">
        Every file recorded against this Repository record, newest first.
        Use Download version to retrieve a specific version; the header
        action always returns the current document.
      </p>
      {state.kind === "loading" && (
        <p
          className="mt-3 text-xs text-ink-subtle"
          data-testid="contract-files-loading"
        >
          Loading file history…
        </p>
      )}
      {state.kind === "error" && (
        <p
          className="mt-3 text-xs text-ink-subtle"
          data-testid="contract-files-error"
        >
          File history is temporarily unavailable.
        </p>
      )}
      {state.kind === "loaded" &&
        (artifacts.length === 0 ? (
          <LegacyFallbackRow />
        ) : (
          <>
            <ol
              className="mt-3 divide-y divide-rule text-xs"
              data-testid="document-history-list"
            >
              {getArtifactHistoryItems(artifacts).map((item) => (
                <DocumentHistoryRow
                  key={item.artifact.id}
                  item={item}
                  downloadState={artifactDownloads[item.artifact.id]}
                  onDownload={onDownloadArtifact}
                />
              ))}
            </ol>
            {artifacts.length >= 2 && (
              <CompareVersionsPanel
                artifacts={artifacts}
                selection={compareSelection}
                state={compareState}
                onSelectionChange={onCompareSelectionChange}
                onCompare={onCompare}
              />
            )}
          </>
        ))}
    </section>
  );
}

function DocumentHistoryRow({
  item,
  downloadState,
  onDownload,
}: {
  item: ArtifactHistoryItem;
  downloadState: ArtifactDownloadStateMap[string];
  onDownload: (artifact: ContractArtifact) => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const canPreview = canPreviewArtifact(item.artifact);
  const { artifact } = item;
  const isDownloading = downloadState?.kind === "downloading";
  const errorMessage =
    downloadState?.kind === "error" ? downloadState.message : null;
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function clearPreview(): void {
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  async function handlePreview(): Promise<void> {
    setPreviewError(null);
    setIsPreviewLoading(true);
    try {
      const result = await previewContractArtifact(artifact.contract_id, artifact.id);
      const nextUrl = URL.createObjectURL(result.blob);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return nextUrl;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Preview unavailable for this file type";
      setPreviewError(msg);
    } finally {
      setIsPreviewLoading(false);
    }
  }

  return (
    <li
      className="grid gap-1 py-2.5 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1.5fr)_auto] sm:items-baseline"
      data-testid="contract-files-row"
      data-artifact-id={artifact.id}
      data-current={item.isCurrent ? "true" : "false"}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="font-medium text-ink">{item.displayLabel}</p>
          {item.isCurrent && (
            <span
              className="inline-block rounded bg-ink px-1.5 py-0.5 text-[10px] font-medium text-canvas"
              data-testid="document-history-current-badge"
            >
              Current document
            </span>
          )}
          {artifact.is_official && (
            <span
              className="inline-block rounded border border-rule px-1.5 py-0.5 text-[10px] text-ink-muted"
              data-testid="document-history-official-badge"
            >
              Official
            </span>
          )}
        </div>
        {artifact.filename && (
          <p className="truncate text-ink-subtle" title={artifact.filename}>
            {artifact.filename}
          </p>
        )}
      </div>
      <div className="min-w-0 text-ink-muted">
        {artifact.mime_type && <span>{mimeLabel(artifact.mime_type)}</span>}
        {artifact.mime_type && artifact.size_bytes != null && (
          <span className="mx-1">·</span>
        )}
        {artifact.size_bytes != null && (
          <span>{formatFileSize(artifact.size_bytes)}</span>
        )}
        <span className="ml-1 block text-ink-subtle sm:inline">
          {artifact.created_at && <>Added {formatDate(artifact.created_at)}</>}
        </span>
        <div className="mt-1 flex flex-wrap gap-1">
          {item.sourceChip && (
            <span className="inline-block rounded bg-canvas-subtle px-1.5 py-0.5 text-[10px] text-ink-subtle">
              {item.sourceChip}
            </span>
          )}
          {item.metadataChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-block rounded bg-canvas-subtle px-1.5 py-0.5 text-[10px] text-ink-subtle"
              data-testid={`document-history-meta-${chip.key}`}
            >
              {chip.label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-col items-start gap-1 text-ink-subtle sm:items-end sm:text-right">
        {item.originCopy && <span>{item.originCopy}</span>}

        {canPreview ? (
          <button
            type="button"
            onClick={handlePreview}
            disabled={isPreviewLoading}
            className="inline-flex items-center justify-center rounded border border-rule px-2 py-1 text-[11px] font-medium text-ink hover:bg-canvas-subtle disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="document-history-row-preview"
          >
            {isPreviewLoading ? "Loading…" : "Preview"}
          </button>
        ) : (
          <span className="text-[11px] text-ink-subtle">Preview unavailable for this file type</span>
        )}

        <button
          type="button"
          onClick={() => onDownload(artifact)}
          disabled={isDownloading}
          className="inline-flex items-center justify-center rounded border border-rule px-2 py-1 text-[11px] font-medium text-ink hover:bg-canvas-subtle disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="document-history-row-download"
          data-artifact-id={artifact.id}
        >
          {isDownloading ? "Preparing…" : "Download version"}
        </button>
        {errorMessage && (
          <p
            className="max-w-xs text-[11px] text-danger sm:text-right"
            data-testid="document-history-row-download-error"
          >
            {errorMessage}
          </p>
        )}
      </div>
      {previewUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="pdf-preview-modal">
          <div className="h-[85vh] w-[90vw] rounded bg-canvas p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink">PDF preview</h3>
              <button type="button" onClick={clearPreview}>Close</button>
            </div>
            <iframe title="PDF preview" src={previewUrl} className="h-[calc(85vh-3rem)] w-full" />
            <p className="mt-1 text-xs text-ink-subtle">Download the file to view it locally</p>
          </div>
        </div>
      )}
      {previewError && <p className="max-w-xs text-[11px] text-danger">{previewError}</p>}

    </li>
  );
}

/**
 * PR #71 — text-based version compare. Renders two dropdowns plus a
 * Compare button; when a compare succeeds, the structured diff
 * returned by ``compareContractArtifacts`` drops in below the
 * dropdowns. Explicitly labeled "Text comparison" — not an official
 * redline — because text extraction is best-effort and we don't
 * generate a tracked-changes DOCX yet.
 */
function canPreviewArtifact(artifact: ContractArtifact): boolean {
  const mime = artifact.mime_type ?? "";
  return mime === "application/pdf" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function CompareVersionsPanel({
  artifacts,
  selection,
  state,
  onSelectionChange,
  onCompare,
}: {
  artifacts: readonly ContractArtifact[];
  selection: CompareSelection;
  state: CompareState;
  onSelectionChange: (next: CompareSelection) => void;
  onCompare: () => void;
}) {
  const canCompare =
    selection.baseId !== null &&
    selection.compareId !== null &&
    selection.baseId !== selection.compareId &&
    state.kind !== "comparing";
  return (
    <div
      className="mt-5 rounded border border-rule bg-canvas-subtle p-3"
      data-testid="document-history-compare-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-ink">Text comparison</h3>
        <p className="text-[11px] text-ink-subtle">
          This is a text comparison preview, not an official Word redline.
        </p>
      </div>
      <p className="mt-1 text-[11px] text-ink-subtle">
        Select exactly two versions to compare their extracted text side by side.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-[11px] text-ink-muted">
          Base version
          <select
            className="mt-0.5 rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink"
            data-testid="compare-base-select"
            value={selection.baseId ?? ""}
            onChange={(e) =>
              onSelectionChange({
                ...selection,
                baseId: e.target.value || null,
              })
            }
          >
            <option value="">Select a version…</option>
            {artifacts.map((a) => (
              <option key={a.id} value={a.id}>
                {compareOptionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-[11px] text-ink-muted">
          Compare version
          <select
            className="mt-0.5 rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink"
            data-testid="compare-target-select"
            value={selection.compareId ?? ""}
            onChange={(e) =>
              onSelectionChange({
                ...selection,
                compareId: e.target.value || null,
              })
            }
          >
            <option value="">Select a version…</option>
            {artifacts.map((a) => (
              <option key={a.id} value={a.id}>
                {compareOptionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onCompare}
          disabled={!canCompare}
          data-testid="compare-versions-button"
          className="inline-flex items-center justify-center rounded border border-ink bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state.kind === "comparing" ? "Comparing…" : "Compare selected versions"}
        </button>
      </div>
      {state.kind === "error" && (
        <p
          className="mt-3 text-[11px] text-danger"
          data-testid="compare-versions-error"
        >
          {state.message}
        </p>
      )}
      {state.kind === "loaded" && <CompareResultPanel result={state.result} />}
    </div>
  );
}

function CompareResultPanel({ result }: { result: ArtifactCompareResponse }) {
  return (
    <div className="mt-4" data-testid="compare-versions-result">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <CompareSideHeader side="base" descriptor={result.base} />
        <CompareSideHeader side="compare" descriptor={result.compare} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-ink sm:grid-cols-4">
        <CompareSummaryCard label="Added" value={result.summary.added_lines} testId="compare-summary-added" />
        <CompareSummaryCard label="Removed" value={result.summary.removed_lines} testId="compare-summary-removed" />
        <CompareSummaryCard label="Changed blocks" value={result.summary.changed_blocks} testId="compare-summary-changed" />
        <CompareSummaryCard label="Unchanged" value={result.summary.unchanged_lines} testId="compare-summary-unchanged" />
      </div>
      {result.warnings.length > 0 && (
        <ul
          className="mt-3 space-y-1 text-[11px] text-ink-subtle"
          data-testid="compare-versions-warnings"
        >
          {result.warnings.map((warning) => (
            <li key={warning}>{compareWarningCopy(warning)}</li>
          ))}
        </ul>
      )}
      <div
        className="mt-3 max-h-96 overflow-auto rounded border border-rule bg-canvas font-mono text-[11px]"
        data-testid="compare-versions-diff"
      >
        {result.diff_blocks.length === 0 ? (
          <p className="p-3 text-ink-subtle">No differences detected.</p>
        ) : (
          result.diff_blocks.map((block, idx) => (
            <div
              key={`${block.base_line_start}-${block.compare_line_start}-${idx}`}
              data-testid={`compare-block-${block.type}`}
              className="border-b border-rule last:border-b-0"
            >
              {block.lines.map((line, lineIdx) => (
                <div key={lineIdx} className="grid grid-cols-2" data-testid={`compare-line-${line.type}`}>
                  <div className={line.type === "removed" ? "bg-rose-50 px-2 py-0.5 text-rose-900" : "px-2 py-0.5 text-ink-muted"}>{line.type === "removed" ? line.text || " " : " "}</div>
                  <div className={line.type === "added" ? "bg-emerald-50 px-2 py-0.5 text-emerald-900" : "px-2 py-0.5 text-ink-muted"}>{line.type === "added" ? line.text || " " : line.type === "context" ? line.text || " " : " "}</div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CompareSideHeader({
  side,
  descriptor,
}: {
  side: "base" | "compare";
  descriptor: ArtifactCompareResponse["base"];
}) {
  return (
    <div
      className="rounded border border-rule bg-canvas p-2"
      data-testid={`compare-side-${side}`}
    >
      <p className="text-[10px] uppercase tracking-wide text-ink-subtle">
        {side === "base" ? "Left version" : "Right version"}
      </p>
      <p className="mt-0.5 text-xs font-medium text-ink">{descriptor.label}</p>
      {descriptor.filename && (
        <p
          className="truncate text-[11px] text-ink-muted"
          title={descriptor.filename}
        >
          {descriptor.filename}
        </p>
      )}
    </div>
  );
}

function CompareSummaryCard({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}) {
  return (
    <div
      className="rounded border border-rule bg-canvas p-2"
      data-testid={testId}
    >
      <p className="text-[10px] uppercase tracking-wide text-ink-subtle">
        {label}
      </p>
      <p className="mt-0.5 text-base font-medium text-ink">{value}</p>
    </div>
  );
}

function compareOptionLabel(artifact: ContractArtifact): string {
  // Mirrors backend ``artifact_compare_label`` so the dropdown text
  // matches the panel header. Falls back to a generic bucket for
  // unknown types so we never render the raw ``artifact_type`` enum.
  const base = (() => {
    switch (artifact.artifact_type) {
      case "original_upload":
        return artifact.source === "request_upload"
          ? "Uploaded agreement"
          : "Source file";
      case "generated_docx":
        return "Generated Word document";
      case "signed_pdf":
        return "Signed PDF";
      case "redline":
        return "Redline";
      case "attachment":
        return "Attachment";
      case "exhibit":
        return "Exhibit";
      default:
        return "File";
    }
  })();
  if (artifact.filename) {
    return `${base} — ${artifact.filename}`;
  }
  return base;
}

function compareWarningCopy(warning: string): string {
  // Map known opaque warning tags to user-friendly copy. Unknown
  // tags fall through to a generic notice so we never render
  // service-layer internals to legal users.
  switch (warning) {
    case "base_text_truncated":
      return "Base version: only the first portion was compared (the document exceeds the size limit).";
    case "compare_text_truncated":
      return "Compare version: only the first portion was compared (the document exceeds the size limit).";
    case "diff_lines_truncated":
      return "The diff was truncated; download the files for a full redline.";
    case "diff_blocks_truncated":
      return "Too many change blocks to render; download the files for a full redline.";
    default:
      return "Some portions of the comparison were truncated.";
  }
}

function LegacyFallbackRow() {
  // No ContractArtifact rows at all — the contract pre-dates artifact
  // tracking. We still show a row so the section never looks empty
  // (and so the user knows the Download action still works against
  // the legacy ``Contract.s3_key`` blob).
  return (
    <ol
      className="mt-3 divide-y divide-rule text-xs"
      data-testid="document-history-list"
    >
      <li
        className="py-2.5"
        data-testid="document-history-legacy-row"
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="font-medium text-ink">Legacy source file</p>
          <span
            className="inline-block rounded bg-ink px-1.5 py-0.5 text-[10px] font-medium text-canvas"
            data-testid="document-history-current-badge"
          >
            Current document
          </span>
        </div>
        <p className="mt-1 text-ink-subtle">
          Stored before artifact tracking. The Download current document
          action still resolves to this file.
        </p>
      </li>
    </ol>
  );
}

function ViewerModeToggle({
  mode,
  onChange,
}: {
  mode: ViewerMode;
  onChange: (mode: ViewerMode) => void;
}) {
  // Tiny segmented-button toggle. We deliberately keep the labels
  // explicit ("Markdown preview" / "View original") so users always
  // know which representation they're looking at.
  const buttonClass = (active: boolean): string =>
    [
      "px-2.5 py-1 text-xs font-medium transition-colors",
      active
        ? "bg-ink text-canvas"
        : "bg-canvas text-ink-muted hover:text-ink",
    ].join(" ");
  return (
    <div
      role="group"
      aria-label="Document view"
      className="inline-flex overflow-hidden rounded border border-rule"
    >
      <button
        type="button"
        className={buttonClass(mode === "markdown")}
        aria-pressed={mode === "markdown"}
        onClick={() => onChange("markdown")}
      >
        Text preview
      </button>
      <button
        type="button"
        className={`border-l border-rule ${buttonClass(mode === "original")}`}
        aria-pressed={mode === "original"}
        onClick={() => onChange("original")}
      >
        View original
      </button>
    </div>
  );
}

type SendDocusealState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; result: SendContractToDocuSealResponse }
  | { kind: "error"; message: string };

interface SignerDraft extends DocuSealSigner {
  // Local-only id so React's keyed list re-render is stable as the
  // user adds and removes rows. Not sent to the backend.
  _key: string;
}

function UnmetPolicyList({ gate }: { gate: ContractApprovalGate }) {
  // Prefer the named summaries the gate now ships (PR #59); fall back
  // to the id list so older/mocked responses without summaries still
  // render something useful instead of an empty bullet.
  const summaries = gate.missing_policies ?? [];
  const ids = gate.missing_policy_ids ?? [];
  const items: { key: string; label: string }[] = summaries.length
    ? summaries.map((p) => ({ key: p.id, label: p.name }))
    : ids.map((id) => ({ key: id, label: id }));
  if (items.length === 0) {
    return <p>A required approval policy has not been satisfied.</p>;
  }
  return (
    <div data-testid="docuseal-gate-missing-policies">
      <p>Required approval policies have not been satisfied:</p>
      <ul className="ml-4 mt-1 list-disc">
        {items.map((item) => (
          <li key={item.key}>{item.label}</li>
        ))}
      </ul>
    </div>
  );
}

function newSignerDraft(): SignerDraft {
  return {
    _key: Math.random().toString(36).slice(2),
    email: "",
    name: "",
    role: "signer",
  };
}

function SendToDocusealPanel({ contractId }: { contractId: string }) {
  const [signers, setSigners] = useState<SignerDraft[]>([newSignerDraft()]);
  const [sendState, setSendState] = useState<SendDocusealState>({
    kind: "idle",
  });
  const [gate, setGate] = useState<ContractApprovalGate | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [approvalOverride, setApprovalOverride] = useState(false);
  const [approvalOverrideReason, setApprovalOverrideReason] = useState("");

  useEffect(() => {
    let cancelled = false;
    getContractApprovalGate(contractId)
      .then((g) => { if (!cancelled) { setGate(g); setGateError(null); } })
      .catch((e) => { if (!cancelled) setGateError(e instanceof Error ? e.message : "Could not verify approvals"); });
    return () => { cancelled = true; };
  }, [contractId]);

  const gateAllows = gate?.allowed ?? false;
  const canSubmit =
    sendState.kind !== "sending" &&
    signers.length > 0 &&
    signers.every((s) => s.email.trim().includes("@") && s.name.trim().length > 0) &&
    (gateAllows || (approvalOverride && approvalOverrideReason.trim().length > 0));

  function updateSigner(index: number, patch: Partial<SignerDraft>) {
    setSigners((prev) =>
      prev.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    );
  }

  function removeSigner(index: number) {
    setSigners((prev) =>
      prev.length === 1
        ? prev
        : prev.filter((_, i) => i !== index),
    );
  }

  function addSigner() {
    setSigners((prev) => [...prev, newSignerDraft()]);
  }

  async function onSubmit() {
    setSendState({ kind: "sending" });
    try {
      const result = await sendContractToDocuseal(contractId, {
        signers: signers.map((s) => ({
          email: s.email.trim(),
          name: s.name.trim(),
          role: (s.role ?? "signer").trim() || "signer",
        })),
        approval_override: approvalOverride,
        approval_override_reason: approvalOverride ? approvalOverrideReason.trim() : undefined,
      });
      setGate((prev) => (prev ? { ...prev, allowed: true } : prev));
      setSendState({ kind: "sent", result });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof MissingDevUserError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Could not send to DocuSeal.";
      setSendState({ kind: "error", message });
    }
  }

  return (
    <section
      className="mt-6 rounded border border-rule p-4"
      data-testid="send-to-docuseal"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-ink">Send to DocuSeal</h2>
        <p className="text-xs text-ink-subtle">
          Whereas hands the latest official document to the DocuSeal peer
          service for signature collection.
        </p>
      </div>

      {sendState.kind === "sent" ? (
        <SendDocusealSuccess result={sendState.result} />
      ) : (
        <div className="mt-3 space-y-3">
          {gateError && (
            <p className="text-xs text-danger" data-testid="docuseal-gate-error">{gateError}</p>
          )}
          {gate && !gate.allowed && (
            <div className="rounded border border-warning bg-warning/10 p-2 text-xs" data-testid="docuseal-gate-blocked">
              <p className="font-medium">Approvals required before sending.</p>
              {gate.code === "required_approval_policy_unmet" ? (
                <UnmetPolicyList gate={gate} />
              ) : (
                <p>Reason: {gate.code}. Active: {gate.active_count}, Rejected: {gate.rejected_count}, Cancelled: {gate.cancelled_count}, Completed: {gate.completed_count}</p>
              )}
              <ApprovalGateRemediation gate={gate} />
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" checked={approvalOverride} onChange={(e) => setApprovalOverride(e.target.checked)} />
                Override approval gate
              </label>
              {approvalOverride && (
                <input className="mt-2 w-full rounded border border-rule px-2 py-1" placeholder="Override reason" value={approvalOverrideReason} onChange={(e) => setApprovalOverrideReason(e.target.value)} data-testid="docuseal-override-reason" />
              )}
            </div>
          )}
          <ul className="space-y-2">
            {signers.map((s, index) => (
              <li
                key={s._key}
                className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]"
                data-testid="docuseal-signer-row"
              >
                <input
                  type="email"
                  className="rounded border border-rule px-2 py-1 text-sm"
                  placeholder="signer@example.com"
                  value={s.email}
                  onChange={(e) =>
                    updateSigner(index, { email: e.target.value })
                  }
                  data-testid={`docuseal-signer-email-${index}`}
                />
                <input
                  type="text"
                  className="rounded border border-rule px-2 py-1 text-sm"
                  placeholder="Signer name"
                  value={s.name}
                  onChange={(e) =>
                    updateSigner(index, { name: e.target.value })
                  }
                  data-testid={`docuseal-signer-name-${index}`}
                />
                <input
                  type="text"
                  className="w-28 rounded border border-rule px-2 py-1 text-sm"
                  placeholder="Role"
                  value={s.role ?? ""}
                  onChange={(e) =>
                    updateSigner(index, { role: e.target.value })
                  }
                  data-testid={`docuseal-signer-role-${index}`}
                />
                <button
                  type="button"
                  className="text-xs underline disabled:opacity-40"
                  disabled={signers.length === 1}
                  onClick={() => removeSigner(index)}
                  aria-label={`Remove signer ${index + 1}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="text-xs underline"
              onClick={addSigner}
              data-testid="docuseal-add-signer"
            >
              Add signer
            </button>
            <button
              type="button"
              className="ml-auto inline-flex items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:cursor-not-allowed disabled:opacity-60 sm:py-1.5"
              onClick={onSubmit}
              disabled={!canSubmit}
              data-testid="docuseal-send-submit"
            >
              {sendState.kind === "sending"
                ? "Sending…"
                : "Send to DocuSeal"}
            </button>
          </div>
          {sendState.kind === "error" && (
            <p
              className="text-xs text-danger"
              data-testid="docuseal-send-error"
            >
              {sendState.message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function SendDocusealSuccess({
  result,
}: {
  result: SendContractToDocuSealResponse;
}) {
  return (
    <div
      className="mt-3 rounded border border-rule bg-canvas-subtle px-3 py-2 text-sm"
      data-testid="docuseal-send-success"
    >
      <p className="text-ink">
        Sent {result.signer_count}{" "}
        {result.signer_count === 1 ? "signer" : "signers"} to DocuSeal.
      </p>
      <p className="mt-1 text-xs text-ink-subtle">
        {result.filename ? <>Artifact: {result.filename}. </> : null}
        {result.submission_id ? (
          <>Submission id: {result.submission_id}.</>
        ) : (
          <>DocuSeal did not return a submission id.</>
        )}
      </p>
      {result.embed_url && (
        <p className="mt-1 text-xs">
          <a
            href={result.embed_url}
            target="_blank"
            rel="noreferrer noopener"
            className="underline"
            data-testid="docuseal-embed-link"
          >
            Open signing flow
          </a>
        </p>
      )}
    </div>
  );
}

function ReviewReminder({
  fields,
  clauses,
}: {
  fields: ExtractedField[];
  clauses: Clause[];
}) {
  if (fields.length === 0 && clauses.length === 0) return null;
  return (
    <p className="mt-3 rounded-md border border-rule bg-canvas-subtle px-3 py-2 text-xs text-ink-muted">
      Whereas surfaces machine-extracted information and heuristically
      segmented clauses; it does not provide legal advice. Review every
      field and clause before relying on it.
    </p>
  );
}
