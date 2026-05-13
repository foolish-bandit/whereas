import { useMemo, useState } from "react";

import {
  clauseHasValidSpan,
  clausePreview,
  clauseSelectionKey,
  clauseTypeLabel,
} from "../lib/clauses";
import type { Clause } from "../types/contracts";
import SimilarClausesPanel, {
  type SimilarClauseMatch,
} from "./SimilarClausesPanel";

interface ClausesPanelProps {
  clauses: Clause[];
  fullText: string | null;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  similarityMatches?: SimilarClauseMatch[];
}

export default function ClausesPanel({
  clauses,
  fullText,
  selectedKey,
  onSelect,
  similarityMatches,
}: ClausesPanelProps) {
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  const sorted = useMemo(
    () => [...clauses].sort((a, b) => a.ordinal - b.ordinal),
    [clauses],
  );

  // Distinct present types, sorted alphabetically by their labels for the
  // dropdown. Unclassified clauses are surfaced explicitly so users can
  // filter to "what hasn't been tagged".
  const typeOptions = useMemo(() => {
    const present = new Set<string>();
    let hasUnclassified = false;
    for (const c of sorted) {
      if (c.clause_type) present.add(c.clause_type);
      else hasUnclassified = true;
    }
    const labelled = Array.from(present)
      .map((t) => ({ value: t, label: clauseTypeLabel(t) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (hasUnclassified) {
      labelled.push({ value: "__none__", label: "Unclassified" });
    }
    return labelled;
  }, [sorted]);


  const selectedClause = useMemo(() => {
    if (!selectedKey?.startsWith("clause:")) return null;
    const id = selectedKey.slice("clause:".length);
    return clauses.find((c) => c.id === id) ?? null;
  }, [clauses, selectedKey]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sorted.filter((c) => {
      if (typeFilter === "__none__") {
        if (c.clause_type) return false;
      } else if (typeFilter && c.clause_type !== typeFilter) {
        return false;
      }
      if (!needle) return true;
      const haystack = `${c.heading ?? ""}\n${c.text}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [sorted, typeFilter, search]);

  if (clauses.length === 0) {
    return (
      <div className="rounded-lg border border-rule bg-canvas p-5">
        <h2 className="text-sm font-medium text-ink">Clauses</h2>
        <p className="mt-2 text-sm text-ink-muted">
          No clauses have been segmented for this contract yet. Clause
          segmentation runs on upload; if it failed for this contract, you can
          re-upload it or check the server logs.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-rule bg-canvas">
      <div className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
        <h2 className="text-sm font-medium text-ink">
          Clauses ({clauses.length} found)
        </h2>
        <p className="mt-0.5 text-xs text-ink-subtle">
          Heuristic segmentation. Click a clause to highlight its source span.
          Whereas surfaces clauses; it does not provide legal advice.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            aria-label="Filter clauses by type"
            className="rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink"
          >
            <option value="">All types</option>
            {typeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clauses…"
            aria-label="Search clauses"
            className="flex-1 rounded border border-rule bg-canvas px-2 py-1 text-xs text-ink placeholder:text-ink-subtle"
          />
        </div>
        {filtered.length !== clauses.length && (
          <p className="mt-2 text-[11px] text-ink-subtle">
            Showing {filtered.length} of {clauses.length}
          </p>
        )}
      </div>
      {filtered.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-muted">
          No clauses match the current filters.
        </p>
      ) : (
        <ul className="max-h-mobile-viewer divide-y divide-rule overflow-y-auto lg:max-h-[calc(100vh-22rem)]">
          {filtered.map((clause) => {
            const key = clauseSelectionKey(clause);
            const isSelected = key === selectedKey;
            const validSpan = clauseHasValidSpan(clause, fullText);
            return (
              <li key={clause.id}>
                <button
                  type="button"
                  onClick={() => onSelect(isSelected ? null : key)}
                  className={[
                    "flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors",
                    isSelected
                      ? "bg-info-soft"
                      : "hover:bg-canvas-subtle",
                  ].join(" ")}
                  aria-pressed={isSelected}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-ink-subtle">
                      #{clause.ordinal + 1}
                    </span>
                    {clause.clause_type && (
                      <span className="rounded-full border border-rule bg-canvas-subtle px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                        {clauseTypeLabel(clause.clause_type)}
                      </span>
                    )}
                  </div>
                  {clause.heading && (
                    <div className="text-sm font-medium text-ink">
                      {clause.heading}
                    </div>
                  )}
                  <div className="text-xs text-ink-muted">
                    {validSpan ? (
                      <p className="line-clamp-3">
                        {clausePreview(clause)}
                      </p>
                    ) : (
                      <p className="text-warning">Citation unavailable</p>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      </div>
      {selectedClause ? (
        <SimilarClausesPanel
          sourceClauseTitle={selectedClause.heading ?? `Clause #${selectedClause.ordinal + 1}`}
          sourceClauseText={selectedClause.text}
          matches={similarityMatches}
        />
      ) : null}
    </div>
  );
}
