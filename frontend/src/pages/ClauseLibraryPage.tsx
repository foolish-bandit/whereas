import { useCallback, useEffect, useMemo, useState } from "react";

import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import {
  ApiError,
  MissingDevUserError,
  createClauseTemplate,
  deleteClauseTemplate,
  listClauseTemplates,
  type ClauseTemplateListFilters,
} from "../lib/api";
import { formatDate } from "../lib/format";
import type { ClauseTemplate } from "../types/clauseTemplates";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; rows: ClauseTemplate[] }
  | { kind: "error"; message: string };

interface DraftClause {
  name: string;
  clause_type: string;
  text: string;
}

const EMPTY_DRAFT: DraftClause = { name: "", clause_type: "", text: "" };

/**
 * Clause Manager (PR #63 nav consolidation; PR #80 UX polish).
 *
 * The Clause Manager is the team's library of approved clause language,
 * fallback positions, and reusable drafting guidance. Users mostly
 * browse and search; curators occasionally add new clauses or archive
 * ones that no longer reflect house style.
 *
 * Backend semantics are intentionally untouched in this PR — archive
 * is still soft-delete (`is_active=false`) via the existing endpoint,
 * `include_inactive` flips visibility, and the create payload uses
 * the existing CRUD shape. UI copy reads "Archive" instead of
 * "Deactivate" because that matches Approval-Templates / Policies
 * elsewhere in the app.
 */
