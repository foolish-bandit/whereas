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

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "ready", label: "Ready" },
  { value: "extracting", label: "Extracting" },
  { value: "uploaded", label: "Uploaded" },
  { value: "failed", label: "Extraction failed" },
];

export default function ContractsPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    getContracts({ signal: controller.signal })
      .then((contracts) => setState({ kind: "loaded", contracts }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof MissingDevUserError) {
          setState({
            kind: "error",
            title: "No development user ID configured",
            description:
              "Set a development user ID in Settings before listing contracts.",
          });
          return;
        }
        if (err instanceof ApiError) {
          setState({
            kind: "error",
            title: "Could not load contracts",
            description: err.message,
          });
          return;
        }
        setState({
          kind: "error",
          title: "Could not load contracts",
          description: "An unexpected error occurred.",
        });
      });
    return () => controller.abort();
  }, []);

  const types = useMemo(() => {
    if (state.kind !== "loaded") return [];
    const set = new Set(state.contracts.map((c) => c.mime_type));
    return Array.from(set);
  }, [state]);

  const filtered = useMemo(() => {
    if (state.kind !== "loaded") return [];
    const q = search.trim().toLowerCase();
    return state.contracts.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (typeFilter !== "all" && c.mime_type !== typeFilter) return false;
      if (q) {
        const hay = `${c.title} ${c.status} ${mimeLabel(c.mime_type)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [state, search, statusFilter, typeFilter]);

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-xl text-ink sm:text-2xl">Contracts</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Whereas is an open-source contract repository. Extracted metadata is
            machine-generated and must be reviewed before relying on it.
          </p>
        </div>
        <Link
          to="/demo/upload"
          className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring sm:w-auto sm:py-1.5"
        >
          Upload contract
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
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded border border-rule bg-canvas px-2.5 py-1.5 text-sm text-ink focus:border-accent-ring focus:outline-none"
            aria-label="Filter by status"
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
          >
            <option value="all">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {mimeLabel(t)}
              </option>
            ))}
          </select>
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
          title="No contracts yet."
          description="Upload your first PDF or DOCX to populate the repository."
          action={
            <Link
              to="/demo/upload"
              className="inline-flex w-full items-center justify-center rounded border border-ink bg-ink px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-ring sm:w-auto sm:py-1.5"
            >
              Upload contract
            </Link>
          }
        />
      )}

      {state.kind === "loaded" && state.contracts.length > 0 && (
        <>
          <ContractTable contracts={filtered} />
          <p className="mt-3 text-xs text-ink-subtle">
            {filtered.length} of {state.contracts.length} contracts shown.
          </p>
          {filtered.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">
              No contracts match the current filters.
            </p>
          )}
        </>
      )}
    </div>
  );
}
