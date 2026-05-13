import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import KpiTile from "../components/dashboard/KpiTile";
import PageHeader from "../components/ui/PageHeader";
import WorkspaceCard from "../components/ui/WorkspaceCard";
import {
  ApiError,
  MissingDevUserError,
  getDashboardSummary,
} from "../lib/api";
import { demoPath } from "../lib/routes";
import type {
  DashboardApprovalAnalytics,
  DashboardApprovalAssigneeBucket,
  DashboardContractSummary,
  DashboardCounts,
  DashboardInboxSummary,
  DashboardOldestPendingStep,
  DashboardRequestSummary,
  DashboardSummary,
} from "../types/dashboard";

/**
 * PR #124 — friendly labels for contract-type slugs used in the
 * Agreement-mix rollup. The backend returns `contract_type` as a free
 * string on `DashboardRequestSummary`; tests use friendly labels
 * (NDA / MSA) and live data tends to use slugs (mutual_nda /
 * vendor_agreement). Normalize so both render as the same bucket.
 */
const CONTRACT_TYPE_LABELS: Record<string, string> = {
  mutual_nda: "NDA",
  unilateral_nda: "NDA",
  nda: "NDA",
  msa: "MSA",
  vendor_agreement: "Vendor agreement",
  customer_contract: "Customer contract",
  employment_agreement: "Employment agreement",
  dpa: "DPA",
  lease: "Lease",
};

function contractTypeLabel(raw: string | null | undefined): string {
  if (!raw) return "Unspecified";
  const lower = raw.toLowerCase();
  return CONTRACT_TYPE_LABELS[lower] ?? raw;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; summary: DashboardSummary }
  | { kind: "error"; message: string };

interface CountTile {
  key: keyof DashboardCounts;
  label: string;
  hint: string;
  to: string;
  tone?: "default" | "danger";
  /** Demo-only trend hint surfaced via TrendIndicator. Real
   * deployments need a time-series query — see Prompt 12. */
  demoTrend?: { pct: number; invert?: boolean };
}

const PIPELINE_TILES: CountTile[] = [
  {
    key: "open_requests",
    label: "Open requests",
    hint: "Status open",
    to: demoPath("/requests"),
    demoTrend: { pct: 12 },
  },
  {
    key: "in_progress_requests",
    label: "In progress",
    hint: "Status in_progress",
    to: demoPath("/requests"),
  },
  {
    key: "urgent_or_high_priority_requests",
    label: "Urgent / high priority",
    hint: "Open or in-progress, priority urgent or high",
    to: demoPath("/requests"),
  },
];

const REPOSITORY_TILES: CountTile[] = [
  {
    key: "contracts_total",
    label: "Repository total",
    hint: "Every contract in this org",
    to: demoPath("/repository"),
  },
  {
    key: "contracts_sent_for_signature",
    label: "Out for signature",
    hint: "Status sent_for_signature",
    to: demoPath("/repository"),
  },
  {
    key: "contracts_executed",
    label: "Executed contracts",
    hint: "Status executed",
    to: demoPath("/repository"),
    demoTrend: { pct: 8 },
  },
];

const APPROVAL_COUNT_TILES: CountTile[] = [
  {
    key: "pending_approval_steps",
    label: "Pending approvals",
    hint: "Steps awaiting a decision on active workflows",
    to: demoPath("/approvals/tasks"),
  },
  {
    key: "overdue_approval_steps",
    label: "Overdue approvals",
    hint: "Pending steps past their due date",
    to: demoPath("/approvals/tasks"),
    tone: "danger",
    demoTrend: { pct: -3, invert: true },
  },
  {
    key: "active_approval_workflows",
    label: "Active workflows",
    hint: "Workflows still moving through their steps",
    to: demoPath("/approvals/workflows"),
  },
  {
    key: "active_approval_workflow_templates",
    label: "Approval templates",
    hint: "Active approval workflow blueprints",
    to: demoPath("/approvals/templates"),
  },
];

