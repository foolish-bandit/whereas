import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import ClausesPanel from "../components/ClausesPanel";
import DocumentViewer from "../components/DocumentViewer";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import MarkdownPreview from "../components/MarkdownPreview";
import MetadataPanel from "../components/MetadataPanel";
import ReviewPanel from "../components/ReviewPanel";
import RightPanelTabs from "../components/RightPanelTabs";
import StatusBadge from "../components/StatusBadge";
import {
  ApiError,
  MissingDevUserError,
  downloadContract,
  getContract,
  getContractArtifacts,
} from "../lib/api";
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
import type { ReviewRunDetail } from "../types/findings";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; contract: ContractDetail }
  | { kind: "error"; title: string; description: string };

type DownloadState =
  | { kind: "idle" }
  | { kind: "downloading" }
  | { kind: "error"; message: string };

type SidebarTab = "metadata" | "clauses" | "review";

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
  const [activeRun, setActiveRun] = useState<ReviewRunDetail | null>(null);
  // Three meaningful states for the artifact strip:
  //   - "loading"  → request in flight, render nothing yet
  //   - "loaded"   → request resolved; ``artifact`` is the official
  //                  original_upload row, or ``null`` if the contract
  //                  predates the artifact model and has not been
  //                  backfilled. ``null`` lets the UI surface a
  //                  legacy fallback hint without pretending an
  //                  artifact exists.
  //   - "error"    → request failed; treated like loading from the
  //                  user's perspective (no strip), so the download
  //                  button stays the only thing that matters.
  const [artifactState, setArtifactState] = useState<
    | { kind: "loading" }
    | { kind: "loaded"; artifact: ContractArtifact | null }
    | { kind: "error" }
  >({ kind: "loading" });

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
    setArtifactState({ kind: "loading" });
    getContractArtifacts(id, { signal: controller.signal })
      .then((rows) => {
        if (controller.signal.aborted) return;
        const original =
          rows.find((a) => a.artifact_type === "original_upload") ?? null;
        setArtifactState({ kind: "loaded", artifact: original });
      })
      .catch(() => {
        // Artifact metadata is a hint, not load-bearing — the contract
        // workspace must remain usable even if the listing endpoint
        // fails or the user lacks access. Swallow here; primary errors
        // are surfaced via the contract load above.
        if (controller.signal.aborted) return;
        setArtifactState({ kind: "error" });
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

  if (state.kind === "loading") {
    return (
      <div>
        <Link
          to="/demo/contracts"
          className="text-sm text-ink-muted hover:text-ink"
        >
          ← Back to contracts
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
          to="/demo/contracts"
          className="text-sm text-ink-muted hover:text-ink"
        >
          ← Back to contracts
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

  return (
    <div>
      <Link
        to="/demo/contracts"
        className="text-sm text-ink-muted hover:text-ink"
      >
        ← Back to contracts
      </Link>

      <ContractHeader
        contract={state.contract}
        downloadState={downloadState}
        onDownload={onDownload}
        artifactState={artifactState}
      />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
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

type ArtifactStripState =
  | { kind: "loading" }
  | { kind: "loaded"; artifact: ContractArtifact | null }
  | { kind: "error" };

interface ContractHeaderProps {
  contract: ContractDetail;
  downloadState: DownloadState;
  onDownload: () => void;
  artifactState: ArtifactStripState;
}

function ContractHeader({
  contract,
  downloadState,
  onDownload,
  artifactState,
}: ContractHeaderProps) {
  return (
    <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <h1 className="break-words font-serif text-xl text-ink sm:text-2xl">
          {contract.title}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          <StatusBadge status={contract.status} />
          <span>{mimeLabel(contract.mime_type)}</span>
          {contract.page_count != null && (
            <span>{contract.page_count} pages</span>
          )}
          <span>Uploaded {formatDate(contract.created_at)}</span>
          <span>Updated {formatDateTime(contract.updated_at)}</span>
        </div>
        <OriginalArtifactStrip
          state={artifactState}
          contract={contract}
        />
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
            : "Download original"}
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

function OriginalArtifactStrip({
  state,
  contract,
}: {
  state: ArtifactStripState;
  contract: ContractDetail;
}) {
  // Whereas tracks the DOCX/PDF as the official legal artifact and the
  // Markdown snapshot as the working representation. This strip is the
  // small affordance in the workspace that makes the original artifact
  // visible without redesigning the page.
  //
  // Three rendered cases:
  //   1. an official original_upload artifact exists → show filename
  //      and MIME with the "Official" badge.
  //   2. the artifacts list resolved but is empty → the contract
  //      predates the artifact model and has not been backfilled yet.
  //      Surface a quiet "Legacy original" hint so users know the
  //      Download original button still works against the contract row.
  //   3. loading or error → render nothing. The Download original
  //      button stays the load-bearing affordance.
  if (state.kind !== "loaded") return null;
  if (state.artifact) {
    const artifact = state.artifact;
    return (
      <div
        className="mt-3 inline-flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-rule bg-canvas-subtle px-2.5 py-1.5 text-xs text-ink-muted"
        data-testid="original-artifact-strip"
      >
        <span className="font-medium text-ink">Original artifact</span>
        {artifact.is_official && (
          <span className="rounded bg-ink px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-canvas">
            Official
          </span>
        )}
        {artifact.filename && (
          <span className="truncate" title={artifact.filename}>
            {artifact.filename}
          </span>
        )}
        {artifact.mime_type && <span>{mimeLabel(artifact.mime_type)}</span>}
      </div>
    );
  }
  return (
    <div
      className="mt-3 inline-flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-dashed border-rule bg-canvas-subtle px-2.5 py-1.5 text-xs text-ink-muted"
      data-testid="original-artifact-strip-legacy"
    >
      <span className="font-medium text-ink">Original artifact</span>
      <span>
        Legacy original — uploaded before artifact tracking. Download
        original still works from the contract record.
      </span>
      <span>{mimeLabel(contract.mime_type)}</span>
    </div>
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
        Markdown preview
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
