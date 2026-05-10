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
  DashboardContractSummary,
  DashboardInboxSummary,
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
    </>
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
