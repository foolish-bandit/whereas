import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import {
  ApiError,
  MissingDevUserError,
  createAgreementTemplate,
  listAgreementTemplates,
} from "../lib/api";
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
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Agreement Templates</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Uploaded template originals are the official artifact. Markdown
            snapshots are the lightweight working preview.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-subtle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
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
          className="rounded border border-rule px-2 py-1 text-sm"
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

      {state.kind === "loading" && (
        <p className="text-sm text-ink-muted">Loading templates…</p>
      )}
      {state.kind === "error" && (
        <p className="text-sm text-danger">{state.message}</p>
      )}
      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title="No templates yet"
          description="Create a template above, then upload its DOCX or PDF original. The Markdown preview will appear once conversion succeeds."
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
              <div className="flex items-center justify-between">
                <div>
                  <Link
                    to={`/agreement-templates/${row.id}`}
                    className="font-medium text-ink underline"
                  >
                    {row.name}
                  </Link>
                  <p className="text-xs text-ink-subtle">
                    {row.template_type ?? "Untyped"} · {row.status}
                  </p>
                </div>
              </div>
              {row.description && (
                <p className="mt-2 text-sm text-ink-muted">{row.description}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