const INBOX_AND_TEMPLATE_TILES: CountTile[] = [
  {
    key: "open_inbox_items",
    label: "Open inbox items",
    hint: "Status open",
    to: demoPath("/inbox"),
  },
  {
    key: "overdue_inbox_items",
    label: "Overdue inbox items",
    hint: "Status open and past due",
    to: demoPath("/inbox"),
    tone: "danger",
  },
  {
    key: "templates_active",
    label: "Active templates",
    hint: "Status active",
    to: demoPath("/requests/templates"),
  },
];

export default function DashboardPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    getDashboardSummary({ signal: controller.signal })
      .then((summary) => setState({ kind: "loaded", summary }))
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
        } else {
          setState({ kind: "error", message: "Could not load dashboard." });
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="space-y-6" data-testid="dashboard-page">
      <PageHeader
        title="Dashboard"
        description="Your MVP workspace summary: what needs attention now, what is moving through Requests, Repository, Inbox, and Approvals, and what changed recently. Metrics are operational signals only and should be reviewed by your team."
      />

      {state.kind === "loading" && (
        <div data-testid="dashboard-loading">
          <LoadingSkeleton rows={6} />
        </div>
      )}

      {state.kind === "error" && (
        <p className="text-sm text-danger" data-testid="dashboard-error">
          {state.message}
        </p>
      )}

      {state.kind === "loaded" && (
        <DashboardContent summary={state.summary} />
      )}
    </div>
  );
}

function DashboardContent({ summary }: { summary: DashboardSummary }) {
  return (
    <>
      <AttentionNeeded counts={summary.counts} />

      <QuickActions />

      <section data-testid="dashboard-counts" className="space-y-5">
        <CountGroup
          heading="Request pipeline"
          tiles={PIPELINE_TILES}
          counts={summary.counts}
        />
        <CountGroup
          heading="Repository"
          tiles={REPOSITORY_TILES}
          counts={summary.counts}
        />
        <CountGroup
          heading="Approvals"
          tiles={APPROVAL_COUNT_TILES}
          counts={summary.counts}
        />
        <CountGroup
          heading="Inbox & templates"
          tiles={INBOX_AND_TEMPLATE_TILES}
          counts={summary.counts}
        />
      </section>

      <AgreementMix
        requests={[
          ...summary.upcoming.requests_due_soon,
          ...summary.recent_activity.recent_requests,
        ]}
      />

      <section
        className="grid gap-4 lg:grid-cols-2"
        data-testid="dashboard-upcoming"
      >
        <UpcomingRequests rows={summary.upcoming.requests_due_soon} />
        <UpcomingInboxItems rows={summary.upcoming.inbox_items_due_soon} />
      </section>

      <section
        className="grid gap-4 lg:grid-cols-2"
        data-testid="dashboard-recent"
      >
        <RecentContracts
          title="Recent contracts"
          testId="recent-contracts"
          rows={summary.recent_activity.recent_contracts}
          emptyHint="No contracts yet. Upload one or generate from a template."
        />
        <RecentRequests rows={summary.recent_activity.recent_requests} />
        <RecentContracts
          title="Recently signed contracts"
          testId="recent-signed-contracts"
          rows={summary.recent_activity.recent_signed_contracts}
          emptyHint="No executed contracts yet."
        />
      </section>

      <ApprovalAnalyticsSection analytics={summary.approval_analytics} />
    </>
  );
}

/* -------------------------------------------------------------------- */
/* PR #124 — contract-ops command-center polish.                        */
/*                                                                      */
/*   • AttentionNeeded wraps the existing overdue ActionBanner with     */
/*     an always-on "what needs attention" rollup (urgent requests,     */
/*     overdue inbox, overdue approvals). When nothing is hot, we      */
/*     render an honest "all clear" state instead of leaving the       */
/*     viewer wondering whether the dashboard is broken.                */
/*   • QuickActions surfaces the six top-of-mind navigation targets    */
/*     so users don't have to discover them in the sidebar.             */
/*   • AgreementMix tallies the contract-type field on request         */
/*     summaries we already fetch. Honest empty state when neither     */
/*     upcoming nor recent requests carry a contract_type.             */
/* -------------------------------------------------------------------- */

