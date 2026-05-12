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
  updateClauseTemplate,
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
 * contract-type organization; PR #120 detail / edit / restore polish).
 *
 * The library is organized **by contract type** (chip bar at the top
 * with active/archived counts per type). Selecting a chip narrows the
 * list and pre-fills the Add-clause form. Each row opens a detail
 * drawer that shows the full clause record and supports Copy, Edit,
 * Archive, and Restore inline — without leaving the list view or
 * dropping the user's current filters.
 *
 * Backend semantics are intentionally untouched. The list, create,
 * update, and delete endpoints already exist; PR #120 only wires up
 * the existing PATCH endpoint to a UI editor + restore action.
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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

  const expandedRow = useMemo(
    () =>
      state.kind === "loaded"
        ? state.rows.find((r) => r.id === expandedId) ?? null
        : null,
    [state, expandedId],
  );

  // If the active drawer's row falls out of the loaded set (e.g.,
  // after archive while "Show archived" is off, or because a fresh
  // load no longer includes it), close the drawer cleanly.
  useEffect(() => {
    if (expandedId && state.kind === "loaded" && !expandedRow) {
      setExpandedId(null);
      setEditingId(null);
      setEditError(null);
    }
  }, [expandedId, state, expandedRow]);

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
      load();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not archive clause.",
      );
    }
  }

  async function onRestore(id: string) {
    setActionError(null);
    try {
      await updateClauseTemplate(id, { is_active: true });
      load();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not restore clause.",
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

  async function onSaveEdit(id: string, patch: EditPatch) {
    setSavingEdit(true);
    setEditError(null);
    try {
      const tags = patch.tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const updated = await updateClauseTemplate(id, {
        name: patch.name.trim(),
        clause_type: patch.clause_type.trim() || "general",
        contract_type: patch.contract_type.trim() || null,
        jurisdiction: patch.jurisdiction.trim() || null,
        description: patch.description.trim() || null,
        text: patch.text,
        tags,
      });
      setState((prev) =>
        prev.kind === "loaded"
          ? {
              kind: "loaded",
              rows: prev.rows.map((r) => (r.id === id ? updated : r)),
            }
          : prev,
      );
      setEditingId(null);
    } catch (err) {
      setEditError(
        err instanceof Error ? err.message : "Could not save clause.",
      );
    } finally {
      setSavingEdit(false);
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
              confirming={confirmId === row.id}
              copied={copiedId === row.id}
              onOpenDetail={() => {
                setExpandedId(row.id);
                setEditingId(null);
                setEditError(null);
              }}
              onAskArchive={() => setConfirmId(row.id)}
              onCancelArchive={() => setConfirmId(null)}
              onConfirmArchive={() => onConfirmArchive(row.id)}
              onRestore={() => onRestore(row.id)}
              onCopy={() => onCopy(row)}
            />
          ))}
        </ul>
      )}

      {expandedRow && (
        <ClauseDetailDrawer
          row={expandedRow}
          editing={editingId === expandedRow.id}
          savingEdit={savingEdit}
          editError={editError}
          copied={copiedId === expandedRow.id}
          onClose={() => {
            setExpandedId(null);
            setEditingId(null);
            setEditError(null);
          }}
          onCopy={() => onCopy(expandedRow)}
          onStartEdit={() => {
            setEditingId(expandedRow.id);
            setEditError(null);
          }}
          onCancelEdit={() => {
            setEditingId(null);
            setEditError(null);
          }}
          onSaveEdit={(patch) => onSaveEdit(expandedRow.id, patch)}
          onAskArchive={() => setConfirmId(expandedRow.id)}
          onConfirmArchive={() => onConfirmArchive(expandedRow.id)}
          onCancelArchive={() => setConfirmId(null)}
          confirmingArchive={confirmId === expandedRow.id}
          onRestore={() => onRestore(expandedRow.id)}
        />
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
  confirming,
  copied,
  onOpenDetail,
  onAskArchive,
  onCancelArchive,
  onConfirmArchive,
  onRestore,
  onCopy,
}: {
  row: ClauseTemplate;
  confirming: boolean;
  copied: boolean;
  onOpenDetail: () => void;
  onAskArchive: () => void;
  onCancelArchive: () => void;
  onConfirmArchive: () => void;
  onRestore: () => void;
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
            onClick={onOpenDetail}
            data-testid="clause-toggle"
          >
            View details
          </button>
          <button
            type="button"
            className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
            onClick={onCopy}
            data-testid="clause-copy"
          >
            {copied ? "Copied" : "Copy text"}
          </button>
          {row.is_active ? (
            confirming ? (
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
            )
          ) : (
            <button
              type="button"
              className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
              onClick={onRestore}
              data-testid="clause-restore"
            >
              Restore
            </button>
          )}
        </div>
      </div>
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

/* -------------------------------------------------------------------- */
/* PR #120 — Clause detail drawer (read / edit / archive / restore).    */
/* -------------------------------------------------------------------- */

interface EditPatch {
  name: string;
  clause_type: string;
  contract_type: string;
  jurisdiction: string;
  description: string;
  text: string;
  tags: string; // comma-separated in the form, split on save
}

function rowToEditPatch(row: ClauseTemplate): EditPatch {
  return {
    name: row.name,
    clause_type: row.clause_type,
    contract_type: row.contract_type ?? "",
    jurisdiction: row.jurisdiction ?? "",
    description: row.description ?? "",
    text: row.text,
    tags: row.tags.join(", "),
  };
}

interface ClauseDetailDrawerProps {
  row: ClauseTemplate;
  editing: boolean;
  savingEdit: boolean;
  editError: string | null;
  copied: boolean;
  confirmingArchive: boolean;
  onClose: () => void;
  onCopy: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (patch: EditPatch) => void;
  onAskArchive: () => void;
  onConfirmArchive: () => void;
  onCancelArchive: () => void;
  onRestore: () => void;
}

function ClauseDetailDrawer({
  row,
  editing,
  savingEdit,
  editError,
  copied,
  confirmingArchive,
  onClose,
  onCopy,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onAskArchive,
  onConfirmArchive,
  onCancelArchive,
  onRestore,
}: ClauseDetailDrawerProps) {
  const [draft, setDraft] = useState<EditPatch>(() => rowToEditPatch(row));

  // Reset the form whenever the drawer switches to a different row or
  // edit mode is (re)entered. Cancel uses the same effect by toggling
  // `editing` off then on, but explicit reset on entry is clearer.
  useEffect(() => {
    if (editing) setDraft(rowToEditPatch(row));
  }, [editing, row]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Clause details"
      className="fixed inset-0 z-40 flex justify-end bg-ink/40"
      data-testid="clause-detail"
      onClick={(e) => {
        // Click on the backdrop closes; clicks inside the panel are
        // stopped below.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex h-full w-full max-w-xl flex-col gap-3 overflow-y-auto bg-canvas p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p
              className="break-words text-base font-semibold text-ink"
              data-testid="clause-detail-title"
            >
              {row.name}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <ClauseStatusPill active={row.is_active} />
              {row.contract_type && (
                <span
                  className="rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-[10px] text-ink-muted"
                  data-testid="clause-detail-contract-type"
                >
                  {contractTypeLabel(row.contract_type)}
                </span>
              )}
              {row.clause_type && (
                <span
                  className="rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-[10px] text-ink-muted"
                  data-testid="clause-detail-clause-type"
                >
                  {row.clause_type}
                </span>
              )}
              {row.jurisdiction && (
                <span
                  className="rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-[10px] text-ink-muted"
                  data-testid="clause-detail-jurisdiction"
                >
                  {row.jurisdiction}
                </span>
              )}
              {row.tags.map((t, i) => (
                <span
                  key={i}
                  className="rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-[10px] text-ink-muted"
                  data-testid="clause-detail-tag"
                >
                  #{t}
                </span>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="rounded border border-rule px-2 py-1 text-xs hover:bg-canvas-muted"
            onClick={onClose}
            data-testid="clause-detail-close"
          >
            Close
          </button>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          {!editing && (
            <>
              <button
                type="button"
                className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                onClick={onCopy}
                data-testid="clause-detail-copy"
              >
                {copied ? "Copied" : "Copy text"}
              </button>
              <button
                type="button"
                className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                onClick={onStartEdit}
                data-testid="clause-detail-edit"
              >
                Edit
              </button>
              {row.is_active ? (
                confirmingArchive ? (
                  <>
                    <button
                      type="button"
                      className="rounded border border-danger bg-danger px-2 py-1 text-canvas"
                      onClick={onConfirmArchive}
                      data-testid="clause-detail-confirm-archive"
                    >
                      Confirm archive
                    </button>
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                      onClick={onCancelArchive}
                      data-testid="clause-detail-cancel-archive"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
                    onClick={onAskArchive}
                    data-testid="clause-detail-archive"
                  >
                    Archive
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                  onClick={onRestore}
                  data-testid="clause-detail-restore"
                >
                  Restore
                </button>
              )}
            </>
          )}
        </div>

        {row.description && !editing && (
          <p
            className="text-sm text-ink-muted"
            data-testid="clause-detail-description"
          >
            {row.description}
          </p>
        )}

        {!editing && (
          <pre
            className="whitespace-pre-wrap break-words rounded border border-rule bg-canvas-subtle p-2 text-sm text-ink-muted"
            data-testid="clause-text"
          >
            {row.text}
          </pre>
        )}

        {!editing && (
          <p className="text-[11px] text-ink-subtle">
            Created {formatDate(row.created_at)} · Updated{" "}
            {formatDate(row.updated_at)}
            {row.version ? ` · v${row.version}` : ""}
            {row.source ? ` · ${row.source}` : ""}
          </p>
        )}

        {editing && (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.name.trim() || !draft.text.trim()) return;
              onSaveEdit(draft);
            }}
            data-testid="clause-edit-form"
          >
            <label className="text-xs text-ink-muted">
              Clause name
              <input
                className="mt-1 w-full rounded border border-rule px-2 py-1.5 text-sm text-ink"
                value={draft.name}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
                data-testid="clause-edit-name"
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-ink-muted">
                Contract type slug
                <input
                  className="mt-1 w-full rounded border border-rule px-2 py-1.5 text-sm text-ink"
                  value={draft.contract_type}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      contract_type: e.target.value,
                    }))
                  }
                  data-testid="clause-edit-contract-type"
                />
              </label>
              <label className="text-xs text-ink-muted">
                Clause type
                <input
                  className="mt-1 w-full rounded border border-rule px-2 py-1.5 text-sm text-ink"
                  value={draft.clause_type}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, clause_type: e.target.value }))
                  }
                  data-testid="clause-edit-type"
                />
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-ink-muted">
                Jurisdiction
                <input
                  className="mt-1 w-full rounded border border-rule px-2 py-1.5 text-sm text-ink"
                  value={draft.jurisdiction}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, jurisdiction: e.target.value }))
                  }
                  data-testid="clause-edit-jurisdiction"
                />
              </label>
              <label className="text-xs text-ink-muted">
                Tags (comma-separated)
                <input
                  className="mt-1 w-full rounded border border-rule px-2 py-1.5 text-sm text-ink"
                  value={draft.tags}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, tags: e.target.value }))
                  }
                  data-testid="clause-edit-tags"
                />
              </label>
            </div>
            <label className="text-xs text-ink-muted">
              Guidance / description
              <textarea
                className="mt-1 min-h-[3rem] w-full rounded border border-rule px-2 py-1.5 text-sm text-ink"
                value={draft.description}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, description: e.target.value }))
                }
                data-testid="clause-edit-description"
              />
            </label>
            <label className="text-xs text-ink-muted">
              Clause text
              <textarea
                className="mt-1 min-h-[8rem] w-full rounded border border-rule px-2 py-1.5 text-sm text-ink"
                value={draft.text}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, text: e.target.value }))
                }
                data-testid="clause-edit-text"
              />
            </label>
            {editError && (
              <p
                className="text-xs text-danger"
                data-testid="clause-edit-error"
              >
                {editError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                className="rounded border border-ink bg-ink px-3 py-1.5 text-xs text-canvas disabled:opacity-50"
                disabled={
                  savingEdit || !draft.name.trim() || !draft.text.trim()
                }
                data-testid="clause-edit-save"
              >
                {savingEdit ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                className="rounded border border-rule px-3 py-1.5 text-xs hover:bg-canvas-muted"
                onClick={onCancelEdit}
                data-testid="clause-edit-cancel"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
