import { useEffect, useMemo, useState } from "react";

import {
  ApiError,
  MissingDevUserError,
  createPlaybookReviewRun,
  getPlaybookReviewRun,
  getPlaybooks,
  listPlaybookReviewRuns,
  updateFindingStatus,
} from "../lib/api";
import type {
  DeviationFinding,
  ReviewRunDetail,
  ReviewRunSummary,
  ReviewerFindingStatus,
} from "../types/findings";
import type { PlaybookSummary } from "../types/playbooks";
import type { Clause, ExtractedField } from "../types/contracts";
import type { PlaybookRuleMatchResult } from "../types/review";
import FindingRemediationCard from "./FindingRemediationCard";
import Pill from "./ui/Pill";
import SeverityTag, { type Severity } from "./ui/SeverityTag";

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

const FINDING_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  reviewed: "Reviewed",
  ignored: "Ignored",
  superseded: "Superseded",
};

interface ReviewPanelProps {
  contractId: string;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /**
   * Called whenever the rendered run changes (loaded, cleared on
   * Repository record change, etc.). The parent page uses this to resolve
   * `review:<rule_id>` selection keys back to evidence spans.
   */
  onRunChange?: (run: ReviewRunDetail | null) => void;
  /**
   * Retained for caller compatibility. Persisted backend playbook runs are
   * the one review source of truth; ReviewPanel no longer evaluates a second
   * client-only checklist from these arrays.
   */
  clauses?: Clause[];
  extractedFields?: ExtractedField[];
}

type PlaybookListState =
  | { kind: "loading" }
  | { kind: "loaded"; playbooks: PlaybookSummary[] }
  | { kind: "error"; message: string };

type RunsState =
  | { kind: "loading" }
  | { kind: "loaded"; runs: ReviewRunSummary[] }
  | { kind: "error"; message: string };

type ActiveRunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "loading" }
  | { kind: "loaded"; run: ReviewRunDetail }
  | { kind: "error"; message: string };