function AttentionNeeded({ counts }: { counts: DashboardCounts }) {
  const urgent = counts.urgent_or_high_priority_requests;
  const overdueApprovals = counts.overdue_approval_steps;
  const overdueInbox = counts.overdue_inbox_items;
  const totalHot = urgent + overdueApprovals + overdueInbox;
  return (
    <section
      data-testid="dashboard-attention"
      className="space-y-2"
      aria-labelledby="dashboard-attention-heading"
    >
      <h2
        id="dashboard-attention-heading"
        className="text-sm font-medium text-ink"
      >
        Attention needed
      </h2>
      <ActionBanner counts={counts} />
      {totalHot === 0 && (
        <p
          className="rounded border border-rule bg-canvas-subtle p-3 text-sm text-ink-muted"
          data-testid="dashboard-attention-clear"
        >
          Nothing is overdue and no urgent requests are open. Pipeline
          counts and recent activity below.
        </p>
      )}
    </section>
  );
}

interface QuickAction {
  key: string;
  label: string;
  hint: string;
  to: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    key: "open-inbox",
    label: "Open Inbox",
    hint: "Triaging intake items, classifications, and reviews",
    to: demoPath("/inbox"),
  },
  {
    key: "start-request",
    label: "Start a Request",
    hint: "Kick off a new contract request",
    to: demoPath("/requests"),
  },
  {
    key: "view-approvals",
    label: "View Approval Tasks",
    hint: "Approve, reject, or hand off in-flight workflows",
    to: demoPath("/approvals/tasks"),
  },
  {
    key: "open-repository",
    label: "Open Repository",
    hint: "Search the executed contract record",
    to: demoPath("/repository"),
  },
  {
    key: "open-clause-manager",
    label: "Open Clause Manager",
    hint: "Approved clauses, fallback language, drafting guidance",
    to: demoPath("/clause-manager"),
  },
  {
    key: "open-playbooks",
    label: "Open Playbooks",
    hint: "Review standards, fallback positions, deviation rules",
    to: demoPath("/playbooks"),
  },
];

function QuickActions() {
  return (
    <section
      data-testid="dashboard-quick-actions"
      aria-labelledby="dashboard-quick-actions-heading"
      className="space-y-2"
    >
      <h2
        id="dashboard-quick-actions-heading"
        className="text-sm font-medium text-ink"
      >
        Quick actions
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {QUICK_ACTIONS.map((qa) => (
          <WorkspaceCard
            key={qa.key}
            to={qa.to}
            title={qa.label}
            description={qa.hint}
            testId={`quick-action-${qa.key}`}
            variant="primary"
          />
        ))}
      </div>
    </section>
  );
}

interface AgreementMixBucket {
  key: string;
  label: string;
  count: number;
}

