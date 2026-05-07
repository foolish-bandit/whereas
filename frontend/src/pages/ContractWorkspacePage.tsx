import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import ClausesPanel from "../components/ClausesPanel";
import DocumentViewer from "../components/DocumentViewer";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import MetadataPanel from "../components/MetadataPanel";
import RightPanelTabs from "../components/RightPanelTabs";
import StatusBadge from "../components/StatusBadge";
import {
  ApiError,
  MissingDevUserError,
  downloadContract,
  getContract,
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
  ContractDetail,
  ExtractedField,
} from "../types/contracts";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; contract: ContractDetail }
  | { kind: "error"; title: string; description: string };

type DownloadState =
  | { kind: "idle" }
  | { kind: "downloading" }
  | { kind: "error"; message: string };

type SidebarTab = "metadata" | "clauses";

export default function ContractWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SidebarTab>("metadata");
  const [downloadState, setDownloadState] = useState<DownloadState>({
    kind: "idle",
  });

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    setSelectedKey(null);
    setActiveTab("metadata");
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
  }, [contract, selectedKey]);

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
          to="/contracts"
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
          to="/contracts"
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
        to="/contracts"
        className="text-sm text-ink-muted hover:text-ink"
      >
        ← Back to contracts
      </Link>

      <ContractHeader
        contract={state.contract}
        downloadState={downloadState}
        onDownload={onDownload}
      />

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div>
          <DocumentViewer
            fullText={state.contract.full_text}
            selectedSpan={selectedSpan}
            selectionToken={selectedKey}
          />
        </div>
        <Sidebar
          contract={state.contract}
          activeTab={activeTab}
          onTabChange={(tab) => {
            setActiveTab(tab);
            setSelectedKey(null);
          }}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
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
}

function Sidebar({
  contract,
  activeTab,
  onTabChange,
  selectedKey,
  onSelect,
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
  ];
  return (
    <aside>
      <RightPanelTabs tabs={tabs} active={activeTab} onChange={onTabChange} />
      {activeTab === "metadata" ? (
        <MetadataPanel
          fields={contract.extracted_fields}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      ) : (
        <ClausesPanel
          clauses={contract.clauses}
          fullText={contract.full_text}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      )}
      <ReviewReminder
        fields={contract.extracted_fields}
        clauses={contract.clauses}
      />
    </aside>
  );
}

interface ContractHeaderProps {
  contract: ContractDetail;
  downloadState: DownloadState;
  onDownload: () => void;
}

function ContractHeader({
  contract,
  downloadState,
  onDownload,
}: ContractHeaderProps) {
  return (
    <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="font-serif text-2xl text-ink">{contract.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          <StatusBadge status={contract.status} />
          <span>{mimeLabel(contract.mime_type)}</span>
          {contract.page_count != null && (
            <span>{contract.page_count} pages</span>
          )}
          <span>Uploaded {formatDate(contract.created_at)}</span>
          <span>Updated {formatDateTime(contract.updated_at)}</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2">
        <button
          type="button"
          onClick={onDownload}
          disabled={downloadState.kind === "downloading"}
          className="inline-flex items-center rounded border border-ink bg-ink px-3 py-1.5 text-sm font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          {downloadState.kind === "downloading"
            ? "Preparing…"
            : "Download original"}
        </button>
        {downloadState.kind === "error" && (
          <p className="max-w-xs text-right text-xs text-danger">
            {downloadState.message}
          </p>
        )}
      </div>
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
