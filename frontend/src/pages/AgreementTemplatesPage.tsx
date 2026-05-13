import { useMemo, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import FilterBar from "../components/ui/FilterBar";
import PageHeader from "../components/ui/PageHeader";
import SectionCard from "../components/ui/SectionCard";
import {
  ApiError,
  MissingDevUserError,
  createAgreementTemplate,
  listAgreementTemplates,
} from "../lib/api";
import { formatDate } from "../lib/format";
import { demoPath, mountedPath } from "../lib/routes";
import type { AgreementTemplate } from "../types/agreementTemplates";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; rows: AgreementTemplate[] }
  | { kind: "error"; message: string };

// Canonical group order for the catalog layout
const CANONICAL_GROUPS = [
  "NDA",
  "MSA",
  "DPA",
  "SOW",
  "Vendor",
  "Employment",
] as const;

function resolveGroup(templateType: string | null): string {
  if (!templateType) return "Other";
  const up = templateType.trim().toUpperCase();
  for (const g of CANONICAL_GROUPS) {
    if (up === g.toUpperCase()) return g;
  }
  return templateType.trim();
}

function buildGroups(
  rows: AgreementTemplate[],
): { label: string; rows: AgreementTemplate[] }[] {
  const map = new Map<string, AgreementTemplate[]>();
  for (const row of rows) {
    const g = resolveGroup(row.template_type);
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(row);
  }
  const result: { label: string; rows: AgreementTemplate[] }[] = [];
  for (const g of CANONICAL_GROUPS) {
    if (map.has(g)) {
      result.push({ label: g, rows: map.get(g)! });
      map.delete(g);
    }
  }
  for (const [label, groupRows] of map) {
    result.push({
      label: label === "Other" ? "Other / Unspecified" : label,
      rows: groupRows,
    });
  }
  return result;
}

