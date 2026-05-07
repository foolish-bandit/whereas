import { useEffect, useMemo, useState } from "react";

import {
  ApiError,
  MissingDevUserError,
  getPlaybooks,
  reviewContractWithPlaybook,
} from "../lib/api";
import type { PlaybookSummary } from "../types/playbooks";
import type {
  PlaybookReviewResult,
  PlaybookRuleMatchResult,
} from "../types/review";

const SEVERITY_RANK: Record<string, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const RULE_TYPE_LABELS: Record<string, string> = {
  required_clause: "Required clause",
  preferred_value: "Preferred value",
  text_contains: "Text contains",
};

interface ReviewPanelProps {
  contractId: string;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /**
   * Called whenever the rendered review changes (loaded, cleared on
   * contract change, etc.). The parent page uses this to resolve
   * `review:<rule_id>` selection keys back to their evidence spans.
   */
  onResultsChange?: (result: PlaybookReviewResult | null) => void;
}

type PlaybookListState =
  | { kind: "loading" }
  | { kind: "loaded"; playbooks: PlaybookSummary[] }
  | { kind: "error"; message: string };

type ReviewState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "loaded"; result: PlaybookReviewResult }
  | { kind: "error"; message: string };

export default function ReviewPanel({
  contractId,
  selectedKey,
  onSelect,
  onResultsChange,
}: ReviewPanelProps) {
  const [playbookListState, setPlaybookListState] = useState<PlaybookListState>(
    { kind: "loading" },
  );
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string>("");
  const [reviewState, setReviewState] = useState<ReviewState>({ kind: "idle" });

  // Notify the parent of results changes so it can resolve evidence
  // selection keys to spans for the document viewer. Effect on
  // reviewState rather than inline in onRun so contract-change resets
  // also propagate.
  useEffect(() => {
    if (!onResultsChange) return;
    if (reviewState.kind === "loaded") {
      onResultsChange(reviewState.result);
    } else {
      onResultsChange(null);
    }
  }, [reviewState, onResultsChange]);

  useEffect(() => {
    const controller = new AbortController();
    setPlaybookListState({ kind: "loading" });
    getPlaybooks({ signal: controller.signal })
      .then((playbooks) => {
        const active = playbooks.filter((p) => p.is_active);
        setPlaybookListState({ kind: "loaded", playbooks: active });
        // Auto-select the first active playbook so a one-click review is
        // possible. The user can switch via the dropdown if needed.
        if (active.length > 0) setSelectedPlaybookId(active[0].id);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof MissingDevUserError) {
          setPlaybookListState({
            kind: "error",
            message:
              "Set a development user ID in Settings before running a review.",
          });
          return;
        }
        if (err instanceof ApiError) {
          setPlaybookListState({ kind: "error", message: err.message });
          return;
        }
        setPlaybookListState({
          kind: "error",
          message: "Could not load playbooks.",
        });
      });
    return () => controller.abort();
  }, []);

  // If the contract changes (or its segmented clauses do), the review is
  // stale — clear it so the UI doesn't show outdated results against the
  // new contract.
  useEffect(() => {
    setReviewState({ kind: "idle" });
  }, [contractId]);

  async function onRun() {
    if (!selectedPlaybookId) return;
    setReviewState({ kind: "running" });
    try {
      const result = await reviewContractWithPlaybook(
        contractId,
        selectedPlaybookId,
      );
      setReviewState({ kind: "loaded", result });
    } catch (err) {
      if (err instanceof MissingDevUserError) {
        setReviewState({ kind: "error", message: err.message });
        return;
      }
      if (err instanceof ApiError) {
        setReviewState({ kind: "error", message: err.message });
        return;
      }
      setReviewState({
        kind: "error",
        message: "Could not run the review.",
      });
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      <div className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">Playbook review</h2>
        <p className="mt-0.5 text-xs text-ink-subtle">
          Deterministic rule matching against this contract&rsquo;s segmented
          clauses. Whereas surfaces information about contracts; it does not
          provide legal advice.
        </p>
      </div>

      <div className="space-y-3 px-4 py-3">
        <PlaybookPicker
          state={playbookListState}
          selectedPlaybookId={selectedPlaybookId}
          onChange={setSelectedPlaybookId}
        />
        <button
          type="button"
          onClick={onRun}
          disabled={
            !selectedPlaybookId || reviewState.kind === "running" ||
            playbookListState.kind !== "loaded" ||
            playbookListState.playbooks.length === 0
          }
          className="inline-flex items-center rounded border border-ink bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          {reviewState.kind === "running" ? "Running…" : "Run review"}
        </button>
      </div>

      <div className="border-t border-rule px-4 py-3">
        <ResultsArea
          state={reviewState}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}

interface PlaybookPickerProps {
  state: PlaybookListState;
  selectedPlaybookId: string;
  onChange: (id: string) => void;
}

function PlaybookPicker({
  state,
  selectedPlaybookId,
  onChange,
}: PlaybookPickerProps) {
  if (state.kind === "loading") {
    return (
      <p className="text-xs text-ink-subtle">Loading playbooks…</p>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="text-xs text-danger">{state.message}</p>
    );
  }
  if (state.playbooks.length === 0) {
    return (
      <p className="text-xs text-ink-subtle">
        No active playbooks in this organization. Create one first.
      </p>
    );
  }
  return (
    <label className="block text-xs text-ink-muted">
      <span className="mb-1 block text-ink-subtle">Playbook</span>
      <select
        value={selectedPlaybookId}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink"
        aria-label="Select playbook to run review against"
      >
        {state.playbooks.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

interface ResultsAreaProps {
  state: ReviewState;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}

function ResultsArea({
  state,
  selectedKey,
  onSelect,
}: ResultsAreaProps) {
  if (state.kind === "idle") {
    return (
      <p className="text-xs text-ink-subtle">
        Run a review to see deterministic rule outcomes. Results are not
        persisted.
      </p>
    );
  }
  if (state.kind === "running") {
    return <p className="text-xs text-ink-subtle">Running review…</p>;
  }
  if (state.kind === "error") {
    return <p className="text-xs text-danger">{state.message}</p>;
  }
  const { result } = state;
  if (result.results.length === 0) {
    return (
      <p className="text-xs text-ink-subtle">
        This playbook has no rules; nothing to evaluate.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <Summary result={result} />
      <RuleResultList
        results={result.results}
        selectedKey={selectedKey}
        onSelect={onSelect}
      />
    </div>
  );
}

function Summary({ result }: { result: PlaybookReviewResult }) {
  return (
    <div className="flex flex-wrap gap-2 text-[11px]">
      <span className="rounded-full border border-success-ring bg-success-soft px-2 py-0.5 text-success">
        {result.passed_count} passed
      </span>
      <span className="rounded-full border border-danger-ring bg-danger-soft px-2 py-0.5 text-danger">
        {result.failed_count} failed
      </span>
      <span className="rounded-full border border-rule bg-canvas-subtle px-2 py-0.5 text-ink-muted">
        {result.rules_checked} rule{result.rules_checked === 1 ? "" : "s"}{" "}
        checked
      </span>
    </div>
  );
}

interface RuleResultListProps {
  results: PlaybookRuleMatchResult[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}

function RuleResultList({
  results,
  selectedKey,
  onSelect,
}: RuleResultListProps) {
  const sorted = useMemo(() => {
    return [...results].sort((a, b) => {
      // Failures first; within each group, by severity then title.
      if (a.status !== b.status) {
        return a.status === "fail" ? -1 : 1;
      }
      const sa = SEVERITY_RANK[a.severity] ?? 99;
      const sb = SEVERITY_RANK[b.severity] ?? 99;
      if (sa !== sb) return sa - sb;
      return a.title.localeCompare(b.title);
    });
  }, [results]);

  return (
    <ul className="divide-y divide-rule">
      {sorted.map((r) => {
        const key = `review:${r.rule_id}`;
        const hasEvidence =
          typeof r.span_start === "number" && typeof r.span_end === "number";
        const isSelected = key === selectedKey;
        return (
          <li key={r.rule_id} className="py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <StatusPill status={r.status} />
                  <SeverityBadge severity={r.severity} />
                </div>
                <h3 className="mt-1.5 text-sm font-medium text-ink">
                  {r.title}
                </h3>
                <p className="mt-0.5 font-mono text-[11px] text-ink-subtle">
                  {RULE_TYPE_LABELS[r.rule_type] ?? r.rule_type} ·{" "}
                  {r.clause_type}
                </p>
              </div>
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">{r.message}</p>
            {r.matched_terms.length > 0 && (
              <p className="mt-1 text-[11px] text-ink-subtle">
                Matched terms:{" "}
                <span className="font-mono text-ink-muted">
                  {r.matched_terms.join(", ")}
                </span>
              </p>
            )}
            {r.expected_value !== null && (
              <p className="mt-1 text-[11px] text-ink-subtle">
                Expected value:{" "}
                <span className="font-mono text-ink-muted">
                  {r.expected_value}
                </span>
              </p>
            )}
            {hasEvidence ? (
              <button
                type="button"
                onClick={() => onSelect(isSelected ? null : key)}
                className={[
                  "mt-2 block w-full rounded border px-2.5 py-2 text-left text-xs transition-colors",
                  isSelected
                    ? "border-info-ring bg-info-soft"
                    : "border-rule bg-canvas-subtle hover:bg-canvas-muted",
                ].join(" ")}
                aria-pressed={isSelected}
              >
                {r.clause_heading && (
                  <div className="mb-0.5 font-medium text-ink">
                    {r.clause_heading}
                  </div>
                )}
                <div className="line-clamp-3 text-ink-muted">
                  {r.evidence_text ?? "Citation available"}
                </div>
                <div className="mt-1 text-[10px] text-ink-subtle">
                  Click to highlight in document
                </div>
              </button>
            ) : (
              <p className="mt-2 text-[11px] text-ink-subtle">
                No matching clause to cite.
              </p>
            )}
            {r.guidance && (
              <p className="mt-1.5 text-[11px] text-ink-subtle">
                <span className="text-ink-subtle">Guidance:</span>{" "}
                {r.guidance}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StatusPill({ status }: { status: "pass" | "fail" }) {
  const className =
    status === "pass"
      ? "border-success-ring bg-success-soft text-success"
      : "border-danger-ring bg-danger-soft text-danger";
  const label = status === "pass" ? "Pass" : "Fail";
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        className,
      ].join(" ")}
    >
      {label}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const color = (() => {
    switch (severity) {
      case "blocker":
      case "high":
        return "border-danger-ring bg-danger-soft text-danger";
      case "medium":
        return "border-warning-ring bg-warning-soft text-warning";
      case "low":
        return "border-rule bg-canvas-subtle text-ink-muted";
      case "info":
      default:
        return "border-rule bg-canvas-subtle text-ink-subtle";
    }
  })();
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide",
        color,
      ].join(" ")}
    >
      {severity}
    </span>
  );
}
