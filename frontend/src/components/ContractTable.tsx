import { Link } from "react-router-dom";

import StatusBadge from "./StatusBadge";
import { formatDate, mimeLabel } from "../lib/format";
import type { ContractListItem } from "../types/contracts";

interface ContractTableProps {
  contracts: ContractListItem[];
}

function MergedChip() {
  return (
    <span
      className="rounded border border-rule bg-canvas-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted"
      data-testid="repository-merged-chip"
      title="This record has been merged into another Repository record."
    >
      Merged
    </span>
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
    <span
      className="rounded border border-info/40 bg-info/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-info"
      data-testid="repository-match-source-chip"
      data-source={source}
      title="Why this record matched the current search"
    >
      {label}
    </span>
  );
}

export default function ContractTable({ contracts }: ContractTableProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      {/* Cards on small screens — keeps every field readable without
          forcing horizontal scrolling on a narrow viewport. */}
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
              {c.page_count != null && <span>{c.page_count} pages</span>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-subtle">
              <span>Uploaded {formatDate(c.created_at)}</span>
              <span>Updated {formatDate(c.updated_at)}</span>
            </div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
        <table className="min-w-full divide-y divide-rule">
          <thead className="bg-canvas-subtle">
            <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
              <th className="px-4 py-2.5">Title</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Type</th>
              <th className="px-4 py-2.5 text-right">Pages</th>
              <th className="px-4 py-2.5">Uploaded</th>
              <th className="px-4 py-2.5">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule text-sm">
            {contracts.map((c) => (
              <tr
                key={c.id}
                className="hover:bg-canvas-subtle"
              >
                <td className="px-4 py-3 align-top">
                  <Link
                    to={`/demo/repository/${c.id}`}
                    className="font-medium text-ink hover:underline"
                  >
                    {c.title}
                  </Link>
                  <p className="mt-0.5 font-mono text-[11px] text-ink-subtle">
                    {c.id.slice(0, 8)}…{c.file_hash_sha256.slice(0, 8)}
                  </p>
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={c.status} />
                    {c.merged_into_contract_id && <MergedChip />}
                    {c.search_match_source && (
                      <MatchSourceChip source={c.search_match_source} />
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 align-top text-ink-muted">
                  {mimeLabel(c.mime_type)}
                </td>
                <td className="px-4 py-3 text-right align-top tabular-nums text-ink-muted">
                  {c.page_count ?? "—"}
                </td>
                <td className="px-4 py-3 align-top text-ink-muted">
                  {formatDate(c.created_at)}
                </td>
                <td className="px-4 py-3 align-top text-ink-muted">
                  {formatDate(c.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
