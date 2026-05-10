import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import EmptyState from "../components/EmptyState";
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
  DashboardInboxSummary,
  DashboardOldestPendingStep,
  DashboardRequestSummary,
  DashboardSummary,
} from "../types/dashboard";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; summary: DashboardSummary }
  | { kind: "error"; message: string };

const COUNT_TILES: {
  key: keyof DashboardSummary["counts"];
  label: string;
  hint: string;
}[] = [
  { key: "open_requests", label: "Open requests", hint: "Status open" },
  {
    key: "in_progress_requests",
    label: "Requests in progress",
    hint: "Status in_progress",
  },
  {
    key: "urgent_or_high_priority_requests",
    label: "Urgent / high-priority requests",
    hint: "Open or in-progress, priority urgent or high",
  },
  { key: "open_inbox_items", label: "Open inbox items", hint: "Status open" },
  {
    key: "overdue_inbox_items",
    label: "Overdue inbox items",
    hint: "Status open and past due",
  },
  {
    key: "contracts_total",
    label: "Contracts (all)",
    hint: "Every contract in this org",
  },
  {
    key: "contracts_sent_for_signature",
    label: "Out for signature",
    hint: "Status sent_for_signature",
  },
  {
    key: "contracts_executed",
    label: "Executed contracts",
    hint: "Status executed",
  },
  {
    key: "templates_active",
    label: "Active templates",
    hint: "Status active",
  },
  {
    key: "active_approval_workflows",
    label: "Active approval workflows",
    hint: "Workflows still moving through their steps",
  },
  {
    key: "pending_approval_steps",
    label: "Pending approval steps",
    hint: "Steps on active workflows awaiting a decision",
  },
  {
    key: "overdue_approval_steps",
    label: "Overdue approval steps",
    hint: "Pending steps past their due date",
  },
  {
    key: "active_approval_workflow_templates",
    label: "Approval templates",
    hint: "Active approval workflow blueprints",
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
      <div>
        <h1 className="text-lg font-semibold text-ink">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-muted">
          A read-only snapshot of CLM activity in this workspace. Counts
          and lists summarize existing requests, inbox items, contracts,
          signatures, and templates — not a reporting engine.
        </p>
      </div>

      {state.kind === "loading" && (
        <p className="text-sm text-ink-muted" data-testid="dashboard-loading">
          Loading dashboard…
        </p>
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
      <section data-testid="dashboard-counts">
        <h2 className="text-sm font-medium text-ink">At a glance</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {COUNT_TILES.map((tile) => (
            <div
              key={tile.key}
              className="rounded border border-rule p-3"
              data-testid={`count-${tile.key}`}
            >
              <p className="text-xs uppercase tracking-wide text-ink-subtle">
                {tile.label}
              </p>
              <p className="mt-2 text-2xl font-semibold text-ink">
                {summary.counts[tile.key]}
              </p>
              <p className="mt-1 text-xs text-ink-subtle">{tile.hint}</p>
            </div>
          ))}
        </div>
      </section>

      <section
        className="grid gap-4 lg:grid-cols-2"
        data-testid="dashboard-upcoming"
      >
        <UpcomingRequests
          rows={summary.upcoming.requests_due_soon}
        />
        <UpcomingInboxItems
          rows={summary.upcoming.inbox_items_due_soon}
        />
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
          <div
            key={tile.key}
            className="rounded border border-rule p-3"
            data-testid={`approval-analytics-${tile.key}`}
          >
            <p className="text-xs uppercase tracking-wide text-ink-subtle">
              {tile.label}
            </p>
            <p className="mt-2 text-2xl font-semibold text-ink">
              {analytics[tile.key]}
            </p>
            <p className="mt-1 text-xs text-ink-subtle">{tile.hint}</p>
          </div>
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
                    `/requests?request_id=${encodeURIComponent(row.request_id)}`,
                  )}
                  className="underline"
                  data-testid="approval-analytics-request-link"
                >
                  request
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
              {row.assigned_to ? (
                <code className="text-sm">{row.assigned_to}</code>
              ) : (
                "Unassigned"
              )}
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
            <Link to={demoPath("/requests")} className="hover:underline">
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
      {rows.map((row) => (
        <li
          key={row.id}
          className="rounded border border-rule p-2"
          data-testid="dashboard-inbox-row"
        >
          <p className="font-medium text-ink">
            <Link to={demoPath("/inbox")} className="hover:underline">
              {row.title}
            </Link>
          </p>
          <p className="text-xs text-ink-subtle">
            {row.item_type}
            {row.priority ? ` · ${row.priority}` : ""}
            {row.due_date ? ` · due ${row.due_date}` : ""}
          </p>
        </li>
      ))}
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
            <Link to={demoPath("/requests")} className="hover:underline">
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
              to={demoPath(`/contracts/${encodeURIComponent(row.id)}`)}
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