function AgreementMix({ requests }: { requests: DashboardRequestSummary[] }) {
  const buckets = useMemo<AgreementMixBucket[]>(() => {
    const counts = new Map<string, number>();
    // Dedupe by request id so a row appearing in both upcoming and
    // recent doesn't double-count toward the mix.
    const seen = new Set<string>();
    for (const r of requests) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (!r.contract_type) continue;
      const key = r.contract_type.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([key, count]) => ({
        key,
        label: contractTypeLabel(key),
        count,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [requests]);

  return (
    <section
      data-testid="dashboard-agreement-mix"
      aria-labelledby="dashboard-agreement-mix-heading"
      className="space-y-2"
    >
      <h2
        id="dashboard-agreement-mix-heading"
        className="text-sm font-medium text-ink"
      >
        Agreement mix
      </h2>
      <p className="text-xs text-ink-subtle">
        Contract types across upcoming and recent requests in this
        workspace.
      </p>
      {buckets.length === 0 ? (
        <p
          className="rounded border border-rule bg-canvas-subtle p-3 text-sm text-ink-muted"
          data-testid="dashboard-agreement-mix-empty"
        >
          No contract-type tags on the currently visible requests.
        </p>
      ) : (
        <ul
          className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="dashboard-agreement-mix-list"
        >
          {buckets.map((b) => (
            <li
              key={b.key}
              className="rounded border border-rule p-3"
              data-testid="dashboard-agreement-mix-row"
              data-contract-type-key={b.key}
            >
              <p className="text-xs uppercase tracking-wide text-ink-subtle">
                {b.label}
              </p>
              <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">
                {b.count}
              </p>
              <p className="mt-1 text-xs text-ink-subtle">
                {b.count === 1 ? "request" : "requests"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActionBanner({ counts }: { counts: DashboardCounts }) {
  const overdueApprovals = counts.overdue_approval_steps;
  const overdueInbox = counts.overdue_inbox_items;
  if (overdueApprovals === 0 && overdueInbox === 0) return null;
  const parts: string[] = [];
  if (overdueApprovals > 0) {
    parts.push(
      `${overdueApprovals} overdue approval ${
        overdueApprovals === 1 ? "step" : "steps"
      }`,
    );
  }
  if (overdueInbox > 0) {
    parts.push(
      `${overdueInbox} overdue inbox ${
        overdueInbox === 1 ? "item" : "items"
      }`,
    );
  }
  // CTA prefers approvals when both are present; that's almost always the
  // higher-stakes surface.
  const ctaHref = overdueApprovals > 0 ? "/approvals/tasks" : "/inbox";
  const ctaLabel =
    overdueApprovals > 0 ? "Open approval tasks" : "Open inbox";
  return (
    <div
      className="flex flex-col gap-2 rounded border border-danger-ring bg-danger-soft p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      data-testid="dashboard-action-banner"
    >
      <p className="text-ink">
        <span className="font-medium text-danger">Needs attention:</span>{" "}
        {parts.join(" · ")}
      </p>
      <Link
        to={demoPath(ctaHref)}
        className="inline-flex w-fit items-center rounded border border-danger bg-danger px-2.5 py-1 text-xs font-medium text-canvas hover:opacity-90"
        data-testid="dashboard-action-cta"
      >
        {ctaLabel}
      </Link>
    </div>
  );
}

function CountGroup({
  heading,
  tiles,
  counts,
}: {
  heading: string;
  tiles: CountTile[];
  counts: DashboardCounts;
}) {
  return (
    <div>
      <h2 className="text-sm font-medium text-ink">{heading}</h2>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => {
          const value = counts[tile.key];
          const danger = tile.tone === "danger" && Number(value) > 0;
          return (
            <KpiTile
              key={tile.key}
              testId={`count-${tile.key}`}
              to={tile.to}
              label={tile.label}
              value={value}
              description={tile.hint}
              danger={danger}
              trend={tile.demoTrend ?? null}
            />
          );
        })}
      </div>
    </div>
  );
}

const APPROVAL_ANALYTICS_TILES: {
  key: keyof Omit<
    DashboardApprovalAnalytics,
    "pending_by_assignee" | "oldest_pending_steps"
  >;
  label: string;
  hint: string;
}[] = [
  {
    key: "pending_steps",
    label: "Pending approvals",
    hint: "Steps still awaiting a decision on active workflows",
  },
  {
    key: "overdue_steps",
    label: "Overdue approvals",
    hint: "Pending steps past their due date",
  },
  {
    key: "active_workflows",
    label: "Active workflows",
    hint: "Workflows still moving through their steps",
  },
  {
    key: "workflows_completed_last_30_days",
    label: "Completed (30d)",
    hint: "Workflows completed in the last 30 days",
  },
  {
    key: "workflows_rejected_last_30_days",
    label: "Rejected (30d)",
    hint: "Workflows rejected in the last 30 days",
  },
];

function ApprovalAnalyticsSection({
  analytics,
}: {
  analytics: DashboardApprovalAnalytics;
}) {
  return (
    <section
      className="space-y-4"
      data-testid="dashboard-approval-analytics"
    >
      <div>
        <h2 className="text-sm font-medium text-ink">Approval analytics</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          A lightweight aggregate view over approval workflows in this
          workspace. Reporting / explainability only — not a BI engine.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {APPROVAL_ANALYTICS_TILES.map((tile) => (
          <KpiTile
            key={tile.key}
            testId={`approval-analytics-${tile.key}`}
            label={tile.label}
            value={analytics[tile.key]}
            description={tile.hint}
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <OldestPendingSteps rows={analytics.oldest_pending_steps} />
        <PendingByAssignee rows={analytics.pending_by_assignee} />
      </div>
    </section>
  );
}

function OldestPendingSteps({
  rows,
}: {
  rows: DashboardOldestPendingStep[];
}) {
  return (
    <ListSection
      title="Oldest pending approval steps"
      testId="oldest-pending-steps"
      emptyHint="No pending approval steps."
      isEmpty={rows.length === 0}
    >
      {rows.map((row) => (
        <li
          key={row.id}
          className="rounded border border-rule p-2"
          data-testid="approval-analytics-oldest-row"
        >
          <p className="font-medium text-ink">
            <Link
              to={demoPath(
                `/approvals?workflow_id=${encodeURIComponent(row.workflow_run_id)}`,
              )}
              className="hover:underline"
              data-testid="approval-analytics-workflow-link"
            >
              {row.title}
            </Link>
            <span className="ml-1 text-xs text-ink-subtle">
              · step {row.step_order}
            </span>
          </p>
          <p className="text-xs text-ink-subtle">
            {row.approver_name ? `${row.approver_name}` : "Unassigned"}
            {row.due_date ? ` · due ${row.due_date}` : " · no due date"}
            {row.request_id ? (
              <>
                {" · "}
                <Link
                  to={demoPath(
                    `/requests/${encodeURIComponent(row.request_id)}`,
                  )}
                  className="underline"
                  data-testid="approval-analytics-request-link"
                >
                  open request
                </Link>
              </>
            ) : null}
            {row.contract_id && !row.request_id ? (
              <>
                {" · "}
                <Link
                  to={demoPath(
                    `/repository/${encodeURIComponent(row.contract_id)}`,
                  )}
                  className="underline"
                  data-testid="approval-analytics-contract-link"
                >
                  open repository record
                </Link>
              </>
            ) : null}
          </p>
        </li>
      ))}
    </ListSection>
  );
}

function PendingByAssignee({
  rows,
}: {
  rows: DashboardApprovalAssigneeBucket[];
}) {
  return (
    <ListSection
      title="Pending by assignee"
      testId="pending-by-assignee"
      emptyHint="No pending approval steps."
      isEmpty={rows.length === 0}
    >
      {rows.map((row) => {
        const key = row.assigned_to ?? "__unassigned__";
        return (
          <li
            key={key}
            className="rounded border border-rule p-2"
            data-testid="approval-analytics-assignee-row"
          >
            <p className="font-medium text-ink">
              {row.assigned_to ?? "Unassigned"}
            </p>
            <p className="text-xs text-ink-subtle">
              {row.count} pending
              {row.overdue_count > 0
                ? ` · ${row.overdue_count} overdue`
                : ""}
            </p>
          </li>
        );
      })}
    </ListSection>
  );
}

interface ListSectionProps {
  title: string;
  testId: string;
  emptyHint: string;
  isEmpty: boolean;
  children: React.ReactNode;
}

function ListSection({
  title,
  testId,
  emptyHint,
  isEmpty,
  children,
}: ListSectionProps) {
  return (
    <div
      className="rounded border border-rule p-3"
      data-testid={`section-${testId}`}
    >
      <h2 className="text-sm font-medium text-ink">{title}</h2>
      {isEmpty ? (
        <EmptyState title="" description={emptyHint} />
      ) : (
        <ul className="mt-3 space-y-2 text-sm" data-testid={`list-${testId}`}>
          {children}
        </ul>
      )}
    </div>
  );
}

function UpcomingRequests({ rows }: { rows: DashboardRequestSummary[] }) {
  return (
    <ListSection
      title="Requests due soon (next 14 days)"
      testId="requests-due-soon"
      emptyHint="No requests due in the next two weeks."
      isEmpty={rows.length === 0}
    >
      {rows.map((row) => (
        <li
          key={row.id}
          className="rounded border border-rule p-2"
          data-testid="dashboard-request-row"
        >
          <p className="font-medium text-ink">
            <Link
              to={demoPath(`/requests/${encodeURIComponent(row.id)}`)}
              className="hover:underline"
            >
              {row.title}
            </Link>
          </p>
          <p className="text-xs text-ink-subtle">
            <span data-testid="dashboard-request-status">{row.status}</span>
            {row.priority ? ` · ${row.priority}` : ""}
            {row.due_date ? ` · due ${row.due_date}` : ""}
            {row.counterparty_name ? ` · ${row.counterparty_name}` : ""}
          </p>
        </li>
      ))}
    </ListSection>
  );
}

function UpcomingInboxItems({ rows }: { rows: DashboardInboxSummary[] }) {
  return (
    <ListSection
      title="Inbox items due soon"
      testId="inbox-due-soon"
      emptyHint="Nothing in the inbox is due in the next two weeks."
      isEmpty={rows.length === 0}
    >
      {rows.map((row) => {
        const href = row.request_id
          ? demoPath(`/requests/${encodeURIComponent(row.request_id)}`)
          : row.contract_id
            ? demoPath(`/repository/${encodeURIComponent(row.contract_id)}`)
            : demoPath("/inbox");
        return (
          <li
            key={row.id}
            className="rounded border border-rule p-2"
            data-testid="dashboard-inbox-row"
          >
            <p className="font-medium text-ink">
              <Link to={href} className="hover:underline">
                {row.title}
              </Link>
            </p>
            <p className="text-xs text-ink-subtle">
              {row.item_type}
              {row.priority ? ` · ${row.priority}` : ""}
              {row.due_date ? ` · due ${row.due_date}` : ""}
            </p>
          </li>
        );
      })}
    </ListSection>
  );
}

function RecentRequests({ rows }: { rows: DashboardRequestSummary[] }) {
  return (
    <ListSection
      title="Recent requests"
      testId="recent-requests"
      emptyHint="No request activity yet."
      isEmpty={rows.length === 0}
    >
      {rows.map((row) => (
        <li
          key={row.id}
          className="rounded border border-rule p-2"
          data-testid="dashboard-recent-request-row"
        >
          <p className="font-medium text-ink">
            <Link
              to={demoPath(`/requests/${encodeURIComponent(row.id)}`)}
              className="hover:underline"
            >
              {row.title}
            </Link>
          </p>
          <p className="text-xs text-ink-subtle">
            {row.status}
            {row.contract_type ? ` · ${row.contract_type}` : ""}
            {row.linked_contract_id ? " · linked contract" : ""}
          </p>
        </li>
      ))}
    </ListSection>
  );
}

interface RecentContractsProps {
  title: string;
  testId: string;
  rows: DashboardContractSummary[];
  emptyHint: string;
}

function RecentContracts({
  title,
  testId,
  rows,
  emptyHint,
}: RecentContractsProps) {
  return (
    <ListSection
      title={title}
      testId={testId}
      emptyHint={emptyHint}
      isEmpty={rows.length === 0}
    >
      {rows.map((row) => (
        <li
          key={row.id}
          className="rounded border border-rule p-2"
          data-testid="dashboard-contract-row"
        >
          <p className="font-medium text-ink">
            <Link
              to={demoPath(`/repository/${encodeURIComponent(row.id)}`)}
              className="hover:underline"
            >
              {row.title}
            </Link>
          </p>
          <p className="text-xs text-ink-subtle">
            <span data-testid="dashboard-contract-status">{row.status}</span>
            {row.has_generated_docx ? " · generated" : ""}
            {row.has_signed_pdf ? " · signed PDF" : ""}
          </p>
        </li>
      ))}
    </ListSection>
  );
}
