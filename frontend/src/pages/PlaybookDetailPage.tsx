import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import Pill from "../components/ui/Pill";
import SeverityTag, { type Severity } from "../components/ui/SeverityTag";
import {
  ApiError,
  MissingDevUserError,
  deactivatePlaybook,
  getPlaybook,
} from "../lib/api";
import { formatDateTime } from "../lib/format";
import type {
  PlaybookDetail,
  PlaybookRuleSummary,
  PlaybookSeverity,
} from "../types/playbooks";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; playbook: PlaybookDetail }
  | { kind: "error"; title: string; description: string };

type DeactivateState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string };

export default function PlaybookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [deactivate, setDeactivate] = useState<DeactivateState>({
    kind: "idle",
  });

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    // Pass includeInactive so the detail page can render a deactivated
    // playbook the user navigated to from the list with "Show deactivated"
    // enabled. The backend defaults to 404 on inactive rows, which is
    // the right default for clients that don't model archives.
    getPlaybook(id, { signal: controller.signal, includeInactive: true })
      .then((playbook) => setState({ kind: "loaded", playbook }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof MissingDevUserError) {
          setState({
            kind: "error",
            title: "No development user ID configured",
            description:
              "Set a development user ID in Settings before opening a playbook.",
          });
          return;
        }
        if (err instanceof ApiError) {
          setState({
            kind: "error",
            title:
              err.status === 404
                ? "Playbook not found"
                : "Could not load playbook",
            description: err.message,
          });
          return;
        }
        setState({
          kind: "error",
          title: "Could not load playbook",
          description: "An unexpected error occurred.",
        });
      });
    return () => controller.abort();
  }, [id]);

  if (state.kind === "loading") {
    return (
      <div>
        <Link to="/demo/playbooks" className="text-sm text-ink-muted hover:text-ink">
          ← Back to playbooks
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
        <Link to="/demo/playbooks" className="text-sm text-ink-muted hover:text-ink">
          ← Back to playbooks
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

  const { playbook } = state;

  async function onDeactivate() {
    if (!playbook.is_active) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Deactivate "${playbook.name}"? It will be hidden from the active list and cannot be run against new contracts.`,
      )
    ) {
      return;
    }
    setDeactivate({ kind: "submitting" });
    try {
      const updated = await deactivatePlaybook(playbook.id);
      setState({
        kind: "loaded",
        playbook: { ...playbook, is_active: updated.is_active, updated_at: updated.updated_at },
      });
      setDeactivate({ kind: "idle" });
    } catch (err) {
      const message =
        err instanceof MissingDevUserError
          ? err.message
          : err instanceof ApiError
            ? err.message
            : "Could not deactivate the playbook.";
      setDeactivate({ kind: "error", message });
    }
  }

  return (
    <div>
      <Link to="/demo/playbooks" className="text-sm text-ink-muted hover:text-ink">
        ← Back to playbooks
      </Link>

      <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h1 className="break-words font-serif text-xl text-ink sm:text-2xl">
            {playbook.name}
          </h1>
          {playbook.description && (
            <p className="mt-1 max-w-3xl text-sm text-ink-muted">
              {playbook.description}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
            <MetadataChip
              label="Contract type"
              value={playbook.contract_type ?? "—"}
            />
            <MetadataChip
              label="Jurisdiction"
              value={playbook.jurisdiction ?? "—"}
            />
            <MetadataChip label="Version" value={playbook.version} />
            <MetadataChip
              label="Status"
              value={playbook.is_active ? "Active" : "Deactivated"}
            />
            <span>Updated {formatDateTime(playbook.updated_at)}</span>
          </div>
        </div>
        {playbook.is_active && (
          <div className="flex flex-col items-stretch gap-2 sm:items-end">
            <button
              type="button"
              onClick={onDeactivate}
              disabled={deactivate.kind === "submitting"}
              className="inline-flex w-full items-center justify-center rounded border border-rule bg-canvas px-3 py-2 text-sm font-medium text-ink hover:border-danger-ring hover:text-danger disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:py-1.5"
            >
              {deactivate.kind === "submitting"
                ? "Deactivating…"
                : "Deactivate"}
            </button>
            {deactivate.kind === "error" && (
              <p className="max-w-xs text-xs text-danger sm:text-right">
                {deactivate.message}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <RulesPanel rules={playbook.rules} />
        <YamlPanel yaml={playbook.yaml_source} />
      </div>

      <p className="mt-3 rounded-md border border-rule bg-canvas-subtle px-3 py-2 text-xs text-ink-muted">
        This page is read-only. To run this playbook against a contract, open
        the contract and use the Review tab. Whereas surfaces information
        about contracts; it does not provide legal advice.
      </p>
    </div>
  );
}

function MetadataChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-ink-subtle">{label}:</span>
      <span className="text-ink">{value}</span>
    </span>
  );
}

const RULE_TYPE_LABELS: Record<string, string> = {
  required_clause: "Required clause",
  preferred_value: "Preferred value",
  text_contains: "Text contains",
};

const SEVERITY_ORDER: PlaybookSeverity[] = [
  "blocker",
  "high",
  "medium",
  "low",
  "info",
];

function severityRank(value: string): number {
  const index = SEVERITY_ORDER.indexOf(value as PlaybookSeverity);
  return index < 0 ? SEVERITY_ORDER.length : index;
}

function RulesPanel({ rules }: { rules: PlaybookRuleSummary[] }) {
  if (rules.length === 0) {
    return (
      <div className="rounded-lg border border-rule bg-canvas p-5">
        <h2 className="text-sm font-medium text-ink">Rules</h2>
        <p className="mt-2 text-sm text-ink-muted">
          This playbook has no rules. Edit the YAML to add some.
        </p>
      </div>
    );
  }
  const sorted = [...rules].sort((a, b) => {
    const r = severityRank(a.severity) - severityRank(b.severity);
    return r !== 0 ? r : a.title.localeCompare(b.title);
  });
  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      <div className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">
          Rules ({rules.length})
        </h2>
        <p className="mt-0.5 text-xs text-ink-subtle">
          Read-only view. Authoring tools land in a follow-up release.
        </p>
      </div>
      <ul className="divide-y divide-rule">
        {sorted.map((r) => (
          <li key={r.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-ink">{r.title}</h3>
                <p className="mt-0.5 font-mono text-[11px] text-ink-subtle">
                  {r.id}
                </p>
              </div>
              <SeverityBadge severity={r.severity} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
              <span>
                <span className="text-ink-subtle">Type:</span>{" "}
                {RULE_TYPE_LABELS[r.rule_type] ?? r.rule_type}
              </span>
              <span>
                <span className="text-ink-subtle">Clause:</span>{" "}
                {r.clause_type}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  if (severity === "blocker" || severity === "high" || severity === "medium" || severity === "low") {
    return <SeverityTag level={severity as Severity}>{severity}</SeverityTag>;
  }
  return (
    <Pill tone="neutral" variant="soft" className="uppercase tracking-wide">
      {severity}
    </Pill>
  );
}

function YamlPanel({ yaml }: { yaml: string }) {
  return (
    <aside className="overflow-hidden rounded-lg border border-rule bg-canvas">
      <div className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">YAML source</h2>
        <p className="mt-0.5 text-xs text-ink-subtle">
          The verbatim YAML stored on the server.
        </p>
      </div>
      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-ink">
        {yaml}
      </pre>
    </aside>
  );
}
