import { useEffect, useState } from "react";
import type { ComponentType, ReactNode } from "react";
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
  Icon: ComponentType<{ className?: string }>;
}

const CARDS: ApprovalsCard[] = [
  {
    to: demoPath("/approvals/tasks"),
    title: "Approval tasks",
    description:
      "Open approval steps assigned to you. Triage what's waiting on a decision today.",
    testId: "approvals-card-tasks",
    countKey: "pending_approval_steps",
    Icon: TasksIcon,
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
    Icon: WorkflowIcon,
  },
  {
    to: demoPath("/approvals/templates"),
    title: "Approval templates",
    description:
      "Reusable approval step lists. Build a blueprint once and instantiate it for any request or contract.",
    testId: "approvals-card-templates",
    countKey: "active_approval_workflow_templates",
    Icon: TemplateIcon,
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
    Icon: PolicyIcon,
  },
];

type CountsState =
  | { kind: "loading" }
  | { kind: "loaded"; counts: DashboardCounts }
  | { kind: "error" };

function BaseIcon({ className, children }: { className?: string; children: ReactNode }) {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden>{children}</svg>;
}
function TasksIcon({ className }: { className?: string }) { return <BaseIcon className={className}><rect x="4" y="3" width="12" height="14" rx="1.5" /><path d="M7 7h6M7 10h6M7 13h4" /></BaseIcon>; }
function WorkflowIcon({ className }: { className?: string }) { return <BaseIcon className={className}><circle cx="5" cy="5" r="2" /><circle cx="15" cy="10" r="2" /><circle cx="5" cy="15" r="2" /><path d="M7 5h4M13.2 8.8l-2.4-2.4M7 15h4M13.2 11.2l-2.4 2.4" /></BaseIcon>; }
function TemplateIcon({ className }: { className?: string }) { return <BaseIcon className={className}><path d="M5 3h10v14H5z" /><path d="M8 7h4M8 10h4M8 13h3" /></BaseIcon>; }
function PolicyIcon({ className }: { className?: string }) { return <BaseIcon className={className}><path d="M10 3l6 2v5c0 3.5-2.2 5.8-6 7-3.8-1.2-6-3.5-6-7V5z" /><path d="M7.5 10.5l1.7 1.7 3.3-3.3" /></BaseIcon>; }

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
    <div data-testid="approvals-landing">
      <div className="grid gap-3 sm:grid-cols-2">
        {CARDS.map((card) => {
          const Icon = card.Icon;
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
                <p className="inline-flex items-center gap-2 text-sm font-medium text-ink group-hover:text-ink">
                  <Icon className="h-4 w-4" aria-hidden />
                  <span>{card.title}</span>
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