export default function AgreementTemplatesPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("");
  const [name, setName] = useState("");
  const [templateType, setTemplateType] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => {
    let aborted = false;
    setState({ kind: "loading" });
    listAgreementTemplates({ include_archived: includeArchived })
      .then((rows) => {
        if (!aborted) setState({ kind: "loaded", rows });
      })
      .catch((err) => {
        if (aborted) return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
        } else {
          setState({ kind: "error", message: "Could not load templates." });
        }
      });
    return () => {
      aborted = true;
    };
  }, [includeArchived]);

  async function onCreate() {
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const row = await createAgreementTemplate({
        name: name.trim(),
        template_type: templateType.trim() || null,
        description: description.trim() || null,
      });
      setName("");
      setTemplateType("");
      setDescription("");
      setState((prev) =>
        prev.kind === "loaded"
          ? { kind: "loaded", rows: [row, ...prev.rows] }
          : prev,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not create template.";
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  }

  const distinctTypes = useMemo(() => {
    if (state.kind !== "loaded") return [];
    const types = new Set<string>();
    for (const row of state.rows) {
      if (row.template_type) types.add(row.template_type);
    }
    return Array.from(types).sort();
  }, [state]);

  const filteredRows = useMemo(() => {
    if (state.kind !== "loaded") return [];
    let rows = state.rows;
    if (filterType) rows = rows.filter((r) => r.template_type === filterType);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.description?.toLowerCase().includes(q) ?? false) ||
          (r.template_type?.toLowerCase().includes(q) ?? false),
      );
    }
    return rows;
  }, [state, search, filterType]);

  const groups = useMemo(() => buildGroups(filteredRows), [filteredRows]);

  const hasActiveFilters = search.trim() !== "" || filterType !== "";

  function resetFilters() {
    setSearch("");
    setFilterType("");
  }

  return (
    <div className="space-y-5" data-testid="agreement-templates-page">
      <PageHeader
        title="Agreement Templates"
        description="Reusable starting points for common agreements. Use templates to generate draft language for Requests and Repository records. Template output should always be reviewed by your team."
        eyebrow={
          <nav className="text-xs text-ink-subtle" aria-label="Breadcrumb">
            <Link
              to={demoPath("/requests")}
              className="hover:text-ink"
              data-testid="agreement-templates-breadcrumb-requests"
            >
              Requests
            </Link>
            <span className="mx-1">/</span>
            <span className="text-ink-muted">Agreement Templates</span>
          </nav>
        }
        actions={
          <label className="flex items-center gap-2 text-xs text-ink-subtle">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              data-testid="agreement-templates-include-archived"
            />
            Show archived
          </label>
        }
      />

      <SectionCard title="New template" testId="agreement-templates-create">
        <div className="grid gap-2">
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Template name (e.g. Mutual NDA)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Template type (NDA, MSA, SOW, ...)"
            value={templateType}
            onChange={(e) => setTemplateType(e.target.value)}
          />
          <textarea
            className="min-h-[3rem] rounded border border-rule px-2 py-1 text-sm"
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:opacity-50 sm:w-fit sm:py-1.5"
              onClick={onCreate}
              disabled={creating || !name.trim()}
            >
              {creating ? "Creating…" : "Create template"}
            </button>
            {createError && (
              <span className="text-xs text-danger">{createError}</span>
            )}
          </div>
        </div>
      </SectionCard>

      {state.kind === "loading" && <LoadingSkeleton rows={3} />}
      {state.kind === "error" && (
        <ErrorState
          title="Could not load templates"
          description={state.message}
        />
      )}

      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title={
            includeArchived ? "No archived templates" : "No templates yet"
          }
          description={
            includeArchived
              ? "No archived templates."
              : "Create a template, then upload its DOCX source file to make it usable for generation."
          }
        />
      )}

      {state.kind === "loaded" && state.rows.length > 0 && (
        <div className="space-y-6">
          <FilterBar>
            <input
              type="search"
              className="flex-1 rounded border border-rule px-2 py-1.5 text-sm placeholder:text-ink-subtle"
              placeholder="Search by name, description, or type…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search templates"
              data-testid="agreement-templates-search"
            />
            {distinctTypes.length > 0 && (
              <select
                className="rounded border border-rule px-2 py-1.5 text-sm"
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                aria-label="Filter by template type"
                data-testid="agreement-templates-filter-type"
              >
                <option value="">All types</option>
                {distinctTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
            {hasActiveFilters && (
              <button
                type="button"
                className="rounded border border-rule px-2 py-1.5 text-xs text-ink-muted hover:text-ink"
                onClick={resetFilters}
                data-testid="agreement-templates-reset-filters"
              >
                Reset filters
              </button>
            )}
          </FilterBar>

          {filteredRows.length === 0 ? (
            <EmptyState
              title="No templates match your search"
              description="Try a different search term or reset the filters."
            />
          ) : (
            <div
              className="space-y-8"
              data-testid="agreement-templates-catalog"
            >
              {groups.map((group) => (
                <section
                  key={group.label}
                  data-testid="agreement-templates-group"
                >
                  <h2
                    className="mb-3 text-xs font-semibold uppercase tracking-widest text-ink-subtle"
                    data-testid="agreement-templates-group-heading"
                  >
                    {group.label}
                  </h2>
                  <ul
                    className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                    data-testid="agreement-templates-list"
                  >
                    {group.rows.map((row) => (
                      <li
                        key={row.id}
                        className="flex flex-col gap-3 rounded border border-rule p-4 text-sm"
                        data-testid="agreement-templates-row"
                      >
                        <div className="flex-1 space-y-1">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span
                              className="font-medium text-ink"
                              data-testid="agreement-templates-row-name"
                            >
                              {row.name}
                            </span>
                            <TemplateStatusPill status={row.status} />
                            {row.template_type && (
                              <span
                                className="rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-[10px] text-ink-muted"
                                data-testid="agreement-templates-row-type"
                              >
                                {row.template_type}
                              </span>
                            )}
                          </div>
                          {row.description && (
                            <p className="text-sm text-ink-muted">
                              {row.description}
                            </p>
                          )}
                          <p className="text-[11px] text-ink-subtle">
                            Updated {formatDate(row.updated_at)}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 border-t border-rule pt-3">
                          <Link
                            to={
                              mountedPath(
                                `/requests/templates/${row.id}`,
                                location.pathname,
                              ) + "#generate"
                            }
                            className="flex-1 rounded border border-ink bg-ink px-3 py-1.5 text-center text-xs font-medium text-canvas hover:opacity-90"
                            data-testid="agreement-templates-card-use"
                          >
                            Use this template
                          </Link>
                          <Link
                            to={mountedPath(
                              `/requests/templates/${row.id}`,
                              location.pathname,
                            )}
                            className="rounded border border-rule px-3 py-1.5 text-xs text-ink-muted hover:text-ink"
                            data-testid="agreement-templates-row-link"
                          >
                            Open template
                          </Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TemplateStatusPill({ status }: { status: string }) {
  const cls =
    status === "active"
      ? "bg-success/10 text-success border-success/40"
      : "bg-canvas-muted text-ink-muted border-rule";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
      data-testid="agreement-templates-status-pill"
    >
      {status === "active"
        ? "Active"
        : status === "archived"
          ? "Archived"
          : status}
    </span>
  );
}
