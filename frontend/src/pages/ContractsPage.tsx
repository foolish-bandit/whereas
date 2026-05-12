import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import ContractTable from "../components/ContractTable";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import { ApiError, MissingDevUserError, getContracts } from "../lib/api";
import { mimeLabel } from "../lib/format";
import type { ContractListItem } from "../types/contracts";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; contracts: ContractListItem[] }
  | { kind: "error"; title: string; description: string };

type SortOrder = "newest" | "oldest" | "title_asc" | "updated_desc";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "ready", label: "Ready" },
  { value: "extracting", label: "Extracting" },
  { value: "uploaded", label: "Uploaded" },
  { value: "sent_for_signature", label: "Out for signature" },
  { value: "executed", label: "Executed" },
  { value: "failed", label: "Extraction failed" },
];

const SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "title_asc", label: "Title A→Z" },
  { value: "updated_desc", label: "Recently updated" },
];

const Q_PARAM = "q";
const STATUS_PARAM = "status";
const SORT_PARAM = "sort";
const MERGED_PARAM = "merged";
const SEARCH_DEBOUNCE_MS = 250;

const STATUS_VALUES = new Set(STATUS_FILTERS.map((s) => s.value));
const SORT_VALUES = new Set<SortOrder>(SORT_OPTIONS.map((s) => s.value));

/**
 * PR #104 — Built-in URL-backed Repository views.
 *
 * Each preset is a canonical combination of the existing
 * status / sort / Show-merged filter state — it does NOT add new
 * backend filter fields. Clicking a preset rewrites
 * ``status`` / ``sort`` / ``merged`` URL params; the active preset
 * label is derived from those params so the back / forward buttons
 * and shared deep links Just Work. ``q`` is intentionally preserved
 * across preset selection — searching within a view is the common
 * case (see brief: "Preserve q unless the preset would be
 * confusing").
 *
 * These are not persisted user-saved views; that requires backend
 * + auth and is intentional future work.
 */
type RepositoryView = {
  id: string;
  label: string;
  status: string;
  sort: SortOrder;
  merged: boolean;
};

const REPOSITORY_VIEWS: RepositoryView[] = [
  { id: "active", label: "All active", status: "all", sort: "newest", merged: false },
  {
    id: "needs_attention",
    label: "Needs attention",
    status: "failed",
    sort: "newest",
    merged: false,
  },
  {
    id: "out_for_signature",
    label: "Out for signature",
    status: "sent_for_signature",
    sort: "newest",
    merged: false,
  },
  {
    id: "executed",
    label: "Executed",
    status: "executed",
    sort: "newest",
    merged: false,
  },
  {
    id: "recently_updated",
    label: "Recently updated",
    status: "all",
    sort: "updated_desc",
    merged: false,
  },
  { id: "merged", label: "Merged", status: "all", sort: "newest", merged: true },
];

function matchView(
  status: string,
  sort: SortOrder,
  merged: boolean,
): RepositoryView | null {
  return (
    REPOSITORY_VIEWS.find(
      (v) => v.status === status && v.sort === sort && v.merged === merged,
    ) ?? null
  );
}

