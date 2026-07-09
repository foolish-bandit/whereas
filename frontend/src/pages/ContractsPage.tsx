import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import type { RowSelectionState } from "@tanstack/react-table";

import ContractTable from "../components/ContractTable";
import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import RepositoryActionBar from "../components/RepositoryActionBar";
import type { RepositoryFolder } from "../lib/repositoryFolders";
import { ApiError, MissingDevUserError, getContracts } from "../lib/api";
import { mimeLabel } from "../lib/format";
import {
  REPOSITORY_COLUMNS,
  type RepositoryColumnId,
  type SortDir,
  type SortKey,
} from "../lib/repositoryColumns";
import type { ContractListItem } from "../types/contracts";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; contracts: ContractListItem[] }
  | { kind: "error"; title: string; description: string };

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "ready", label: "Ready" },
  { value: "extracting", label: "Extracting" },
  { value: "uploaded", label: "Uploaded" },
  { value: "sent_for_signature", label: "Out for signature" },
  { value: "executed", label: "Executed" },
  { value: "failed", label: "Extraction failed" },
];

const Q_PARAM = "q";
const STATUS_PARAM = "status";
const SORT_PARAM = "sort";
const DIR_PARAM = "dir";
const MERGED_PARAM = "merged";
const COLUMNS_LS_KEY = "whereas:repository:columns";
const OVERRIDES_LS_KEY = "whereas:repository:overrides";
const SHOW_ARCHIVED_LS_KEY = "whereas:repository:showArchived";
const SEARCH_DEBOUNCE_MS = 250;

interface RepositoryOverride {
  tags?: string[];
  archived?: boolean;
  folder?: RepositoryFolder | null;
}

