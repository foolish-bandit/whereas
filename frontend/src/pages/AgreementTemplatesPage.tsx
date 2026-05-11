import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
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

export default function AgreementTemplatesPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeArchived, setIncludeArchived] = useState(false);
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

  return (
    <div className="space-y-5" data-testid="agreement-templates-page">
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
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Agreement Templates</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Reusable agreement templates used to start and generate requests.
            Uploaded template originals are the official source file; a text
            preview is the lightweight working copy.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-subtle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            data-testid="agreement-templates-include-archived"
          />
          Show archived
        </label>
      </div>

      <section
        className="grid gap-2 rounded border border-rule p-3"
        data-testid="agreement-templates-create"
      >
        <h2 className="text-sm font-medium text-ink">New template</h2>
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
          {createError && <span className="text-xs text-danger">{createError}</span>}
        </div>
      </section>

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
            includeArchived ? "No templates to show" : "No templates yet"
          }
          description={
            includeArchived
              ? "Create one above. Templates power the start-from-template and generate-agreement flows under Requests."
              : "Create a template above, then upload its DOCX or PDF original. The text preview will appear once conversion succeeds."
          }
        />
      )}
      {state.kind === "loaded" && state.rows.length > 0 && (
        <ul className="space-y-2" data-testid="agreement-templates-list">
          {state.rows.map((row) => (
            <li
              key={row.id}
              className="rounded border border-rule p-3 text-sm"
              data-testid="agreement-templates-row"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Link
                      to={mountedPath(
                        `/requests/templates/${row.id}`,
                        location.pathname,
                      )}
                      className="font-medium text-ink underline hover:text-ink-muted"
                      data-testid="agreement-templates-row-link"
                    >
                      {row.name}
                    </Link>
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
                    <p className="mt-1 text-sm text-ink-muted">
                      {row.description}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-ink-subtle">
                    Updated {formatDate(row.updated_at)}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
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
      {status === "active" ? "Active" : status === "archived" ? "Archived" : status}
    </span>
  );
}
