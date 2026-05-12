import { useEffect, useState } from "react";

import {
  ApiError,
  MissingDevUserError,
  getContractActivity,
  getRequestActivity,
} from "../lib/api";
import type {
  ActivityEventType,
  ActivityTimelineItem,
} from "../types/activity";

type Props =
  | { kind: "request"; requestId: string }
  | { kind: "contract"; contractId: string };

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; items: ActivityTimelineItem[] }
  | { kind: "error"; message: string };

/**
 * Compact, lazy-loaded chronological activity feed for a request or
 * contract. Server-rendered titles + optional descriptions; this
 * component just lays them out and stamps a relative timestamp.
 *
 * The timeline is **explainability only**: it renders the audit log as
 * the user sees it, never derives state, never mutates anything.
 */
export default function ActivityTimeline(props: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let aborted = false;
    setState({ kind: "loading" });
    const fetcher =
      props.kind === "request"
        ? getRequestActivity(props.requestId)
        : getContractActivity(props.contractId);
    fetcher
      .then((res) => {
        if (!aborted) setState({ kind: "loaded", items: res.items });
      })
      .catch((err) => {
        if (aborted) return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
        } else {
          setState({
            kind: "error",
            message: "Could not load activity timeline.",
          });
        }
      });
    return () => {
      aborted = true;
    };
    // The two ID variants are mutually exclusive; depending on whichever
    // one is set is enough to refetch when the parent swaps targets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.kind, props.kind === "request" ? props.requestId : props.contractId]);

  if (state.kind === "loading") {
    return (
      <p
        className="mt-3 text-xs text-ink-subtle"
        data-testid="activity-timeline-loading"
      >
        Loading activity…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p
        className="mt-3 text-xs text-danger"
        data-testid="activity-timeline-error"
      >
        {state.message}
      </p>
    );
  }
  if (state.items.length === 0) {
    return (
      <p
        className="mt-3 text-xs text-ink-subtle"
        data-testid="activity-timeline-empty"
      >
        No activity recorded yet. Approval decisions, signature events, and
        other workflow milestones will appear here as they happen.
      </p>
    );
  }

  return (
    <ol
      className="mt-3 space-y-2 border-l border-rule pl-4 text-xs"
      data-testid="activity-timeline"
    >
      {state.items.map((item) => (
        <li
          key={item.id}
          className="relative"
          data-testid="activity-timeline-item"
        >
          <span
            className={`absolute -left-[1.05rem] top-1 inline-block h-2 w-2 rounded-full ${badgeDot(item.event_type)}`}
            aria-hidden
          />
          <p className="font-medium text-ink" data-testid="activity-timeline-title">
            {item.title}
          </p>
          <p className="text-ink-subtle">
            <span data-testid="activity-timeline-when">
              {formatTimestamp(item.occurred_at)}
            </span>
            {item.description ? (
              <>
                {" · "}
                <span data-testid="activity-timeline-description">
                  {item.description}
                </span>
              </>
            ) : null}
          </p>
        </li>
      ))}
    </ol>
  );
}

/**
 * Tailwind class for the leading dot, picked by event category. Pure
 * cosmetic — the title already names the event.
 */
function badgeDot(event_type: ActivityEventType): string {
  if (
    event_type === "approval.workflow.completed" ||
    event_type === "approval.step.approved" ||
    event_type === "contract.executed"
  ) {
    return "bg-success";
  }
  if (
    event_type === "approval.workflow.rejected" ||
    event_type === "approval.step.rejected"
  ) {
    return "bg-danger";
  }
  if (event_type === "approval.workflow.cancelled") {
    return "bg-ink-subtle";
  }
  if (event_type === "contract.sent_for_signature") {
    return "bg-info";
  }
  return "bg-warning";
}

function formatTimestamp(iso: string): string {
  // Display-only formatter. Browsers render the user's locale; the
  // backend is the source of truth on `occurred_at`.
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