export default function ContractsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Initial search state seeded from the URL so a deep link like
  // /repository?q=acme initializes the box with that query and the
  // first fetch already includes it (PR #95).
  const initialQ = searchParams.get(Q_PARAM) ?? "";
  // PR #104 — seed status / sort / merged from URL so a preset
  // deep link (?status=executed) and the back/forward buttons both
  // restore the right view. Unknown values fall back to defaults.
  const initialStatus = (() => {
    const raw = searchParams.get(STATUS_PARAM) ?? "all";
    return STATUS_VALUES.has(raw) ? raw : "all";
  })();
  const initialSort: SortOrder = (() => {
    const raw = searchParams.get(SORT_PARAM) as SortOrder | null;
    return raw && SORT_VALUES.has(raw) ? raw : "newest";
  })();
  const initialMerged = searchParams.get(MERGED_PARAM) === "true";
  const [search, setSearch] = useState(initialQ);
  const [committedSearch, setCommittedSearch] = useState(initialQ);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [typeFilter, setTypeFilter] = useState("all");
  const [sort, setSort] = useState<SortOrder>(initialSort);
  const [includeMerged, setIncludeMerged] = useState(initialMerged);
  // PR #105 — Advanced filters panel. Opens expanded by default so
  // the existing inline controls remain available without an extra
  // click; users can collapse it to reclaim vertical space.
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(true);

  // Debounce the URL + fetch updates so a fast typist doesn't fire a
  // request per keystroke. The committed value drives both the URL
  // and the API call.
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      setCommittedSearch(search);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [search]);

  // Sync URL ?q= to the committed search. Replace, not push, so the
  // back button skips intermediate keystrokes.
  useEffect(() => {
    const trimmed = committedSearch.trim();
    const next = new URLSearchParams(searchParams);
    if (trimmed) {
      if (next.get(Q_PARAM) !== trimmed) {
        next.set(Q_PARAM, trimmed);
        setSearchParams(next, { replace: true });
      }
    } else if (next.has(Q_PARAM)) {
      next.delete(Q_PARAM);
      setSearchParams(next, { replace: true });
    }
    // setSearchParams identity is stable; depending on it would
    // loop. We intentionally only re-run when the committed search
    // changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedSearch]);

  // PR #104 — keep ``status`` / ``sort`` / ``merged`` URL params in
  // sync with state so presets are bookmarkable + back/forward
  // friendly. Default values are omitted from the URL to keep
  // ``/repository`` clean for the All-active default view.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (statusFilter !== "all") next.set(STATUS_PARAM, statusFilter);
    else next.delete(STATUS_PARAM);
    if (sort !== "newest") next.set(SORT_PARAM, sort);
    else next.delete(SORT_PARAM);
    if (includeMerged) next.set(MERGED_PARAM, "true");
    else next.delete(MERGED_PARAM);
    const before = searchParams.toString();
    const after = next.toString();
    if (before !== after) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, sort, includeMerged]);

  const activeView = useMemo(
    () => matchView(statusFilter, sort, includeMerged),
    [statusFilter, sort, includeMerged],
  );

  function onSelectView(view: RepositoryView) {
    setStatusFilter(view.status);
    setSort(view.sort);
    setIncludeMerged(view.merged);
    // Type filter and q are intentionally preserved.
  }

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    getContracts({
      signal: controller.signal,
      include_merged: includeMerged,
      q: committedSearch,
    })
      .then((contracts) => setState({ kind: "loaded", contracts }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof MissingDevUserError) {
          setState({
            kind: "error",
            title: "No development user ID configured",
            description:
              "Set a development user ID in Settings before opening the repository.",
          });
          return;
        }
        if (err instanceof ApiError) {
          setState({
            kind: "error",
            title: "Could not load repository",
            description: err.message,
          });
          return;
        }
        setState({
          kind: "error",
          title: "Could not load repository",
          description: "An unexpected error occurred.",
        });
      });
    return () => controller.abort();
  }, [includeMerged, committedSearch]);

  const types = useMemo(() => {
    if (state.kind !== "loaded") return [];
    const set = new Set(state.contracts.map((c) => c.mime_type));
    return Array.from(set);
  }, [state]);

  const filtered = useMemo(() => {
    if (state.kind !== "loaded") return [];
    const rows = state.contracts.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (typeFilter !== "all" && c.mime_type !== typeFilter) return false;
      return true;
    });
    const sorted = [...rows];
    if (sort === "newest") {
      sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else if (sort === "oldest") {
      sorted.sort((a, b) => a.created_at.localeCompare(b.created_at));
    } else if (sort === "title_asc") {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sort === "updated_desc") {
      sorted.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return sorted;
  }, [state, statusFilter, typeFilter, sort]);

  const hasActiveFilter =
    committedSearch.trim().length > 0 ||
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    includeMerged;

  function onClearSearch() {
    setSearch("");
    setCommittedSearch("");
  }

  // PR #105 — count of non-default filter dimensions currently
  // applied. Each of (q, status, sort, type, merged) that differs
  // from its default contributes 1; surfaced as a chip next to the
  // Advanced filters toggle so users can see at a glance how
  // narrowed the list is.
  const activeFilterCount =
    (committedSearch.trim() ? 1 : 0) +
    (statusFilter !== "all" ? 1 : 0) +
    (sort !== "newest" ? 1 : 0) +
    (typeFilter !== "all" ? 1 : 0) +
    (includeMerged ? 1 : 0);

  function onResetAllFilters() {
    setSearch("");
    setCommittedSearch("");
    setStatusFilter("all");
    setTypeFilter("all");
    setSort("newest");
    setIncludeMerged(false);
  }

  return (
    <div data-testid="repository-page">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-xl text-ink sm:text-2xl">Repository</h1>
          <p className="mt-1 text-sm text-ink-muted">
            All agreements, drafts, signed documents, and contract records.
            Extracted metadata is machine-generated and must be reviewed before
            relying on it.
          </p>
        </div>
        <Link
          to="/demo/upload"
          className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring sm:w-auto sm:py-1.5"
        >
          Upload to repository
        </Link>
      </div>

      <div
        className="mb-3 flex flex-wrap items-center gap-2 text-xs"
        data-testid="repository-views"
        role="group"
        aria-label="Quick views"
      >
        <span className="text-ink-subtle">Views:</span>
        {REPOSITORY_VIEWS.map((v) => {
          const isActive = activeView?.id === v.id;
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onSelectView(v)}
              aria-pressed={isActive}
              className={`rounded border px-2 py-1 ${
                isActive
                  ? "border-info-ring bg-info-soft text-info"
                  : "border-rule bg-canvas text-ink-muted hover:border-rule-strong hover:text-ink"
              }`}
              data-testid={`repository-view-${v.id}`}
              data-active={isActive ? "true" : "false"}
            >
              {v.label}
            </button>
          );
        })}
        <span
          className="ml-1 text-ink-subtle"
          data-testid="repository-view-active-label"
        >
          {activeView ? `Active: ${activeView.label}` : "Custom view"}
        </span>
      </div>

      {/* Search row — first-class, always inline. */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="relative flex-1 min-w-[200px]">
          <span className="sr-only">
            Search Repository records by title or Text preview content
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Repository by title or Text preview…"
            className="w-full rounded border border-rule bg-canvas px-3 py-1.5 text-sm placeholder:text-ink-subtle focus:border-accent-ring focus:outline-none"
            data-testid="repository-search"
            aria-label="Search Repository records by title or Text preview content"
          />
          {search && (
            <button
              type="button"
              onClick={onClearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-ink-muted hover:text-ink"
              data-testid="repository-search-clear"
              aria-label="Clear search"
            >
              clear
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => setShowAdvancedFilters((v) => !v)}
          aria-expanded={showAdvancedFilters}
          aria-controls="repository-advanced-panel"
          className="flex items-center gap-2 rounded border border-rule bg-canvas px-2.5 py-1.5 text-xs text-ink hover:border-rule-strong"
          data-testid="repository-advanced-toggle"
        >
          {showAdvancedFilters ? "Hide filters" : "Advanced filters"}
          {activeFilterCount > 0 && (
            <span
              className="rounded-full border border-info/40 bg-info/10 px-1.5 text-[10px] font-medium text-info"
              data-testid="repository-advanced-active-count"
            >
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {/* Advanced filters panel. Open by default so existing inline
          controls remain available without a click; users can fold
          it to free up vertical space. */}
      {showAdvancedFilters && (
        <div
          id="repository-advanced-panel"
          className="mb-4 rounded border border-rule bg-canvas-subtle p-3"
          data-testid="repository-advanced-panel"
        >
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded border border-rule bg-canvas px-2.5 py-1.5 text-sm text-ink focus:border-accent-ring focus:outline-none"
              aria-label="Filter by status"
              data-testid="repository-filter-status"
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded border border-rule bg-canvas px-2.5 py-1.5 text-sm text-ink focus:border-accent-ring focus:outline-none"
              aria-label="Filter by type"
              data-testid="repository-filter-type"
            >
              <option value="all">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {mimeLabel(t)}
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortOrder)}
              className="rounded border border-rule bg-canvas px-2.5 py-1.5 text-sm text-ink focus:border-accent-ring focus:outline-none"
              aria-label="Sort by"
              data-testid="repository-sort"
            >
              {SORT_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <label
              className="flex items-center gap-2 text-xs text-ink-subtle"
              data-testid="repository-include-merged-label"
            >
              <input
                type="checkbox"
                checked={includeMerged}
                onChange={(e) => setIncludeMerged(e.target.checked)}
                data-testid="repository-include-merged"
              />
              Show merged
            </label>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-subtle">
            {committedSearch.trim() && (
              <span
                className="rounded border border-rule bg-canvas px-1.5 py-0.5"
                data-testid="repository-advanced-search-summary"
              >
                Search:{" "}
                <span className="text-ink">"{committedSearch.trim()}"</span>
                <button
                  type="button"
                  onClick={onClearSearch}
                  className="ml-1 text-ink-muted underline hover:text-ink"
                  data-testid="repository-advanced-clear-search"
                >
                  clear
                </button>
              </span>
            )}
            <button
              type="button"
              onClick={onResetAllFilters}
              disabled={activeFilterCount === 0}
              className="rounded border border-rule bg-canvas px-2 py-0.5 text-ink hover:border-rule-strong disabled:opacity-50"
              data-testid="repository-advanced-reset-all"
            >
              Reset all filters
            </button>
          </div>
        </div>
      )}

      {state.kind === "loading" && <LoadingSkeleton rows={6} />}

      {state.kind === "error" && (
        <ErrorState
          title={state.title}
          description={state.description}
          action={
            <Link
              to="/demo/settings"
              className="inline-flex items-center rounded border border-rule bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:border-rule-strong"
            >
              Open settings
            </Link>
          }
        />
      )}

      {state.kind === "loaded" &&
        state.contracts.length === 0 &&
        (hasActiveFilter ? (
          <EmptyState
            title="No matches"
            description="No Repository records match the current search or filters. Search looks at the record title and any Text preview content."
            action={
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onClearSearch}
                  className="inline-flex items-center rounded border border-rule bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:border-rule-strong"
                  data-testid="repository-empty-clear-search"
                >
                  Clear search
                </button>
                <button
                  type="button"
                  onClick={onResetAllFilters}
                  className="inline-flex items-center rounded border border-rule bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:border-rule-strong"
                  data-testid="repository-empty-reset-filters"
                >
                  Reset filters
                </button>
              </div>
            }
          />
        ) : (
          <EmptyState
            title="The repository is empty."
            description="Upload your first PDF or DOCX to start your agreement repository."
            action={
              <Link
                to="/demo/upload"
                className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring sm:w-auto sm:py-1.5"
              >
                Upload to repository
              </Link>
            }
          />
        ))}

      {state.kind === "loaded" && state.contracts.length > 0 && (
        <>
          <ContractTable contracts={filtered} />
          <p className="mt-3 text-xs text-ink-subtle">
            {filtered.length} of {state.contracts.length} agreements shown
            {committedSearch.trim() ? ` for "${committedSearch.trim()}"` : ""}
            .
          </p>
          {filtered.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">
              Nothing in the loaded Repository slice matches the current
              status / type filters.
            </p>
          )}
        </>
      )}
    </div>
  );
}
