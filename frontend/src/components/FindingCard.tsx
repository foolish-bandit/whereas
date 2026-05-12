import { useState } from "react";

import Pill, { type PillTone } from "./ui/Pill";
import SeverityTag from "./ui/SeverityTag";
import type {
  FindingStatus,
  PlaybookFinding,
} from "../types/demoExtras";

const STATUS_TONE: Record<FindingStatus, PillTone> = {
  open: "warning",
  accepted: "success",
  waived: "neutral",
  mitigated: "info",
};

const STATUS_LABEL: Record<FindingStatus, string> = {
  open: "Open",
  accepted: "Accepted",
  waived: "Waived",
  mitigated: "Mitigated",
};

export interface FindingCardProps {
  finding: PlaybookFinding;
  onChangeStatus: (id: string, next: FindingStatus, waiverReason?: string) => void;
  onJumpToCitation: (finding: PlaybookFinding) => void;
}

export default function FindingCard({
  finding,
  onChangeStatus,
  onJumpToCitation,
}: FindingCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [waiveReason, setWaiveReason] = useState("");

  function commitWaive() {
    if (waiveReason.trim().length === 0) return;
    onChangeStatus(finding.id, "waived", waiveReason.trim());
    setWaiveOpen(false);
    setWaiveReason("");
  }

  return (
    <article
      className="rounded-lg border border-rule bg-canvas"
      data-testid={`finding-card-${finding.id}`}
      data-severity={finding.severity}
      data-status={finding.status}
    >
      <button
        type="button"
        onClick={() => {
          setExpanded((v) => !v);
          onJumpToCitation(finding);
        }}
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-canvas-subtle"
        aria-expanded={expanded}
        data-testid={`finding-card-toggle-${finding.id}`}
      >
        <SeverityTag level={finding.severity} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{finding.rule_label}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">
            {finding.finding_text}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill
            tone={STATUS_TONE[finding.status]}
            variant="soft"
            data-testid={`finding-card-status-${finding.id}`}
          >
            {STATUS_LABEL[finding.status]}
          </Pill>
          <span aria-hidden className="text-ink-subtle">
            {expanded ? "▾" : "▸"}
          </span>
        </div>
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-rule px-3 py-3 text-sm">
          <p className="text-sm text-ink-muted">{finding.finding_text}</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="border-l-2 border-rule bg-canvas-subtle p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
                Playbook standard position
              </p>
              <p className="mt-1 text-sm text-ink">{finding.standard_position}</p>
            </div>
            <div className="border-l-2 border-warning bg-warning-soft/40 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-warning">
                Suggested redline
              </p>
              <p className="mt-1 font-serif text-sm text-ink">
                {finding.suggested_redline}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onJumpToCitation(finding);
              }}
              className="inline-flex items-center gap-1 rounded border border-rule px-2 py-0.5 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
              data-testid={`finding-card-jump-${finding.id}`}
            >
              <span aria-hidden>↗</span> jump to source
            </button>
          </div>
          <div
            className="flex flex-wrap items-center gap-2 border-t border-rule pt-3"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => onChangeStatus(finding.id, "accepted")}
              disabled={finding.status === "accepted"}
              className="rounded border border-ink bg-ink px-2.5 py-1 text-xs font-medium text-canvas hover:bg-accent-ring disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`finding-card-accept-${finding.id}`}
            >
              Accept finding
            </button>
            {waiveOpen ? (
              <div className="flex flex-1 min-w-[16rem] flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={waiveReason}
                  onChange={(e) => setWaiveReason(e.target.value)}
                  placeholder="Waiver justification (required)…"
                  className="min-w-[10rem] flex-1 rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink focus:border-accent-ring focus:outline-none"
                  data-testid={`finding-card-waive-input-${finding.id}`}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={commitWaive}
                  disabled={waiveReason.trim().length === 0}
                  className="rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink hover:border-rule-strong disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid={`finding-card-waive-commit-${finding.id}`}
                >
                  Save waiver
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWaiveOpen(false);
                    setWaiveReason("");
                  }}
                  className="text-xs text-ink-muted underline hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setWaiveOpen(true)}
                disabled={finding.status === "waived"}
                className="rounded border border-rule bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:border-rule-strong disabled:cursor-not-allowed disabled:opacity-50"
                data-testid={`finding-card-waive-${finding.id}`}
              >
                Waive
              </button>
            )}
            <button
              type="button"
              onClick={() => onChangeStatus(finding.id, "mitigated")}
              disabled={finding.status === "mitigated"}
              className="text-xs text-ink-muted underline hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`finding-card-mitigate-${finding.id}`}
            >
              Mark mitigated
            </button>
            {finding.status !== "open" && (
              <button
                type="button"
                onClick={() => onChangeStatus(finding.id, "open")}
                className="ml-auto text-xs text-ink-muted underline hover:text-ink"
                data-testid={`finding-card-reopen-${finding.id}`}
              >
                Reopen
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