function loadOverrides(): Record<string, RepositoryOverride> {
  try {
    const raw = window.localStorage.getItem(OVERRIDES_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistOverrides(o: Record<string, RepositoryOverride>) {
  try {
    window.localStorage.setItem(OVERRIDES_LS_KEY, JSON.stringify(o));
  } catch {
    /* swallow quota errors */
  }
}

function applyOverride(
  base: ContractListItem,
  override?: RepositoryOverride,
): ContractListItem {
  if (!override) return base;
  return {
    ...base,
    tags: override.tags ?? base.tags,
    archived: override.archived ?? base.archived,
    folder: override.folder ?? base.folder,
  };
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsv(rows: ContractListItem[], visibleColumnIds: Set<string>) {
  type Col = { id: string; label: string; pick: (c: ContractListItem) => unknown };
  const allCols: Col[] = [
    { id: "title", label: "Title", pick: (c: ContractListItem) => c.title },
    { id: "counterparty", label: "Counterparty", pick: (c: ContractListItem) => c.counterparty },
    { id: "type", label: "Type", pick: (c: ContractListItem) => c.mime_type },
    { id: "effective_date", label: "Effective date", pick: (c: ContractListItem) => c.effective_date },
    { id: "renewal", label: "Renewal", pick: (c: ContractListItem) => c.renewal_date },
    { id: "owner", label: "Owner", pick: (c: ContractListItem) => c.owner_display_name },
    { id: "status", label: "Status", pick: (c: ContractListItem) => c.status },
    { id: "updated", label: "Updated", pick: (c: ContractListItem) => c.updated_at },
  ];
  const cols = allCols.filter((c) => visibleColumnIds.has(c.id));
  const header = cols.map((c) => csvEscape(c.label)).join(",");
  const body = rows
    .map((row) => cols.map((c) => csvEscape(c.pick(row))).join(","))
    .join("\n");
  const blob = new Blob([`${header}\n${body}\n`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `repository-export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const STATUS_VALUES = new Set(STATUS_FILTERS.map((s) => s.value));
const SORT_KEYS = new Set<SortKey>([
  "renewal_date",
  "effective_date",
  "title",
  "counterparty",
  "updated_at",
  "created_at",
  "status",
]);

const DEFAULT_SORT: SortKey = "renewal_date";
const DEFAULT_DIR: SortDir = "asc";

// Pre-PR-#X legacy ?sort=newest|oldest|title_asc|updated_desc values
// still appear in saved deep links. Map them onto the new (key, dir)
// scheme so users don't see an empty list after upgrade.
const LEGACY_SORT_MAP: Record<string, { sort: SortKey; dir: SortDir }> = {
  newest: { sort: "created_at", dir: "desc" },
  oldest: { sort: "created_at", dir: "asc" },
  title_asc: { sort: "title", dir: "asc" },
  updated_desc: { sort: "updated_at", dir: "desc" },
};

const ALL_COLUMN_IDS = REPOSITORY_COLUMNS.map((c) => c.id);
// Owner is hidden by default per the brief — only show in larger
// viewports or when the user explicitly enables it.
const DEFAULT_VISIBLE_COLUMNS: Set<RepositoryColumnId> = new Set(
  ALL_COLUMN_IDS.filter((id) => id !== "owner"),
);
const REQUIRED_COLUMNS: Set<RepositoryColumnId> = new Set(["title"]);

function loadVisibleColumnsFromStorage(): Set<RepositoryColumnId> {
  try {
    const raw = window.localStorage.getItem(COLUMNS_LS_KEY);
    if (!raw) return new Set(DEFAULT_VISIBLE_COLUMNS);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_VISIBLE_COLUMNS);
    const valid = parsed.filter((id): id is RepositoryColumnId =>
      ALL_COLUMN_IDS.includes(id as RepositoryColumnId),
    );
    // Always include required columns.
    REQUIRED_COLUMNS.forEach((c) => {
      if (!valid.includes(c)) valid.push(c);
    });
    return new Set(valid);
  } catch {
    return new Set(DEFAULT_VISIBLE_COLUMNS);
  }
}

function persistVisibleColumns(cols: Set<RepositoryColumnId>) {
  try {
    window.localStorage.setItem(
      COLUMNS_LS_KEY,
      JSON.stringify(Array.from(cols)),
    );
  } catch {
    // Quota / private-mode failures are fine to swallow — visibility
    // falls back to the in-memory state.
  }
}

type RepositoryView = {
  id: string;
  label: string;
  status: string;
  sort: SortKey;
  dir: SortDir;
  merged: boolean;
};

const REPOSITORY_VIEWS: RepositoryView[] = [
  { id: "active", label: "All active", status: "all", sort: DEFAULT_SORT, dir: DEFAULT_DIR, merged: false },
  {
    id: "needs_attention",
    label: "Needs attention",
    status: "failed",
    sort: DEFAULT_SORT,
    dir: DEFAULT_DIR,
    merged: false,
  },
  {
    id: "out_for_signature",
    label: "Out for signature",
    status: "sent_for_signature",
    sort: DEFAULT_SORT,
    dir: DEFAULT_DIR,
    merged: false,
  },
  {
    id: "executed",
    label: "Executed",
    status: "executed",
    sort: DEFAULT_SORT,
    dir: DEFAULT_DIR,
    merged: false,
  },
  {
    id: "recently_updated",
    label: "Recently updated",
    status: "all",
    sort: "updated_at",
    dir: "desc",
    merged: false,
  },
  {
    id: "merged",
    label: "Merged",
    status: "all",
    sort: DEFAULT_SORT,
    dir: DEFAULT_DIR,
    merged: true,
  },
];

function matchView(
  status: string,
  sort: SortKey,
  dir: SortDir,
  merged: boolean,
): RepositoryView | null {
  return (
    REPOSITORY_VIEWS.find(
      (v) =>
        v.status === status &&
        v.sort === sort &&
        v.dir === dir &&
        v.merged === merged,
    ) ?? null
  );
}

function parseSortFromUrl(params: URLSearchParams): { sort: SortKey; dir: SortDir } {
  const raw = params.get(SORT_PARAM) ?? "";
  if (LEGACY_SORT_MAP[raw]) return LEGACY_SORT_MAP[raw];
  if (SORT_KEYS.has(raw as SortKey)) {
    const dirRaw = params.get(DIR_PARAM);
    const dir: SortDir = dirRaw === "desc" ? "desc" : "asc";
    return { sort: raw as SortKey, dir };
  }
  return { sort: DEFAULT_SORT, dir: DEFAULT_DIR };
}

function compareNullable<T>(
  a: T | null | undefined,
  b: T | null | undefined,
  cmp: (x: T, y: T) => number,
  dir: SortDir,
): number {
  const aNull = a == null;
  const bNull = b == null;
  if (aNull && bNull) return 0;
  if (aNull) return 1; // nulls last regardless of direction
  if (bNull) return -1;
  const v = cmp(a as T, b as T);
  return dir === "asc" ? v : -v;
}

function sortContracts(
  rows: ContractListItem[],
  sort: SortKey,
  dir: SortDir,
): ContractListItem[] {
  const out = [...rows];
  const strCmp = (a: string, b: string) => a.localeCompare(b);
  out.sort((a, b) => {
    switch (sort) {
      case "renewal_date":
        return compareNullable(a.renewal_date, b.renewal_date, strCmp, dir);
      case "effective_date":
        return compareNullable(a.effective_date, b.effective_date, strCmp, dir);
      case "counterparty":
        return compareNullable(a.counterparty, b.counterparty, strCmp, dir);
      case "title":
        return compareNullable(a.title, b.title, strCmp, dir);
      case "updated_at":
        return compareNullable(a.updated_at, b.updated_at, strCmp, dir);
      case "created_at":
        return compareNullable(a.created_at, b.created_at, strCmp, dir);
      case "status":
        return compareNullable(a.status, b.status, strCmp, dir);
    }
  });
  return out;
}

export default function ContractsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQ = searchParams.get(Q_PARAM) ?? "";
  const initialStatus = (() => {
    const raw = searchParams.get(STATUS_PARAM) ?? "all";
    return STATUS_VALUES.has(raw) ? raw : "all";
  })();
  const { sort: initialSort, dir: initialDir } = parseSortFromUrl(searchParams);
  const initialMerged = searchParams.get(MERGED_PARAM) === "true";

  const [search, setSearch] = useState(initialQ);
  const [committedSearch, setCommittedSearch] = useState(initialQ);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [typeFilter, setTypeFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>(initialSort);
  const [dir, setDir] = useState<SortDir>(initialDir);
  const [includeMerged, setIncludeMerged] = useState(initialMerged);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(true);
  const [visibleColumns, setVisibleColumns] = useState<Set<RepositoryColumnId>>(
    () => loadVisibleColumnsFromStorage(),
  );
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [overrides, setOverrides] = useState<Record<string, RepositoryOverride>>(
    () => loadOverrides(),
  );
  const [showArchived, setShowArchived] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SHOW_ARCHIVED_LS_KEY) === "true";
    } catch {
      return false;
    }
  });

  function persistShowArchived(next: boolean) {
    try {
      window.localStorage.setItem(SHOW_ARCHIVED_LS_KEY, next ? "true" : "false");
    } catch {
      /* swallow */
    }
  }

  function updateOverride(id: string, patch: RepositoryOverride) {
    setOverrides((prev) => {
      const merged: Record<string, RepositoryOverride> = { ...prev };
      const existing = merged[id] ?? {};
      merged[id] = {
        tags: patch.tags ?? existing.tags,
        archived: patch.archived ?? existing.archived,
        folder: patch.folder ?? existing.folder,
      };
      persistOverrides(merged);
      return merged;
    });
  }

  // Debounce search to URL + fetch.
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

  // Sync URL ?q= to the committed search.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedSearch]);

  // Keep status / sort / dir / merged in sync with URL. Defaults are
  // omitted from the URL to keep /repository clean.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (statusFilter !== "all") next.set(STATUS_PARAM, statusFilter);
    else next.delete(STATUS_PARAM);
    if (sort !== DEFAULT_SORT) next.set(SORT_PARAM, sort);
    else next.delete(SORT_PARAM);
    if (dir !== DEFAULT_DIR) next.set(DIR_PARAM, dir);
    else next.delete(DIR_PARAM);
    if (includeMerged) next.set(MERGED_PARAM, "true");
    else next.delete(MERGED_PARAM);
    const before = searchParams.toString();
    const after = next.toString();
    if (before !== after) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, sort, dir, includeMerged]);

  const activeView = useMemo(
    () => matchView(statusFilter, sort, dir, includeMerged),
    [statusFilter, sort, dir, includeMerged],
  );

  function onSelectView(view: RepositoryView) {
    setStatusFilter(view.status);
    setSort(view.sort);
    setDir(view.dir);
    setIncludeMerged(view.merged);
  }

  function onSortChange(key: SortKey) {
    if (key === sort) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      // First click on a new column sorts ascending — matches the
      // brief's "Renewal date ascending, nulls last" default.
      setDir("asc");
    }
  }

  function toggleColumn(id: RepositoryColumnId) {
    if (REQUIRED_COLUMNS.has(id)) return;
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistVisibleColumns(next);
      return next;
    });
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
    const withOverrides = state.contracts.map((c) =>
      applyOverride(c, overrides[c.id]),
    );
    const rows = withOverrides.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (typeFilter !== "all" && c.mime_type !== typeFilter) return false;
      if (!showArchived && c.archived) return false;
      return true;
    });
    return sortContracts(rows, sort, dir);
  }, [state, statusFilter, typeFilter, sort, dir, overrides, showArchived]);

  const hasActiveFilter =
    committedSearch.trim().length > 0 ||
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    includeMerged;

  function onClearSearch() {
    setSearch("");
    setCommittedSearch("");
  }

  const isDefaultSort = sort === DEFAULT_SORT && dir === DEFAULT_DIR;
  const activeFilterCount =
    (committedSearch.trim() ? 1 : 0) +
    (statusFilter !== "all" ? 1 : 0) +
    (isDefaultSort ? 0 : 1) +
    (typeFilter !== "all" ? 1 : 0) +
    (includeMerged ? 1 : 0);

  function onResetAllFilters() {
    setSearch("");
    setCommittedSearch("");
    setStatusFilter("all");
    setTypeFilter("all");
    setSort(DEFAULT_SORT);
    setDir(DEFAULT_DIR);
    setIncludeMerged(false);
    setShowArchived(false);
    persistShowArchived(false);
  }

  return (
    <div data-testid="repository-page">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-xl text-ink sm:text-2xl">Repository</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Your agreement workspace for drafts, negotiated files, and signed
            records. Machine-generated metadata and text extraction can be
            incomplete and must be reviewed before use.
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
        <div className="relative">
          <button
            type="button"
            onClick={() => setColumnsMenuOpen((v) => !v)}
            className="flex items-center gap-1 rounded border border-rule bg-canvas px-2.5 py-1.5 text-xs text-ink hover:border-rule-strong"
            data-testid="repository-columns-toggle"
            aria-expanded={columnsMenuOpen}
            aria-haspopup="menu"
          >
            Show columns
            <span aria-hidden>▾</span>
          </button>
          {columnsMenuOpen && (
            <div
              className="absolute right-0 z-10 mt-1 w-56 rounded border border-rule bg-canvas p-2 shadow-md"
              role="menu"
              data-testid="repository-columns-menu"
            >
              {REPOSITORY_COLUMNS.map((c) => {
                const checked = visibleColumns.has(c.id);
                const required = REQUIRED_COLUMNS.has(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${
                      required
                        ? "text-ink-subtle"
                        : "text-ink hover:bg-canvas-subtle"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={required}
                      onChange={() => toggleColumn(c.id)}
                      data-testid={`repository-columns-toggle-${c.id}`}
                    />
                    {c.label}
                    {required ? (
                      <span className="ml-auto text-[10px] uppercase">
                        required
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
        </div>
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
              to="/demo/welcome"
              className="inline-flex items-center rounded border border-rule bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:border-rule-strong"
            >
              Finish setup
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

      {state.kind === "loaded" && state.contracts.length > 0 && (() => {
        const loadedContracts = state.contracts;
        const selectedIds = Object.keys(rowSelection).filter(
          (k) => rowSelection[k],
        );
        const selectedRows = filtered.filter((r) => selectedIds.includes(r.id));
        const knownTags = Array.from(
          new Set(filtered.flatMap((r) => r.tags ?? [])),
        ).sort();

        function clearSelection() {
          setRowSelection({});
        }

        function applyTagToSelection(tag: string) {
          for (const id of selectedIds) {
            const baseTags =
              overrides[id]?.tags ??
              loadedContracts.find((c) => c.id === id)?.tags ??
              [];
            const next = Array.from(new Set([...baseTags, tag]));
            updateOverride(id, { tags: next });
          }
        }

        function archiveSelection() {
          for (const id of selectedIds) {
            updateOverride(id, { archived: true, folder: "Archive" });
          }
          clearSelection();
        }

        function moveSelection(folder: RepositoryFolder) {
          for (const id of selectedIds) {
            updateOverride(id, {
              folder,
              archived: folder === "Archive",
            });
          }
          clearSelection();
        }

        function exportSelectionCsv() {
          const visibleIds = new Set<string>(visibleColumns);
          downloadCsv(selectedRows, visibleIds);
        }

        return (
          <>
            {selectedIds.length > 0 && (
              <RepositoryActionBar
                selectedRows={selectedRows}
                knownTags={knownTags}
                onApplyTag={applyTagToSelection}
                onArchive={archiveSelection}
                onMoveToFolder={moveSelection}
                onExportCsv={exportSelectionCsv}
                onCancel={clearSelection}
              />
            )}
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => {
                    setShowArchived(e.target.checked);
                    persistShowArchived(e.target.checked);
                  }}
                  data-testid="repository-show-archived"
                />
                Show archived
              </label>
            </div>
            <ContractTable
              contracts={filtered}
              visibleColumns={visibleColumns}
              sort={sort}
              dir={dir}
              onSortChange={onSortChange}
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
            />
            <p className="mt-3 text-xs text-ink-subtle">
              {filtered.length} of {state.contracts.length} agreements shown
              {committedSearch.trim()
                ? ` for "${committedSearch.trim()}"`
                : ""}
              .
            </p>
            {filtered.length === 0 && (
              <EmptyState
                title="No matches"
                description="No Repository records match the current search, status, type, archived, or merged-record filters."
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
            )}
          </>
        );
      })()}
    </div>
  );
}
