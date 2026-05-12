import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useState } from "react";

import FindingCard from "./FindingCard";
import SeverityTag from "./ui/SeverityTag";
import type {
  FindingSeverity,
  FindingStatus,
  PlaybookFinding,
} from "../types/demoExtras";

interface ReviewTabProps {
  contractId: string;
  findings: PlaybookFinding[];
  /** Wired to the same selectedKey machinery the document pane listens
   * to, so clicking a finding scrolls the viewer to its citation. */
  onJumpToSource: (key: string, span: { start: number; end: number }) => void;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const STATUS_RANK: Record<FindingStatus, number> = {
  open: 0,
  mitigated: 1,
  accepted: 2,
  waived: 3,
};

interface StatusOverride {
  status: FindingStatus;
  waiver_reason?: string;
  updated_at: string;
}

const LS_PREFIX = "whereas:demo:findings:";

function storageKey(contractId: string): string {
  return `${LS_PREFIX}${contractId}`;
}

function loadOverrides(contractId: string): Record<string, StatusOverride> {
  try {
    const raw = window.localStorage.getItem(storageKey(contractId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}

function persistOverrides(
  contractId: string,
  overrides: Record<string, StatusOverride>,
) {
  try {
    window.localStorage.setItem(
      storageKey(contractId),
      JSON.stringify(overrides),
    );
  } catch {
    // Swallow — quota / private mode failures should not break the UI.
  }
}

export default function ReviewTab({
  contractId,
  findings,
  onJumpToSource,
}: ReviewTabProps) {
  const [overrides, setOverrides] = useState<Record<string, StatusOverride>>(
    () => loadOverrides(contractId),
  );

  useEffect(() => {
    setOverrides(loadOverrides(contractId));
  }, [contractId]);

  const onChangeStatus = useCallback(
    (id: string, next: FindingStatus, waiverReason?: string) => {
      setOverrides((prev) => {
        const updated: Record<string, StatusOverride> = { ...prev };
        if (next === "open") {
          delete updated[id];
        } else {
          updated[id] = {
            status: next,
            waiver_reason: waiverReason,
            updated_at: new Date().toISOString(),
          };
        }
        persistOverrides(contractId, updated);
        return updated;
      });
    },
    [contractId],
  );

  const merged: PlaybookFinding[] = useMemo(() => {
    return findings.map((f) => {
      const override = overrides[f.id];
      if (!override) return f;
      return { ...f, status: override.status };
    });
  }, [findings, overrides]);

  // Severity counts only count *open* findings — accepted, waived, and
  // mitigated drop out of the headline counters per the brief.
  const openCounts: Record<FindingSeverity, number> = {
    blocker: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  let resolved = 0;
  for (const f of merged) {
    if (f.status === "open") openCounts[f.severity] += 1;
    else resolved += 1;
  }

  const sorted = useMemo(() => {
    const copy = [...merged];
    copy.sort((a, b) => {
      const sA = STATUS_RANK[a.status];
      const sB = STATUS_RANK[b.status];
      if (sA !== sB) return sA - sB;
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    });
    return copy;
  }, [merged]);

  if (findings.length === 0) {
    return (
      <div
        className="rounded-lg border border-rule bg-canvas p-5 text-sm text-ink-muted"
        data-testid="review-tab-empty"
      >
        No deviations found against the active playbook. View or edit
        the active playbook in{" "}
        <Link
          to="/demo/playbooks"
          className="text-ink underline hover:text-accent-ring"
        >
          Playbooks
        </Link>
        .
      </div>
    );
  }

  return (
    <section data-testid="review-tab">
      <div
        className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-canvas-subtle px-3 py-2"
        data-testid="review-tab-summary"
      >
        {(["blocker", "high", "medium", "low"] as const).map((level) => (
          <SeverityTag
            key={level}
            level={level}
            className={openCounts[level] === 0 ? "opacity-40" : undefined}
            data-testid={`review-tab-summary-${level}`}
          >
            {openCounts[level]} {level.toUpperCase()}
          </SeverityTag>
        ))}
        <span
          className="ml-auto text-xs text-ink-subtle"
          data-testid="review-tab-summary-resolved"
        >
          ✓ {resolved} resolved
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {sorted.map((f) => (
          <li key={f.id}>
            <FindingCard
              finding={f}
              onChangeStatus={onChangeStatus}
              onJumpToCitation={(finding) =>
                onJumpToSource(`finding:${finding.id}`, {
                  start: finding.citation.text_preview_start,
                  end: finding.citation.text_preview_end,
                })
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
