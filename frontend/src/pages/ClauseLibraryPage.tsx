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
  contract_type: string;
  text: string;
}

const EMPTY_DRAFT: DraftClause = {
  name: "",
  clause_type: "",
  contract_type: "",
  text: "",
};

/**
 * PR #119 — contract-type-friendly display labels.
 *
 * The backend stores `contract_type` as a free string (typically a
 * lowercase slug like `mutual_nda` or `vendor_agreement`). Summize's
 * pattern is to surface the user-friendly name in the UI. We keep the
 * raw slug as the source of truth so audit/search still works, and
 * use this mapping only for chip labels and the contract-type picker.
 */
const CONTRACT_TYPE_LABELS: Record<string, string> = {
  mutual_nda: "NDA",
  unilateral_nda: "NDA",
  nda: "NDA",
  msa: "MSA",
  vendor_agreement: "Vendor agreement",
  customer_contract: "Customer contract",
  employment_agreement: "Employment agreement",
  dpa: "DPA",
  lease: "Lease",
};

function contractTypeLabel(raw: string | null | undefined): string {
  if (!raw) return "Other";
  return CONTRACT_TYPE_LABELS[raw.toLowerCase()] ?? raw;
}

/**
 * Clause Manager (PR #63 nav consolidation; PR #80 UX polish; PR #119
 * contract-type organization).
 *
 * The library is now organized **by contract type**. A chip bar at
 * the top groups clauses by `contract_type` and shows active /
 * archived counts per type. Selecting a chip narrows the list to
 * that type and pre-fills the Add-clause form so curators don't have
 * to retype it.
 *
 * Backend semantics are intentionally untouched. The list endpoint
 * already accepts `contract_type` as a filter, but we apply it
 * client-side here so the chip counts stay accurate without a second
 * fetch.
 */
