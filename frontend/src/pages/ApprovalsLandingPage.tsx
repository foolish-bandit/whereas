import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  ApiError,
  MissingDevUserError,
  getDashboardSummary,
} from "../lib/api";
import { demoPath } from "../lib/routes";
import type { DashboardCounts } from "../types/dashboard";

interface ApprovalsCard {
  to: string;
  title: string;
  description: string;
  testId: string;
  /** Look up the headline count for this card. */
  countKey: keyof DashboardCounts | null;
  /** Optional secondary line (e.g. overdue subset). */
  secondary?: (counts: DashboardCounts) => string | null;
}

const CARDS: ApprovalsCard[] = [
  {
    to: demoPath("/approvals/tasks"),
    title: "Approval tasks",
    description:
      "Open approval steps assigned to you. Triage what's waiting on a decision today.",
    testId: "approvals-card-tasks",
    countKey: "pending_approval_steps",
    secondary: (counts) =>
      counts.overdue_approval_steps > 0
        ? `${counts.overdue_approval_steps} overdue`
        : null,
  },
  {
    to: demoPath("/approvals/workflows"),
    title: "Approval workflows",
    description:
      "Active approval processes attached to requests and contracts. View progress and resolve in-flight workflows.",
    testId: "approvals-card-workflows",
    countKey: "active_approval_workflows",
  },
  {
    to: demoPath("/approvals/templates"),
    title: "Approval templates",
    description:
      "Reusable approval step lists. Build a blueprint once and instantiate it for any request or contract.",
    testId: "approvals-card-templates",
    countKey: "active_approval_workflow_templates",
  },
  {
    to: demoPath("/approvals/policies"),
    title: "Approval policies",
    description:
      "Rules that attach approval workflows to matching requests automatically.",
    testId: "approvals-card-policies",
    // Dashboard summary doesn't surface an active-policies count yet,
    // so the card runs without a headline number rather than adding a
    // new analytics endpoint just for the landing page.
    countKey: null,
  },
];

type CountsState =
  | { kind: "loading" }
  | { kind: "loaded"; counts: DashboardCounts }
  | { kind: "error" };

export default function ApprovalsLandingPage() {
  const [state, setState] = useState<CountsState>({ kind: "loading" });

  useEffect(() => {
    let aborted = false;
    getDashboardSummary()
      .then((summary) => {
        if (aborted) return;
        // Treat any unexpected shape as "no counts" rather than letting
        // the landing page crash. The cards still render and remain
        // navigable.
        if (summary && summary.counts) {
          setState({ kind: "loaded", counts: summary.counts });
        } else {
          setState({ kind: "error" });
        }
      })
      .catch((err) => {
        if (aborted) return;
        // We don't surface the error inline — counts are a nice-to-have
        // on the landing page and should never block navigation. Log
        // for dev visibility only.
        if (!(err instanceof MissingDevUserError) && !(err instanceof ApiError)) {
          // eslint-disable-next-line no-console
          console.warn("ApprovalsLandingPage: dashboard summary failed", err);
        }
        setState({ kind: "error" });
      });
    return () => {
      aborted = true;
    };
  }, []);

  return (
    <div className="space-y-6" data-testid="approvals-landing">
      <div>
        <h1 className="text-lg font-semibold text-ink">Approvals</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          One place to manage the approval surface of CLM — what's waiting on
          you, what's in flight, the templates you reuse, and the policies that
          attach approvals to incoming requests.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {CARDS.map((card) => {
          const count =
            state.kind === "loaded" && card.countKey
              ? state.counts[card.countKey]
              : null;
          const secondary =
            state.kind === "loaded" && card.secondary
              ? card.secondary(state.counts)
              : null;
          return (
            <Link
              key={card.to}
              to={card.to}
              data-testid={card.testId}
              className="group rounded border border-rule bg-canvas p-4 transition-colors hover:border-rule-strong hover:bg-canvas-subtle"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium text-ink group-hover:text-ink">
                  {card.title}
                </p>
                {count !== null && (
                  <span
                    className="text-base font-semibold text-ink tabular-nums"
                    data-testid={`${card.testId}-count`}
                  >
                    {count}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-ink-muted">{card.description}</p>
              {secondary && (
                <p
                  className="mt-1 text-xs font-medium text-danger"
                  data-testid={`${card.testId}-secondary`}
                >
                  {secondary}
                </p>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