export default function ReviewPanel({
  contractId,
  selectedKey,
  onSelect,
  onRunChange,
}: ReviewPanelProps) {
  const [playbookListState, setPlaybookListState] = useState<PlaybookListState>(
    { kind: "loading" },
  );
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string>("");
  const [runsState, setRunsState] = useState<RunsState>({ kind: "loading" });
  const [activeRun, setActiveRun] = useState<ActiveRunState>({ kind: "idle" });

  // Notify the parent of run changes so it can resolve evidence keys.
  useEffect(() => {
    if (!onRunChange) return;
    if (activeRun.kind === "loaded") {
      onRunChange(activeRun.run);
    } else {
      onRunChange(null);
    }
  }, [activeRun, onRunChange]);

  // Load active playbooks.
  useEffect(() => {
    const controller = new AbortController();
    setPlaybookListState({ kind: "loading" });
    getPlaybooks({ signal: controller.signal })
      .then((playbooks) => {
        const active = playbooks.filter((p) => p.is_active);
        setPlaybookListState({ kind: "loaded", playbooks: active });
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

  // Load prior runs for this Repository record; auto-select the newest.
  useEffect(() => {
    const controller = new AbortController();
    setRunsState({ kind: "loading" });
    setActiveRun({ kind: "idle" });
    listPlaybookReviewRuns(contractId, { signal: controller.signal })
      .then((runs) => {
        setRunsState({ kind: "loaded", runs });
        if (runs.length > 0) {
          loadRun(runs[0].id, controller.signal);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof MissingDevUserError) {
          setRunsState({
            kind: "error",
            message:
              "Set a development user ID in Settings before viewing reviews.",
          });
          return;
        }
        if (err instanceof ApiError) {
          setRunsState({ kind: "error", message: err.message });
          return;
        }
        setRunsState({ kind: "error", message: "Could not load review runs." });
      });
    return () => controller.abort();
    // We deliberately exclude `loadRun` from deps; it captures
    // setActiveRun, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);

  async function loadRun(runId: string, signal?: AbortSignal): Promise<void> {
    setActiveRun({ kind: "loading" });
    try {
      const run = await getPlaybookReviewRun(contractId, runId, { signal });
      setActiveRun({ kind: "loaded", run });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof ApiError) {
        setActiveRun({ kind: "error", message: err.message });
        return;
      }
      setActiveRun({ kind: "error", message: "Could not load review run." });
    }
  }

  async function onRun(): Promise<void> {
    if (!selectedPlaybookId) return;
    setActiveRun({ kind: "running" });
    try {
      const run = await createPlaybookReviewRun(contractId, selectedPlaybookId);
      setActiveRun({ kind: "loaded", run });
      // Refresh the runs list to include the new entry at the top.
      const runs = await listPlaybookReviewRuns(contractId);
      setRunsState({ kind: "loaded", runs });
    } catch (err) {
      if (err instanceof MissingDevUserError) {
        setActiveRun({ kind: "error", message: err.message });
        return;
      }
      if (err instanceof ApiError) {
        setActiveRun({ kind: "error", message: err.message });
        return;
      }
      setActiveRun({ kind: "error", message: "Could not run the review." });
    }
  }

  async function onUpdateFinding(
    findingId: string,
    status: ReviewerFindingStatus,
  ): Promise<void> {
    try {
      const updated = await updateFindingStatus(contractId, findingId, status);
      setActiveRun((prev) => {
        if (prev.kind !== "loaded") return prev;
        const findings = prev.run.findings.map((f) =>
          f.id === findingId ? updated : f,
        );
        return { kind: "loaded", run: { ...prev.run, findings } };
      });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Could not update the finding.";
      setActiveRun((prev) =>
        prev.kind === "loaded"
          ? { kind: "loaded", run: prev.run }
          : { kind: "error", message },
      );
      // Surface the error inline by adding a transient message; for
      // simplicity we rely on the next refresh. A toast system would
      // belong in a follow-up.
      console.warn("update finding failed", err);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      <div className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">Playbook review</h2>
        <p className="mt-0.5 text-xs text-ink-subtle">
          Deterministic rule matching against this Repository record&rsquo;s
          segmented clauses. Findings are saved per run. Whereas surfaces
          information about agreements; it does not provide legal advice.
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
            !selectedPlaybookId || activeRun.kind === "running" ||
            playbookListState.kind !== "loaded" ||
            playbookListState.playbooks.length === 0
          }
          className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-xs font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:py-1.5"
        >
          {activeRun.kind === "running" ? "Running…" : "Run review and save"}
        </button>
      </div>

      <div className="border-t border-rule px-4 py-3">
        <RunHistory
          runsState={runsState}
          activeRunId={
            activeRun.kind === "loaded" ? activeRun.run.id : null
          }
          onSelect={(runId) => loadRun(runId)}
        />
        <ActiveRunArea
          contractId={contractId}
          state={activeRun}
          selectedKey={selectedKey}
          onSelect={onSelect}
          onUpdateFinding={onUpdateFinding}
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
    return <p className="text-xs text-ink-subtle">Loading playbooks…</p>;
  }
  if (state.kind === "error") {
    return <p className="text-xs text-danger">{state.message}</p>;
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

interface RunHistoryProps {
  runsState: RunsState;
  activeRunId: string | null;
  onSelect: (runId: string) => void;
}

function RunHistory({ runsState, activeRunId, onSelect }: RunHistoryProps) {
  if (runsState.kind === "loading") {
    return <p className="text-xs text-ink-subtle">Loading prior runs…</p>;
  }
  if (runsState.kind === "error") {
    return <p className="text-xs text-danger">{runsState.message}</p>;
  }
  if (runsState.runs.length === 0) {
    return null;
  }
  if (runsState.runs.length === 1) {
    // One run isn't worth a picker; the latest-run summary below covers it.
    return null;
  }
  return (
    <div className="mb-3 rounded border border-rule bg-canvas-subtle px-2.5 py-2">
      <p className="mb-1 text-[11px] uppercase tracking-wide text-ink-subtle">
        Prior runs
      </p>
      <ul className="space-y-1">
        {runsState.runs.map((run) => {
          const isActive = run.id === activeRunId;
          return (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => onSelect(run.id)}
                aria-pressed={isActive}
                className={[
                  "flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] transition-colors",
                  isActive
                    ? "bg-info-soft text-ink"
                    : "text-ink-muted hover:bg-canvas",
                ].join(" ")}
              >
                <span className="truncate">
                  {run.playbook_name}
                  <span className="ml-1 text-ink-subtle">
                    · {formatRunDate(run.created_at)}
                  </span>
                </span>
                <span className="ml-2 whitespace-nowrap text-ink-subtle">
                  {run.failed_count}f / {run.passed_count}p
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface ActiveRunAreaProps {
  contractId: string;
  state: ActiveRunState;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onUpdateFinding: (
    findingId: string,
    status: ReviewerFindingStatus,
  ) => void;
}

function ActiveRunArea({
  contractId,
  state,
  selectedKey,
  onSelect,
  onUpdateFinding,
}: ActiveRunAreaProps) {
  if (state.kind === "idle") {
    return (
      <p className="text-xs text-ink-subtle">
        Run a review to see deterministic rule outcomes saved against this
        Repository record.
      </p>
    );
  }
  if (state.kind === "running") {
    return <p className="text-xs text-ink-subtle">Running review…</p>;
  }
  if (state.kind === "loading") {
    return <p className="text-xs text-ink-subtle">Loading review run…</p>;
  }
  if (state.kind === "error") {
    return <p className="text-xs text-danger">{state.message}</p>;
  }
  const { run } = state;
  if (run.results.length === 0 && run.findings.length === 0) {
    return (
      <div className="space-y-2">
        <RunSummary run={run} />
        <p className="text-xs text-ink-subtle">
          This playbook has no rules; nothing to evaluate.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <RunSummary run={run} />
      <RuleResultList
        contractId={contractId}
        run={run}
        selectedKey={selectedKey}
        onSelect={onSelect}
        onUpdateFinding={onUpdateFinding}
      />
    </div>
  );
}

function RunSummary({ run }: { run: ReviewRunDetail }) {
  return (
    <div className="rounded border border-rule bg-canvas-subtle px-3 py-2">
      <p className="text-xs font-medium text-ink">{run.playbook_name}</p>
      <p className="mt-0.5 text-[11px] text-ink-subtle">
        Run {formatRunDate(run.created_at)}
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
        <span className="rounded-full border border-success-ring bg-success-soft px-2 py-0.5 text-success">
          {run.passed_count} passed
        </span>
        <span className="rounded-full border border-danger-ring bg-danger-soft px-2 py-0.5 text-danger">
          {run.failed_count} failed
        </span>
        <span className="rounded-full border border-rule bg-canvas px-2 py-0.5 text-ink-muted">
          {run.rules_checked} rule{run.rules_checked === 1 ? "" : "s"} checked
        </span>
      </div>
    </div>
  );
}

interface RuleResultListProps {
  contractId: string;
  run: ReviewRunDetail;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onUpdateFinding: (
    findingId: string,
    status: ReviewerFindingStatus,
  ) => void;
}

interface RowModel {
  rule: PlaybookRuleMatchResult;
  finding: DeviationFinding | null;
}

function RuleResultList({
  contractId,
  run,
  selectedKey,
  onSelect,
  onUpdateFinding,
}: RuleResultListProps) {
  const rows = useMemo<RowModel[]>(() => {
    const findingByRule = new Map<string, DeviationFinding>();
    for (const f of run.findings) {
      findingByRule.set(f.rule_id, f);
    }
    // Prefer the recomputed per-rule list if present; otherwise fall
    // back to one row per persisted finding (run history when the
    // Repository record has been re-segmented since the run, etc.).
    if (run.results.length > 0) {
      return run.results.map((rule) => ({
        rule,
        finding: findingByRule.get(rule.rule_id) ?? null,
      }));
    }
    return run.findings.map((f) => ({
      rule: findingToRuleResult(f),
      finding: f,
    }));
  }, [run.findings, run.results]);

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      // Failures first; within each group, by severity then title.
      if (a.rule.status !== b.rule.status) {
        return a.rule.status === "fail" ? -1 : 1;
      }
      const sa = SEVERITY_RANK[a.rule.severity] ?? 99;
      const sb = SEVERITY_RANK[b.rule.severity] ?? 99;
      if (sa !== sb) return sa - sb;
      return a.rule.title.localeCompare(b.rule.title);
    });
  }, [rows]);

  return (
    <ul className="divide-y divide-rule">
      {sorted.map(({ rule, finding }) => {
        const key = `review:${rule.rule_id}`;
        const hasEvidence =
          typeof rule.span_start === "number" &&
          typeof rule.span_end === "number";
        const isSelected = key === selectedKey;
        return (
          <li key={rule.rule_id} className="py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <StatusPill status={rule.status} />
                  <SeverityBadge severity={rule.severity} />
                  {finding && (
                    <FindingStatusBadge status={finding.finding_status} />
                  )}
                </div>
                <h3 className="mt-1.5 text-sm font-medium text-ink">
                  {rule.title}
                </h3>
                <p className="mt-0.5 font-mono text-[11px] text-ink-subtle">
                  {RULE_TYPE_LABELS[rule.rule_type] ?? rule.rule_type} ·{" "}
                  {rule.clause_type}
                </p>
              </div>
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">{rule.message}</p>
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
                {rule.clause_heading && (
                  <div className="mb-0.5 font-medium text-ink">
                    {rule.clause_heading}
                  </div>
                )}
                <div className="line-clamp-3 text-ink-muted">
                  {rule.evidence_text ?? "Citation available"}
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
            <PlaybookGuidance rule={rule} />
            {finding && (
              <>
                <FindingRemediationCard
                  contractId={contractId}
                  finding={finding}
                />
                <FindingStatusControls
                  finding={finding}
                  onUpdate={onUpdateFinding}
                />
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface PlaybookGuidanceProps {
  rule: PlaybookRuleMatchResult;
}

/**
 * Compact firm-authored guidance block.
 *
 * Surfaces the rule-level fields the playbook author wrote — guidance,
 * preferred_language, expected_value, matched_terms — so a failed
 * finding tells the reviewer not just *that* a clause failed but also
 * what the firm wants in its place. The fields are sourced verbatim
 * from the YAML rule (or from the persisted finding row, which copies
 * them at write time); nothing is generated.
 *
 * Rendered as visually secondary to the title/message/evidence: muted
 * surface, smaller type, left rule. Hidden entirely when none of the
 * four fields is set, so passes and rules without guidance don't grow
 * an empty section.
 */
function PlaybookGuidance({ rule }: PlaybookGuidanceProps) {
  const hasGuidance = Boolean(rule.guidance);
  const hasPreferredLanguage = Boolean(rule.preferred_language);
  const hasExpectedValue = rule.expected_value !== null;
  const hasMatchedTerms = rule.matched_terms.length > 0;
  if (
    !hasGuidance &&
    !hasPreferredLanguage &&
    !hasExpectedValue &&
    !hasMatchedTerms
  ) {
    return null;
  }
  return (
    <section
      aria-label="Playbook guidance"
      className="mt-2 rounded border-l-2 border-rule bg-canvas-subtle px-2.5 py-2"
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-ink-subtle">
        Playbook guidance
      </p>
      {hasGuidance && (
        <p className="mt-1 text-[11px] text-ink-muted">{rule.guidance}</p>
      )}
      {hasPreferredLanguage && (
        <div className="mt-1.5">
          <p className="text-[10px] uppercase tracking-wide text-ink-subtle">
            Preferred language
          </p>
          <pre className="mt-0.5 whitespace-pre-wrap rounded border border-rule bg-canvas px-2 py-1.5 font-sans text-[11px] leading-relaxed text-ink-muted">
            {rule.preferred_language}
          </pre>
        </div>
      )}
      {hasExpectedValue && (
        <p className="mt-1.5 text-[11px] text-ink-subtle">
          Expected value:{" "}
          <span className="font-mono text-ink-muted">
            {rule.expected_value}
          </span>
        </p>
      )}
      {hasMatchedTerms && (
        <p className="mt-1 text-[11px] text-ink-subtle">
          Matched terms:{" "}
          <span className="font-mono text-ink-muted">
            {rule.matched_terms.join(", ")}
          </span>
        </p>
      )}
    </section>
  );
}

interface FindingStatusControlsProps {
  finding: DeviationFinding;
  onUpdate: (findingId: string, status: ReviewerFindingStatus) => void;
}

function FindingStatusControls({
  finding,
  onUpdate,
}: FindingStatusControlsProps) {
  const buttons: Array<{
    key: ReviewerFindingStatus;
    label: string;
    visibleWhen: ReadonlyArray<DeviationFinding["finding_status"]>;
  }> = [
    {
      key: "reviewed",
      label: "Mark reviewed",
      visibleWhen: ["open", "ignored", "superseded"],
    },
    {
      key: "ignored",
      label: "Mark ignored",
      visibleWhen: ["open", "reviewed", "superseded"],
    },
    {
      key: "open",
      label: "Reopen",
      visibleWhen: ["reviewed", "ignored", "superseded"],
    },
  ];
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {buttons
        .filter((b) => b.visibleWhen.includes(finding.finding_status))
        .map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => onUpdate(finding.id, b.key)}
            className="inline-flex items-center rounded border border-rule bg-canvas-subtle px-2 py-0.5 text-[11px] text-ink-muted transition-colors hover:bg-canvas-muted"
          >
            {b.label}
          </button>
        ))}
    </div>
  );
}

function StatusPill({ status }: { status: "pass" | "fail" }) {
  return (
    <Pill
      tone={status === "pass" ? "success" : "danger"}
      variant="soft"
      className="uppercase tracking-wide"
    >
      {status === "pass" ? "Pass" : "Fail"}
    </Pill>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  if (
    severity === "blocker" ||
    severity === "high" ||
    severity === "medium" ||
    severity === "low"
  ) {
    return <SeverityTag level={severity as Severity}>{severity}</SeverityTag>;
  }
  return (
    <Pill tone="neutral" variant="soft" className="uppercase tracking-wide">
      {severity}
    </Pill>
  );
}

function FindingStatusBadge({
  status,
}: {
  status: DeviationFinding["finding_status"];
}) {
  const tone =
    status === "reviewed"
      ? "success"
      : status === "ignored" || status === "superseded"
        ? "neutral"
        : "warning";
  return (
    <Pill tone={tone} variant="soft" className="uppercase tracking-wide">
      {FINDING_STATUS_LABELS[status] ?? status}
    </Pill>
  );
}

function formatRunDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Construct a `PlaybookRuleMatchResult` from a persisted finding.
 *
 * Only used as a fallback when a run's per-rule recomputation isn't
 * available (e.g. the playbook was deactivated between runs and
 * revalidation failed). The resulting row carries `status: "fail"`
 * since persisted findings are failures.
 */
function findingToRuleResult(
  f: DeviationFinding,
): PlaybookRuleMatchResult {
  return {
    rule_id: f.rule_id,
    title: f.rule_title,
    rule_type: f.rule_type,
    clause_type: f.clause_type,
    severity: f.severity,
    status: "fail",
    message: f.message,
    clause_id: f.clause_id,
    clause_ordinal: null,
    clause_heading: null,
    evidence_text: f.evidence_text,
    span_start: f.span_start,
    span_end: f.span_end,
    matched_terms: [...f.matched_terms],
    expected_value: f.expected_value,
    description: null,
    guidance: f.guidance,
    preferred_language: f.preferred_language,
  };
}
