import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

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

type SortOrder = "newest" | "oldest" | "title_asc";

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
];

export default function ContractsPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sort, setSort] = useState<SortOrder>("newest");
  const [includeMerged, setIncludeMerged] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    getContracts({ signal: controller.signal, include_merged: includeMerged })
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
  }, [includeMerged]);

  const types = useMemo(() => {
    if (state.kind !== "loaded") return [];
    const set = new Set(state.contracts.map((c) => c.mime_type));
    return Array.from(set);
  }, [state]);

  const filtered = useMemo(() => {
    if (state.kind !== "loaded") return [];
    const q = search.trim().toLowerCase();
    const rows = state.contracts.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (typeFilter !== "all" && c.mime_type !== typeFilter) return false;
      if (q) {
        const hay = `${c.title} ${c.status} ${mimeLabel(c.mime_type)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sorted = [...rows];
    if (sort === "newest") {
      sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else if (sort === "oldest") {
      sorted.sort((a, b) => a.created_at.localeCompare(b.created_at));
    } else if (sort === "title_asc") {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    }
    return sorted;
  }, [state, search, statusFilter, typeFilter, sort]);

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

      {state.kind === "loaded" && state.contracts.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title…"
            className="flex-1 min-w-[200px] rounded border border-rule bg-canvas px-3 py-1.5 text-sm placeholder:text-ink-subtle focus:border-accent-ring focus:outline-none"
            data-testid="repository-search"
          />
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

      {state.kind === "loaded" && state.contracts.length === 0 && (
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
      )}

      {state.kind === "loaded" && state.contracts.length > 0 && (
        <>
          <ContractTable contracts={filtered} />
          <p className="mt-3 text-xs text-ink-subtle">
            {filtered.length} of {state.contracts.length} agreements shown.
          </p>
          {filtered.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">
              Nothing in the repository matches the current filters.
            </p>
          )}
        </>
      )}
    </div>
  );
}
