import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import StatusBadge from "./StatusBadge";
import Pill from "./ui/Pill";
import { formatDate, mimeLabel, relativeDateWithin } from "../lib/format";
import {
  REPOSITORY_COLUMNS,
  type RepositoryColumnId,
  type SortableColumn,
  type SortDir,
  type SortKey,
} from "../lib/repositoryColumns";
import type { ContractListItem } from "../types/contracts";

interface ContractTableProps {
  contracts: ContractListItem[];
  visibleColumns: Set<RepositoryColumnId>;
  sort: SortKey;
  dir: SortDir;
  onSortChange: (key: SortKey) => void;
  now?: Date;
}

const EM_DASH = (
  <span className="text-ink-subtle" aria-hidden>
    —
  </span>
);

function MergedChip() {
  return (
    <Pill
      tone="neutral"
      variant="soft"
      className="uppercase tracking-wide"
      data-testid="repository-merged-chip"
      title="This record has been merged into another Repository record."
    >
      Merged
    </Pill>
  );
}

const MATCH_SOURCE_LABEL: Record<string, string> = {
  title: "Matched title",
  text_preview: "Matched Text preview",
  title_and_text_preview: "Matched title + Text preview",
};

function MatchSourceChip({ source }: { source: string }) {
  const label = MATCH_SOURCE_LABEL[source];
  if (!label) return null;
  return (
    <Pill
      tone="info"
      variant="soft"
      className="uppercase tracking-wide"
      data-testid="repository-match-source-chip"
      data-source={source}
      title="Why this record matched the current search"
    >
      {label}
    </Pill>
  );
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join("");
}

function OwnerCell({ contract }: { contract: ContractListItem }) {
  const name = contract.owner_display_name;
  if (!name) return EM_DASH;
  return (
    <span
      className="inline-flex items-center gap-2"
      data-testid="repository-owner"
    >
      <span
        aria-hidden
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-canvas-muted text-[10px] font-medium text-ink-muted"
        title={name}
      >
        {initialsFor(name)}
      </span>
      <span className="text-ink-muted">{name}</span>
    </span>
  );
}

function RenewalCell({ contract, now }: { contract: ContractListItem; now: Date }) {
  const iso = contract.renewal_date;
  if (!iso) return EM_DASH;
  const relative = relativeDateWithin(iso, 90, now);
  const absolute = formatDate(iso);
  return (
    <span
      className="inline-flex items-center gap-1"
      data-testid="repository-renewal"
    >
      {relative ? (
        <span className="text-warning" title={absolute}>
          {relative}
        </span>
      ) : (
        <span className="text-ink-muted">{absolute}</span>
      )}
      {contract.auto_renew ? (
        <span
          aria-hidden
          title="Auto-renews"
          className="text-ink-subtle"
          data-testid="repository-auto-renew"
        >
          ↻
        </span>
      ) : null}
    </span>
  );
}

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="text-ink-subtle/40">↕</span>;
  return <span aria-hidden>{dir === "asc" ? "↑" : "↓"}</span>;
}

function HeaderCell({
  col,
  sort,
  dir,
  onSortChange,
  className,
}: {
  col: SortableColumn;
  sort: SortKey;
  dir: SortDir;
  onSortChange: (key: SortKey) => void;
  className?: string;
}) {
  const isActive = col.sortKey != null && col.sortKey === sort;
  const sortable = col.sortKey != null;
  return (
    <th
      scope="col"
      className={["px-4 py-2.5 text-left align-bottom", className]
        .filter(Boolean)
        .join(" ")}
      aria-sort={
        !isActive ? "none" : dir === "asc" ? "ascending" : "descending"
      }
    >
      {sortable ? (
        <button
          type="button"
          onClick={() => onSortChange(col.sortKey!)}
          className="inline-flex items-center gap-1 hover:text-ink"
          data-testid={`repository-sort-${col.id}`}
          data-active={isActive ? "true" : "false"}
        >
          {col.label}
          <SortIndicator active={isActive} dir={dir} />
        </button>
      ) : (
        col.label
      )}
    </th>
  );
}

export default function ContractTable({
  contracts,
  visibleColumns,
  sort,
  dir,
  onSortChange,
  now = new Date(),
}: ContractTableProps) {
  const cols = REPOSITORY_COLUMNS.filter((c) => visibleColumns.has(c.id));

  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      {/* Cards on small screens — readable without horizontal scroll. */}
      <ul className="divide-y divide-rule sm:hidden">
        {contracts.map((c) => (
          <li key={c.id} className="px-4 py-3 text-sm">
            <Link
              to={`/demo/repository/${c.id}`}
              className="block font-medium text-ink hover:underline"
            >
              {c.title}
            </Link>
            <p className="mt-0.5 font-mono text-[11px] text-ink-subtle">
              {c.id.slice(0, 8)}…{c.file_hash_sha256.slice(0, 8)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
              <StatusBadge status={c.status} />
              {c.merged_into_contract_id && <MergedChip />}
              {c.search_match_source && (
                <MatchSourceChip source={c.search_match_source} />
              )}
              <span>{mimeLabel(c.mime_type)}</span>
              {c.counterparty ? <span>{c.counterparty}</span> : null}
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-ink-subtle">
              <span>
                Effective:{" "}
                {c.effective_date ? (
                  <span className="tabular-nums text-ink-muted">
                    {formatDate(c.effective_date)}
                  </span>
                ) : (
                  EM_DASH
                )}
              </span>
              <span>
                Renewal: <RenewalCell contract={c} now={now} />
              </span>
              <span>
                Owner: <OwnerCell contract={c} />
              </span>
              <span>Updated {formatDate(c.updated_at)}</span>
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
        <table className="min-w-full divide-y divide-rule">
          <thead className="bg-canvas-subtle">
            <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
              {cols.map((col) => (
                <HeaderCell
                  key={col.id}
                  col={col}
                  sort={sort}
                  dir={dir}
                  onSortChange={onSortChange}
                  className={col.className}
                />
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-rule text-sm">
            {contracts.map((c) => (
              <tr key={c.id} className="hover:bg-canvas-subtle">
                {cols.map((col) => (
                  <td
                    key={col.id}
                    className={[
                      "px-4 py-3 align-top",
                      col.id === "title" ? "" : "text-ink-muted",
                      col.className,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {renderCell(col.id, c, now)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderCell(
  id: RepositoryColumnId,
  c: ContractListItem,
  now: Date,
): ReactNode {
  switch (id) {
    case "title":
      return (
        <>
          <Link
            to={`/demo/repository/${c.id}`}
            className="font-medium text-ink hover:underline"
          >
            {c.title}
          </Link>
          <p className="mt-0.5 font-mono text-[11px] text-ink-subtle">
            {c.id.slice(0, 8)}…{c.file_hash_sha256.slice(0, 8)}
          </p>
          {(c.merged_into_contract_id || c.search_match_source) && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {c.merged_into_contract_id && <MergedChip />}
              {c.search_match_source && (
                <MatchSourceChip source={c.search_match_source} />
              )}
            </div>
          )}
        </>
      );
    case "counterparty":
      return c.counterparty ? c.counterparty : EM_DASH;
    case "type":
      return mimeLabel(c.mime_type);
    case "effective_date":
      return c.effective_date ? formatDate(c.effective_date) : EM_DASH;
    case "renewal":
      return <RenewalCell contract={c} now={now} />;
    case "owner":
      return <OwnerCell contract={c} />;
    case "status":
      return <StatusBadge status={c.status} />;
    case "updated":
      return formatDate(c.updated_at);
  }
}