export default function ClauseLibraryPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [serverClauseType, setServerClauseType] = useState("");
  const [selectedContractType, setSelectedContractType] = useState<string>("");
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

  // Pre-fill the Add-clause form's contract_type whenever the
  // selected contract type changes. Leave the user's other edits
  // alone — only the contract_type field follows the chip.
  useEffect(() => {
    setDraft((d) => ({ ...d, contract_type: selectedContractType }));
  }, [selectedContractType]);

  const rows = state.kind === "loaded" ? state.rows : [];

  /**
   * Distinct contract-type keys (lowercased slug, or empty string for
   * "Other" / null) present in the currently loaded set, ordered by
   * count descending so the most-populated types lead the chip bar.
   */
  const contractTypeGroups = useMemo(() => {
    const counts = new Map<
      string,
      { active: number; archived: number }
    >();
    for (const r of rows) {
      const key = (r.contract_type ?? "").toLowerCase();
      const slot = counts.get(key) ?? { active: 0, archived: 0 };
      if (r.is_active) slot.active += 1;
      else slot.archived += 1;
      counts.set(key, slot);
    }
    return Array.from(counts.entries())
      .map(([key, c]) => ({
        key,
        label: contractTypeLabel(key || null),
        active: c.active,
        archived: c.archived,
      }))
      .sort(
        (a, b) =>
          b.active + b.archived - (a.active + a.archived) ||
          a.label.localeCompare(b.label),
      );
  }, [rows]);

  const filtered = useMemo(() => {
    if (state.kind !== "loaded") return [] as ClauseTemplate[];
    const q = search.trim().toLowerCase();
    return state.rows.filter((r) => {
      if (selectedContractType) {
        const rowKey = (r.contract_type ?? "").toLowerCase();
        if (rowKey !== selectedContractType) return false;
      }
      if (!q) return true;
      const hay = `${r.name} ${r.clause_type} ${r.description ?? ""} ${
        r.jurisdiction ?? ""
      } ${r.contract_type ?? ""} ${r.tags.join(" ")} ${r.text}`.toLowerCase();
      return hay.includes(q);
    });
  }, [state, search, selectedContractType]);

  async function onCreate() {
    if (!draft.name.trim() || !draft.text.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createClauseTemplate({
        name: draft.name.trim(),
        text: draft.text,
        clause_type: draft.clause_type.trim() || "general",
        contract_type: draft.contract_type.trim() || null,
      });
      setState((prev) =>
        prev.kind === "loaded"
          ? { kind: "loaded", rows: [created, ...prev.rows] }
          : prev,
      );
      setDraft({ ...EMPTY_DRAFT, contract_type: selectedContractType });
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

  const filtersActive =
    search.trim() !== "" || serverClauseType !== "" || selectedContractType !== "";

  return (
    <div className="space-y-5" data-testid="clause-manager-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Clause Manager</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Approved clauses, fallback language, and reusable drafting
            guidance. Organized by contract type so curators can grow each
            library independently. Clause/playbook integration is future
            work.
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

      <ContractTypeChipBar
        groups={contractTypeGroups}
        selected={selectedContractType}
        totalActive={rows.filter((r) => r.is_active).length}
        totalArchived={rows.filter((r) => !r.is_active).length}
        onSelect={setSelectedContractType}
      />

      <section
        className="grid gap-2 rounded border border-rule p-3"
        data-testid="clause-create"
      >
        <h2 className="text-sm font-medium text-ink">
          {selectedContractType
            ? `Add a clause to ${contractTypeLabel(selectedContractType)}`
            : "Add a clause"}
        </h2>
        <input
          className="rounded border border-rule px-2 py-1.5 text-sm"
          placeholder="Name (e.g. Mutual NDA confidentiality clause)"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          data-testid="clause-create-name"
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            className="rounded border border-rule px-2 py-1.5 text-sm"
            placeholder="Clause type (e.g. confidentiality, governing_law)"
            value={draft.clause_type}
            onChange={(e) =>
              setDraft((d) => ({ ...d, clause_type: e.target.value }))
            }
            data-testid="clause-create-type"
          />
          <input
            className="rounded border border-rule px-2 py-1.5 text-sm"
            placeholder="Contract type slug (e.g. mutual_nda, msa)"
            value={draft.contract_type}
            onChange={(e) =>
              setDraft((d) => ({ ...d, contract_type: e.target.value }))
            }
            data-testid="clause-create-contract-type"
          />
        </div>
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
        {filtersActive && (
          <button
            type="button"
            className="rounded border border-rule px-2 py-1.5 text-xs text-ink-muted hover:bg-canvas-muted"
            onClick={() => {
              setSearch("");
              setServerClauseType("");
              setSelectedContractType("");
            }}
            data-testid="clause-reset-filters"
          >
            Reset filters
          </button>
        )}
      </div>

      {actionError && (
        <ErrorState title="Action failed" description={actionError} />
      )}

      {state.kind === "loading" && <LoadingSkeleton rows={3} />}
      {state.kind === "error" && (
        <ErrorState title="Could not load clauses" description={state.message} />
      )}
      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title="No clauses yet"
          description="Add a clause above to start the Clause Manager library for fallback language, playbooks, and negotiation standards."
        />
      )}
      {state.kind === "loaded" && state.rows.length > 0 && filtered.length === 0 && (
        <EmptyState
          title={
            search
              ? "No clauses match your search"
              : selectedContractType
                ? `No clauses for ${contractTypeLabel(selectedContractType)}`
                : "No clauses match the current filters"
          }
          description={
            search
              ? "Try a different search term or clear the filter."
              : selectedContractType
                ? "Add a clause to this contract type or pick another contract type from the chips above."
                : "Try a different filter or clear the active filters."
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

interface ContractTypeChipBarProps {
  groups: { key: string; label: string; active: number; archived: number }[];
  selected: string;
  totalActive: number;
  totalArchived: number;
  onSelect: (key: string) => void;
}

function ContractTypeChipBar({
  groups,
  selected,
  totalActive,
  totalArchived,
  onSelect,
}: ContractTypeChipBarProps) {
  return (
    <nav
      aria-label="Contract type"
      className="flex flex-wrap gap-2"
      data-testid="clause-contract-type-bar"
    >
      <ChipButton
        active={selected === ""}
        onClick={() => onSelect("")}
        data-testid="clause-contract-type-all"
      >
        All contract types
        <ChipCount active={totalActive} archived={totalArchived} />
      </ChipButton>
      {groups.map((g) => (
        <ChipButton
          key={g.key || "__other__"}
          active={selected === g.key}
          onClick={() => onSelect(g.key)}
          data-testid="clause-contract-type-chip"
          data-contract-type-key={g.key || "__other__"}
        >
          {g.label}
          <ChipCount active={g.active} archived={g.archived} />
        </ChipButton>
      ))}
    </nav>
  );
}

function ChipButton({
  active,
  onClick,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  "data-testid"?: string;
  "data-contract-type-key"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-ink bg-ink text-canvas"
          : "border-rule bg-canvas text-ink-muted hover:bg-canvas-muted"
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}

function ChipCount({
  active,
  archived,
}: {
  active: number;
  archived: number;
}) {
  return (
    <span
      className="rounded-full border border-rule bg-canvas/60 px-1.5 py-0.5 text-[10px] font-normal text-ink-muted"
      data-testid="clause-contract-type-count"
    >
      {active}
      {archived > 0 ? ` · ${archived} archived` : ""}
    </span>
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
      label: contractTypeLabel(row.contract_type),
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