export default function ClauseLibraryPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [serverClauseType, setServerClauseType] = useState("");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<DraftClause>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    const filters: ClauseTemplateListFilters = {
      include_inactive: includeArchived,
      clause_type: serverClauseType || undefined,
    };
    listClauseTemplates(filters, { signal: controller.signal })
      .then((rows) => setState({ kind: "loaded", rows }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof MissingDevUserError) {
          setState({
            kind: "error",
            message:
              "No development user ID configured. Set one in Settings before browsing the clause library.",
          });
          return;
        }
        if (err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
          return;
        }
        setState({
          kind: "error",
          message: "Could not load clauses.",
        });
      });
    return () => controller.abort();
  }, [includeArchived, serverClauseType]);

  useEffect(() => load(), [load]);

  const filtered = useMemo(() => {
    if (state.kind !== "loaded") return [] as ClauseTemplate[];
    const q = search.trim().toLowerCase();
    if (!q) return state.rows;
    return state.rows.filter((r) => {
      const hay = `${r.name} ${r.clause_type} ${r.description ?? ""} ${
        r.jurisdiction ?? ""
      } ${r.contract_type ?? ""} ${r.tags.join(" ")} ${r.text}`.toLowerCase();
      return hay.includes(q);
    });
  }, [state, search]);

  async function onCreate() {
    if (!draft.name.trim() || !draft.text.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createClauseTemplate({
        name: draft.name.trim(),
        text: draft.text,
        clause_type: draft.clause_type.trim() || "general",
      });
      setState((prev) =>
        prev.kind === "loaded"
          ? { kind: "loaded", rows: [created, ...prev.rows] }
          : prev,
      );
      setDraft(EMPTY_DRAFT);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Could not create clause.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function onConfirmArchive(id: string) {
    setActionError(null);
    try {
      await deleteClauseTemplate(id);
      setConfirmId(null);
      // Refresh so the row reflects archived state when the toggle is
      // on, or drops out of the list when it's off.
      load();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not archive clause.",
      );
    }
  }

  async function onCopy(row: ClauseTemplate) {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(row.text);
      setCopiedId(row.id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === row.id ? null : current));
      }, 2000);
    } catch {
      // Best-effort; clipboard permission can be denied silently.
    }
  }

  return (
    <div className="space-y-5" data-testid="clause-manager-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Clause Manager</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Approved clauses, fallback language, and reusable drafting
            guidance. Browse the library, search across clause text and
            metadata, and curate what the team can drop into new agreements.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-subtle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            data-testid="clause-include-archived"
          />
          Show archived
        </label>
      </div>

      <section
        className="grid gap-2 rounded border border-rule p-3"
        data-testid="clause-create"
      >
        <h2 className="text-sm font-medium text-ink">Add a clause</h2>
        <input
          className="rounded border border-rule px-2 py-1.5 text-sm"
          placeholder="Name (e.g. Mutual NDA confidentiality clause)"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          data-testid="clause-create-name"
        />
        <input
          className="rounded border border-rule px-2 py-1.5 text-sm"
          placeholder="Clause type (e.g. confidentiality, governing_law)"
          value={draft.clause_type}
          onChange={(e) =>
            setDraft((d) => ({ ...d, clause_type: e.target.value }))
          }
          data-testid="clause-create-type"
        />
        <textarea
          className="min-h-[6rem] w-full rounded border border-rule px-2 py-1.5 text-sm"
          placeholder="Approved clause text"
          value={draft.text}
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
          data-testid="clause-create-text"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:opacity-50 sm:w-fit sm:py-1.5"
            onClick={onCreate}
            disabled={creating || !draft.name.trim() || !draft.text.trim()}
            data-testid="clause-create-submit"
          >
            {creating ? "Adding…" : "Add clause"}
          </button>
          {createError && (
            <span
              className="text-xs text-danger"
              data-testid="clause-create-error"
            >
              {createError}
            </span>
          )}
        </div>
      </section>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <input
          className="w-full min-w-0 flex-1 rounded border border-rule px-2 py-1.5 text-sm sm:w-auto"
          placeholder="Search name, type, jurisdiction, tags, text…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="clause-search"
        />
        <input
          className="w-full min-w-0 flex-1 rounded border border-rule px-2 py-1.5 text-sm sm:w-auto"
          placeholder="Filter by clause type"
          value={serverClauseType}
          onChange={(e) => setServerClauseType(e.target.value)}
          data-testid="clause-filter-type"
        />
      </div>

      {actionError && (
        <ErrorState title="Action failed" description={actionError} />
      )}

      {state.kind === "loading" && <LoadingSkeleton rows={3} />}
      {state.kind === "error" && (
        <ErrorState title="Could not load clauses" description={state.message} />
      )}
      {state.kind === "loaded" && filtered.length === 0 && (
        <EmptyState
          title={search ? "No clauses match your search" : "No clauses yet"}
          description={
            search
              ? "Try a different search term or clear the filter."
              : "Add a clause above to start building the library."
          }
        />
      )}
      {state.kind === "loaded" && filtered.length > 0 && (
        <ul className="space-y-2" data-testid="clause-list">
          {filtered.map((row) => (
            <ClauseRow
              key={row.id}
              row={row}
              expanded={expandedId === row.id}
              confirming={confirmId === row.id}
              copied={copiedId === row.id}
              onToggleExpand={() =>
                setExpandedId((prev) => (prev === row.id ? null : row.id))
              }
              onAskArchive={() => setConfirmId(row.id)}
              onCancelArchive={() => setConfirmId(null)}
              onConfirmArchive={() => onConfirmArchive(row.id)}
              onCopy={() => onCopy(row)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ClauseRow({
  row,
  expanded,
  confirming,
  copied,
  onToggleExpand,
  onAskArchive,
  onCancelArchive,
  onConfirmArchive,
  onCopy,
}: {
  row: ClauseTemplate;
  expanded: boolean;
  confirming: boolean;
  copied: boolean;
  onToggleExpand: () => void;
  onAskArchive: () => void;
  onCancelArchive: () => void;
  onConfirmArchive: () => void;
  onCopy: () => void;
}) {
  return (
    <li
      className="rounded border border-rule p-3"
      data-testid="clause-row"
      data-clause-id={row.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="break-words font-medium text-ink">{row.name}</p>
            <ClauseStatusPill active={row.is_active} />
          </div>
          {row.description && (
            <p className="mt-1 text-sm text-ink-muted">{row.description}</p>
          )}
          <ClauseMetadataChips row={row} />
          <p className="mt-1 text-[11px] text-ink-subtle">
            Updated {formatDate(row.updated_at)}
            {row.version ? ` · v${row.version}` : ""}
            {row.source ? ` · ${row.source}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 text-xs">
          <button
            type="button"
            className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
            onClick={onToggleExpand}
            data-testid="clause-toggle"
          >
            {expanded ? "Hide text" : "Show text"}
          </button>
          <button
            type="button"
            className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
            onClick={onCopy}
            data-testid="clause-copy"
          >
            {copied ? "Copied" : "Copy text"}
          </button>
          {row.is_active &&
            (confirming ? (
              <>
                <button
                  type="button"
                  className="rounded border border-danger bg-danger px-2 py-1 text-canvas"
                  onClick={onConfirmArchive}
                  data-testid="clause-confirm-archive"
                >
                  Confirm archive
                </button>
                <button
                  type="button"
                  className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                  onClick={onCancelArchive}
                  data-testid="clause-cancel-archive"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
                onClick={onAskArchive}
                data-testid="clause-archive"
              >
                Archive
              </button>
            ))}
        </div>
      </div>
      {expanded && (
        <pre
          className="mt-3 whitespace-pre-wrap break-words rounded border border-rule bg-canvas-subtle p-2 text-sm text-ink-muted"
          data-testid="clause-text"
        >
          {row.text}
        </pre>
      )}
    </li>
  );
}

function ClauseStatusPill({ active }: { active: boolean }) {
  const cls = active
    ? "bg-success/10 text-success border-success/40"
    : "bg-canvas-muted text-ink-muted border-rule";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
      data-testid="clause-status-pill"
    >
      {active ? "Active" : "Archived"}
    </span>
  );
}

function ClauseMetadataChips({ row }: { row: ClauseTemplate }) {
  const chips: { label: string; testId: string }[] = [];
  if (row.clause_type) {
    chips.push({ label: row.clause_type, testId: "clause-chip-type" });
  }
  if (row.jurisdiction) {
    chips.push({ label: row.jurisdiction, testId: "clause-chip-jurisdiction" });
  }
  if (row.contract_type) {
    chips.push({
      label: row.contract_type,
      testId: "clause-chip-contract-type",
    });
  }
  for (const tag of row.tags) {
    chips.push({ label: `#${tag}`, testId: "clause-chip-tag" });
  }
  if (chips.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {chips.map((chip, idx) => (
        <span
          key={`${chip.testId}-${idx}`}
          className="rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-[10px] text-ink-muted"
          data-testid={chip.testId}
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
}
