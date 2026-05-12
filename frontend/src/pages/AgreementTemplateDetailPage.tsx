import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import {
  ApiError,
  MissingDevUserError,
  archiveAgreementTemplate,
  createAgreementTemplateVariable,
  deleteAgreementTemplateVariable,
  generateAgreementFromTemplate,
  getAgreementTemplate,
  getAgreementTemplateArtifacts,
  getAgreementTemplateMarkdown,
  listAgreementTemplateVariableSuggestions,
  listAgreementTemplateVariables,
  uploadAgreementTemplateArtifact,
} from "../lib/api";
import { artifactDisplayLabel } from "../lib/artifacts";
import { formatDate, mimeLabel } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import { mountedPath } from "../lib/routes";
import type {
  AgreementGenerationResponse,
  AgreementTemplate,
  AgreementTemplateArtifact,
  AgreementTemplateMarkdownSnapshot,
  AgreementTemplateVariable,
  TemplateVariableSuggestion,
} from "../types/agreementTemplates";

interface PageState {
  template: AgreementTemplate | null;
  artifacts: AgreementTemplateArtifact[];
  markdown: AgreementTemplateMarkdownSnapshot | null;
  variables: AgreementTemplateVariable[];
  suggestions: TemplateVariableSuggestion[];
}

const EMPTY: PageState = {
  template: null,
  artifacts: [],
  markdown: null,
  variables: [],
  suggestions: [],
};

/**
 * Agreement Template detail / builder page (PR #94 polish).
 *
 * Organized into discrete sections so a non-engineer can scan and act
 * without reading the whole page:
 *
 *   - Header     — name, status pill, type, dates, breadcrumb.
 *   - Source     — upload affordance + user-friendly artifact list.
 *   - Text       — Markdown-rendered Text preview (existing).
 *   - Variables  — builder list with required/optional indicator.
 *   - Generate   — variable form, required-first, with a "missing
 *                  required fields" warning before submit, success
 *                  state that links to the new Repository record.
 *   - Archive    — two-step confirm on active templates only.
 *
 * Backend semantics from PRs #37 / #42 are untouched: variable values
 * are only used to render the generated DOCX and are NOT persisted in
 * the template's ``metadata_json`` — the in-page warning copy
 * documents that contract.
 */
export default function AgreementTemplateDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const location = useLocation();
  const [state, setState] = useState<PageState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Variable builder form state.
  const [varKey, setVarKey] = useState("");
  const [varLabel, setVarLabel] = useState("");
  const [varType, setVarType] = useState("text");
  const [varRequired, setVarRequired] = useState(false);
  const [varError, setVarError] = useState<string | null>(null);

  // PR #96 — suggestions ("Detected placeholders"). Per-suggestion
  // "required" toggle so the user can pick the default required flag
  // before pressing Add. ``suggestionPending`` is the key of the
  // suggestion currently being added; ``suggestionError`` surfaces
  // the most-recent failure on the section.
  const [suggestionRequired, setSuggestionRequired] = useState<
    Record<string, boolean>
  >({});
  const [suggestionPending, setSuggestionPending] = useState<string | null>(
    null,
  );
  const [suggestionError, setSuggestionError] = useState<string | null>(null);

  // Generation form state.
  const [genTitle, setGenTitle] = useState("");
  const [genValues, setGenValues] = useState<Record<string, string>>({});
  const [genAttempted, setGenAttempted] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genResult, setGenResult] = useState<AgreementGenerationResponse | null>(
    null,
  );
  // PR #97 — two-step generation. ``reviewing`` toggles the inline
  // review panel below the form; the generation endpoint is only
  // called on the panel's final "Generate agreement" button. The
  // variable values stay in component state for the duration of the
  // review and are never persisted anywhere (they're sent verbatim
  // as the transient request body to /generate and forgotten).
  const [reviewing, setReviewing] = useState(false);

  // Archive confirm.
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [template, artifacts, markdown, variables, suggestions] =
        await Promise.all([
          getAgreementTemplate(id),
          getAgreementTemplateArtifacts(id),
          getAgreementTemplateMarkdown(id),
          listAgreementTemplateVariables(id),
          // PR #96 — suggestions are best-effort: a backend that
          // hasn't shipped this endpoint yet (or a template with no
          // Text preview) just leaves the section empty.
          listAgreementTemplateVariableSuggestions(id).catch(() => []),
        ]);
      setState({ template, artifacts, markdown, variables, suggestions });
    } catch (err) {
      if (err instanceof MissingDevUserError || err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Could not load this template.");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (id) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function onUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      await uploadAgreementTemplateArtifact(id, file);
      await reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed.";
      setUploadError(message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function onCreateVariable() {
    if (!varKey.trim() || !varLabel.trim()) return;
    setVarError(null);
    try {
      const created = await createAgreementTemplateVariable(id, {
        key: varKey.trim(),
        label: varLabel.trim(),
        variable_type: varType,
        required: varRequired,
        sort_order: state.variables.length,
      });
      setState((prev) => ({
        ...prev,
        variables: [...prev.variables, created],
        // The just-added variable should no longer surface as a
        // suggestion — drop it from the in-memory list immediately.
        suggestions: prev.suggestions.filter(
          (s) => s.key.toLowerCase() !== created.key.toLowerCase(),
        ),
      }));
      setVarKey("");
      setVarLabel("");
      setVarRequired(false);
    } catch (err) {
      setVarError(
        err instanceof Error ? err.message : "Could not add variable.",
      );
    }
  }

  async function onAddSuggestion(
    suggestion: TemplateVariableSuggestion,
    required: boolean,
  ) {
    setSuggestionPending(suggestion.key);
    setSuggestionError(null);
    try {
      const created = await createAgreementTemplateVariable(id, {
        key: suggestion.key,
        label: suggestion.label,
        variable_type: "text",
        required,
        sort_order: state.variables.length,
      });
      setState((prev) => ({
        ...prev,
        variables: [...prev.variables, created],
        suggestions: prev.suggestions.filter(
          (s) => s.key.toLowerCase() !== suggestion.key.toLowerCase(),
        ),
      }));
    } catch (err) {
      setSuggestionError(
        err instanceof Error ? err.message : "Could not add suggestion.",
      );
    } finally {
      setSuggestionPending(null);
    }
  }

  async function onDeleteVariable(variableId: string) {
    await deleteAgreementTemplateVariable(id, variableId);
    setState((prev) => ({
      ...prev,
      variables: prev.variables.filter((v) => v.id !== variableId),
    }));
  }

  function onOpenReview() {
    // The review panel always opens (so missing-required users see
    // the full summary), but it gates the final Generate button on
    // missing-required state. Setting ``genAttempted`` here makes
    // the inline form warning consistent with the panel's gate.
    setGenAttempted(true);
    setGenError(null);
    setReviewing(true);
  }

  function onBackToEdit() {
    setReviewing(false);
    setGenError(null);
  }

  async function onConfirmGenerate() {
    if (missingRequiredKeys.length > 0) return;
    setGenerating(true);
    setGenError(null);
    setGenResult(null);
    try {
      const result = await generateAgreementFromTemplate(id, {
        title: genTitle.trim() || undefined,
        variable_values: genValues,
      });
      setGenResult(result);
      setReviewing(false);
    } catch (err) {
      setGenError(
        err instanceof Error ? err.message : "Could not generate agreement.",
      );
    } finally {
      setGenerating(false);
    }
  }

  async function onConfirmArchive() {
    setArchiveError(null);
    setArchiving(true);
    try {
      await archiveAgreementTemplate(id);
      setConfirmingArchive(false);
      await reload();
    } catch (err) {
      setArchiveError(
        err instanceof Error ? err.message : "Could not archive this template.",
      );
    } finally {
      setArchiving(false);
    }
  }

  const sortedVariables = useMemo(() => {
    return [...state.variables].sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1;
      return a.sort_order - b.sort_order;
    });
  }, [state.variables]);

  const missingRequiredKeys = useMemo(() => {
    return sortedVariables
      .filter((v) => v.required)
      .filter((v) => {
        const raw = (genValues[v.key] ?? v.default_value ?? "").trim();
        return raw === "";
      })
      .map((v) => v.key);
  }, [sortedVariables, genValues]);

  const templatesListPath = mountedPath(
    "/requests/templates",
    location.pathname,
  );

  if (loading && !state.template) {
    return (
      <div className="space-y-4" data-testid="agreement-template-detail">
        <Link
          to={templatesListPath}
          className="text-xs text-ink-muted hover:text-ink"
        >
          ← All templates
        </Link>
        <LoadingSkeleton rows={5} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-4" data-testid="agreement-template-detail">
        <Link
          to={templatesListPath}
          className="text-xs text-ink-muted hover:text-ink"
        >
          ← All templates
        </Link>
        <ErrorState
          title="Could not load this template"
          description={error}
        />
      </div>
    );
  }
  if (!state.template) return null;

  const t = state.template;
  const hasOriginalUpload = state.artifacts.some(
    (a) => a.artifact_type === "original_upload",
  );
  const requiredVariables = sortedVariables.filter((v) => v.required);
  const optionalVariables = sortedVariables.filter((v) => !v.required);

  return (
    <div className="space-y-5" data-testid="agreement-template-detail">
      <nav className="text-xs text-ink-subtle" aria-label="Breadcrumb">
        <Link
          to={mountedPath("/requests", location.pathname)}
          className="hover:text-ink"
          data-testid="agreement-template-breadcrumb-requests"
        >
          Requests
        </Link>
        <span className="mx-1">/</span>
        <Link
          to={templatesListPath}
          className="hover:text-ink"
          data-testid="agreement-template-breadcrumb-templates"
        >
          Agreement Templates
        </Link>
        <span className="mx-1">/</span>
        <span className="text-ink-muted">{t.name}</span>
      </nav>

      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-lg font-semibold text-ink">{t.name}</h1>
          <TemplateStatusPill status={t.status} />
          {t.template_type && (
            <span
              className="rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted"
              data-testid="agreement-template-type-chip"
            >
              {t.template_type}
            </span>
          )}
        </div>
        <p className="text-[11px] text-ink-subtle">
          Updated {formatDate(t.updated_at)}
        </p>
        {t.description && (
          <p className="mt-2 max-w-2xl text-sm text-ink-muted">
            {t.description}
          </p>
        )}
      </header>

      <section
        className="rounded border border-rule p-4"
        data-testid="agreement-template-upload"
      >
        <h2 className="text-sm font-medium text-ink">Template source file</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Upload the DOCX or PDF that operators distribute. The original is
          the official source file; a text preview is generated for fast
          skimming. The template's source file is not modified when an
          agreement is generated.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
            data-testid="agreement-template-file-input"
          />
          {uploading && (
            <span className="text-xs text-ink-muted">Uploading…</span>
          )}
          {uploadError && (
            <span
              className="text-xs text-danger"
              data-testid="agreement-template-upload-error"
            >
              {uploadError}
            </span>
          )}
        </div>
        {state.artifacts.length === 0 ? (
          <p
            className="mt-3 text-xs text-ink-subtle"
            data-testid="agreement-template-upload-empty"
          >
            No source file uploaded yet.
          </p>
        ) : (
          <ul
            className="mt-3 space-y-1 text-xs text-ink-muted"
            data-testid="agreement-template-artifact-list"
          >
            {state.artifacts.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-baseline gap-2"
                data-testid="agreement-template-artifact"
              >
                <span className="font-medium text-ink">
                  {artifactDisplayLabel(a.artifact_type, a.source)}
                </span>
                {a.filename && <span>{a.filename}</span>}
                <span className="text-ink-subtle">
                  Added {formatDate(a.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SourceHistorySection artifacts={state.artifacts} />

      <section
        className="overflow-hidden rounded border border-rule"
        data-testid="agreement-template-markdown"
      >
        <header className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
          <h2 className="text-sm font-medium text-ink">Text preview</h2>
          <p className="mt-0.5 text-xs text-ink-subtle">
            Working copy. The original DOCX/PDF remains the official source
            file.
          </p>
        </header>
        {state.markdown ? (
          <article
            className="px-4 py-4 font-serif text-ink sm:px-6 sm:py-5"
            data-testid="agreement-template-markdown-body"
          >
            {renderMarkdown(state.markdown.markdown_text)}
          </article>
        ) : (
          <div
            className="px-4 py-5"
            data-testid="agreement-template-markdown-empty"
          >
            <EmptyState
              title="No text preview yet"
              description="Upload an original DOCX or PDF and the text preview will appear once conversion succeeds."
            />
          </div>
        )}
      </section>

      <section
        className="rounded border border-rule p-4"
        data-testid="agreement-template-variables"
      >
        <h2 className="text-sm font-medium text-ink">Variables</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Define the placeholders the generated agreement should fill in.
          Required variables must be supplied to generate; optional
          variables fall back to their default value (or stay blank).
        </p>

        <div
          className="mt-3 rounded border border-rule bg-canvas-subtle p-3"
          data-testid="agreement-template-suggestions"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-xs font-medium text-ink">
              Detected placeholders
            </h3>
            <p className="text-[11px] text-ink-subtle">
              Found by scanning the Text preview for{" "}
              <code className="font-mono text-[11px]">{"{{ name }}"}</code>{" "}
              patterns. Adding a suggestion does not change the template
              source.
            </p>
          </div>
          {suggestionError && (
            <p
              className="mt-2 text-xs text-danger"
              data-testid="agreement-template-suggestions-error"
            >
              {suggestionError}
            </p>
          )}
          {state.suggestions.length === 0 ? (
            <p
              className="mt-2 text-xs text-ink-subtle"
              data-testid="agreement-template-suggestions-empty"
            >
              No placeholders detected.
            </p>
          ) : (
            <ul
              className="mt-2 space-y-1"
              data-testid="agreement-template-suggestions-list"
            >
              {state.suggestions.map((s) => {
                const required = suggestionRequired[s.key] ?? false;
                const pending = suggestionPending === s.key;
                return (
                  <li
                    key={s.key}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-rule bg-canvas px-3 py-2 text-sm"
                    data-testid="agreement-template-suggestion-row"
                    data-suggestion-key={s.key}
                  >
                    <div className="min-w-0 break-words">
                      <span className="font-medium text-ink">{s.label}</span>
                      <span className="ml-2 font-mono text-[11px] text-ink-subtle">
                        {s.key}
                      </span>
                      <span className="ml-2 text-[11px] text-ink-subtle">
                        {s.occurrences}×
                      </span>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-3 text-xs">
                      <label className="flex items-center gap-1 text-ink-muted">
                        <input
                          type="checkbox"
                          checked={required}
                          onChange={(e) =>
                            setSuggestionRequired((prev) => ({
                              ...prev,
                              [s.key]: e.target.checked,
                            }))
                          }
                          data-testid={`agreement-template-suggestion-required-${s.key}`}
                        />
                        Required
                      </label>
                      <button
                        type="button"
                        className="rounded border border-ink bg-ink px-2 py-1 text-xs text-canvas disabled:opacity-50"
                        onClick={() => onAddSuggestion(s, required)}
                        disabled={pending}
                        data-testid={`agreement-template-suggestion-add-${s.key}`}
                      >
                        {pending ? "Adding…" : "Add as variable"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="key (e.g. counterparty_name)"
            value={varKey}
            onChange={(e) => setVarKey(e.target.value)}
          />
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Label"
            value={varLabel}
            onChange={(e) => setVarLabel(e.target.value)}
          />
          <select
            className="rounded border border-rule px-2 py-1 text-sm"
            value={varType}
            onChange={(e) => setVarType(e.target.value)}
          >
            <option value="text">text</option>
            <option value="date">date</option>
            <option value="number">number</option>
            <option value="money">money</option>
            <option value="select">select</option>
            <option value="boolean">boolean</option>
            <option value="party">party</option>
            <option value="address">address</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={varRequired}
              onChange={(e) => setVarRequired(e.target.checked)}
            />
            Required
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:opacity-50 sm:w-auto sm:py-1.5"
            onClick={onCreateVariable}
            disabled={!varKey.trim() || !varLabel.trim()}
          >
            Add variable
          </button>
          {varError && <span className="text-xs text-danger">{varError}</span>}
        </div>

        {sortedVariables.length === 0 ? (
          <EmptyState
            title="No variables defined"
            description="Add one above. Variables become fields in the generation form below."
          />
        ) : (
          <ul className="mt-4 space-y-1">
            {sortedVariables.map((v) => (
              <li
                key={v.id}
                className="flex flex-wrap items-start justify-between gap-2 rounded border border-rule px-3 py-2 text-sm"
                data-testid="agreement-template-variable-row"
                data-required={v.required ? "true" : "false"}
              >
                <div className="min-w-0 break-words">
                  <span className="text-ink">{v.label}</span>
                  <span className="ml-2 text-xs text-ink-subtle">
                    {v.variable_type}
                  </span>
                  {v.required && (
                    <span
                      className="ml-2 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-danger"
                      data-testid="agreement-template-variable-required-chip"
                    >
                      Required
                    </span>
                  )}
                  <p className="mt-0.5 text-[11px] text-ink-subtle">
                    Key <span className="font-mono">{v.key}</span>
                    {v.help_text ? ` · ${v.help_text}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-xs text-danger underline"
                  onClick={() => onDeleteVariable(v.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="rounded border border-rule p-4"
        data-testid="agreement-template-generate"
      >
        <h2 className="text-sm font-medium text-ink">Generate agreement</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Render a draft agreement from this template and the variable
          values below. The generated agreement becomes a Repository
          record; the template's source file is not modified.
        </p>
        <p className="mt-1 text-xs text-ink-subtle">
          <span className="font-medium text-ink">Privacy:</span> the values
          you enter are only sent to the generation endpoint to render the
          agreement. They are not stored on the template itself.
        </p>

        {!hasOriginalUpload && (
          <p
            className="mt-3 text-xs text-danger"
            data-testid="agreement-template-generate-needs-upload"
          >
            Upload a source DOCX template before generating an agreement.
          </p>
        )}

        <div className="mt-3 space-y-3">
          <label className="block text-xs text-ink-muted">
            Title (optional)
            <input
              type="text"
              className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
              placeholder={`e.g. ${t.name} — Acme`}
              value={genTitle}
              onChange={(e) => setGenTitle(e.target.value)}
              data-testid="agreement-template-generate-title"
            />
          </label>

          {sortedVariables.length === 0 ? (
            <p className="text-xs text-ink-subtle">
              No variables defined. The template will be generated as-is.
            </p>
          ) : (
            <>
              {requiredVariables.length > 0 && (
                <div
                  className="space-y-2"
                  data-testid="agreement-template-generate-required-group"
                >
                  <h3 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Required
                  </h3>
                  {requiredVariables.map((v) => (
                    <VariableField
                      key={v.id}
                      variable={v}
                      value={genValues[v.key] ?? v.default_value ?? ""}
                      onChange={(value) =>
                        setGenValues((prev) => ({ ...prev, [v.key]: value }))
                      }
                      missing={
                        genAttempted &&
                        missingRequiredKeys.includes(v.key)
                      }
                    />
                  ))}
                </div>
              )}
              {optionalVariables.length > 0 && (
                <div
                  className="space-y-2"
                  data-testid="agreement-template-generate-optional-group"
                >
                  <h3 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    Optional
                  </h3>
                  {optionalVariables.map((v) => (
                    <VariableField
                      key={v.id}
                      variable={v}
                      value={genValues[v.key] ?? v.default_value ?? ""}
                      onChange={(value) =>
                        setGenValues((prev) => ({ ...prev, [v.key]: value }))
                      }
                      missing={false}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {genAttempted && missingRequiredKeys.length > 0 && (
            <p
              className="text-xs text-danger"
              data-testid="agreement-template-generate-missing-required"
            >
              Missing required fields:{" "}
              {missingRequiredKeys
                .map(
                  (key) =>
                    sortedVariables.find((v) => v.key === key)?.label ?? key,
                )
                .join(", ")}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:opacity-50 sm:w-auto sm:py-1.5"
              onClick={onOpenReview}
              disabled={generating || !hasOriginalUpload || reviewing}
              data-testid="agreement-template-generate-submit"
            >
              Review generation
            </button>
            {genError && !reviewing && (
              <span
                className="text-xs text-danger"
                data-testid="agreement-template-generate-error"
              >
                {genError}
              </span>
            )}
          </div>

          {reviewing && !genResult && (
            <ReviewPanel
              templateName={t.name}
              requiredVariables={requiredVariables}
              optionalVariables={optionalVariables}
              values={genValues}
              missingRequiredKeys={missingRequiredKeys}
              generating={generating}
              error={genError}
              onConfirm={onConfirmGenerate}
              onBack={onBackToEdit}
            />
          )}

          {genResult && (
            <div
              className="rounded border border-success-ring bg-success-soft px-3 py-2 text-sm"
              data-testid="agreement-template-generate-success"
            >
              <p className="text-ink">
                Generated{" "}
                <strong className="font-medium">
                  {genResult.contract.title}
                </strong>
                .
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                Filed as a Repository record. The template's source file is
                unchanged. Open the new Repository record to send it to
                DocuSeal for signature.
              </p>
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                <Link
                  to={mountedPath(
                    `/repository/${genResult.contract.id}`,
                    location.pathname,
                  )}
                  className="underline"
                  data-testid="agreement-template-generate-contract-link"
                >
                  Open Repository record
                </Link>
                {genResult.artifact.filename && (
                  <span className="text-ink-subtle">
                    {genResult.artifact.filename}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {t.status === "active" && (
        <section
          className="rounded border border-rule p-4"
          data-testid="agreement-template-archive"
        >
          <h2 className="text-sm font-medium text-ink">Archive template</h2>
          <p className="mt-1 text-xs text-ink-subtle">
            Archiving hides this template from the default list and from
            new requests. Existing generated Repository records are
            unaffected. Archiving is reversible by editing the template
            status directly.
          </p>
          {archiveError && (
            <p
              className="mt-2 text-xs text-danger"
              data-testid="agreement-template-archive-error"
            >
              {archiveError}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            {confirmingArchive ? (
              <>
                <button
                  type="button"
                  className="rounded border border-danger bg-danger px-2 py-1 text-canvas disabled:opacity-50"
                  onClick={onConfirmArchive}
                  disabled={archiving}
                  data-testid="agreement-template-confirm-archive"
                >
                  {archiving ? "Archiving…" : "Confirm archive"}
                </button>
                <button
                  type="button"
                  className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                  onClick={() => setConfirmingArchive(false)}
                  data-testid="agreement-template-cancel-archive"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
                onClick={() => setConfirmingArchive(true)}
                data-testid="agreement-template-archive-button"
              >
                Archive
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function TemplateStatusPill({ status }: { status: string }) {
  const active = status === "active";
  const cls = active
    ? "bg-success/10 text-success border-success/40"
    : "bg-canvas-muted text-ink-muted border-rule";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
      data-testid="agreement-template-status-pill"
    >
      {active ? "Active" : status === "archived" ? "Archived" : status}
    </span>
  );
}

function VariableField({
  variable,
  value,
  onChange,
  missing,
}: {
  variable: AgreementTemplateVariable;
  value: string;
  onChange: (next: string) => void;
  missing: boolean;
}) {
  return (
    <label
      className="block text-xs text-ink-muted"
      data-testid="agreement-template-generate-field"
      data-missing={missing ? "true" : "false"}
    >
      <span>
        {variable.label}
        {variable.required ? (
          <span className="text-danger" aria-hidden>
            {" "}
            *
          </span>
        ) : null}
        <span className="ml-2 text-ink-subtle">({variable.variable_type})</span>
      </span>
      <input
        className={`mt-1 w-full rounded border px-2 py-1 text-sm ${
          missing ? "border-danger" : "border-rule"
        }`}
        placeholder={variable.help_text ?? variable.default_value ?? variable.key}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`agreement-template-generate-input-${variable.key}`}
      />
      {variable.help_text && (
        <span className="mt-0.5 block text-[11px] text-ink-subtle">
          {variable.help_text}
        </span>
      )}
    </label>
  );
}

/**
 * Pre-generation review panel (PR #97).
 *
 * Renders inline below the variable form when the user clicks
 * *Review generation*. The user confirms the values that will be
 * sent to ``/generate`` and then clicks the panel's final
 * *Generate agreement* button to actually fire the existing
 * generation endpoint. The panel does NOT persist anything — values
 * stay in component state until the moment the generation request
 * fires, and the request body is then forgotten.
 *
 * Privacy framing is explicit on the panel: variable values are
 * sent only to render the agreement; they are not stored on the
 * template itself. The generated DOCX becomes a separate
 * ``ContractArtifact`` row on the new Repository record, and that
 * artifact's allowlisted metadata (PR #42) does not include the
 * plaintext variable values.
 */
function ReviewPanel({
  templateName,
  requiredVariables,
  optionalVariables,
  values,
  missingRequiredKeys,
  generating,
  error,
  onConfirm,
  onBack,
}: {
  templateName: string;
  requiredVariables: AgreementTemplateVariable[];
  optionalVariables: AgreementTemplateVariable[];
  values: Record<string, string>;
  missingRequiredKeys: string[];
  generating: boolean;
  error: string | null;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const requiredFilled =
    requiredVariables.length - missingRequiredKeys.length;
  const optionalBlank = optionalVariables.filter(
    (v) => !resolveValue(v, values).trim(),
  ).length;
  const canConfirm = missingRequiredKeys.length === 0 && !generating;
  return (
    <section
      className="mt-3 rounded border border-rule bg-canvas-subtle p-4"
      data-testid="agreement-template-generate-review"
      aria-label="Review generation"
    >
      <h3 className="text-sm font-medium text-ink">Review generation</h3>
      <p className="mt-1 text-xs text-ink-subtle">
        Using template{" "}
        <strong className="font-medium text-ink">{templateName}</strong>.
        Confirm the values below — this is the last step before a
        Repository record is created.
      </p>

      <div
        className="mt-3 grid gap-2 sm:grid-cols-3 text-xs"
        data-testid="agreement-template-generate-review-summary"
      >
        <SummaryTile
          label="Required filled"
          value={requiredFilled}
          testId="agreement-template-generate-review-required-filled"
        />
        <SummaryTile
          label="Required missing"
          value={missingRequiredKeys.length}
          testId="agreement-template-generate-review-required-missing"
          tone={
            missingRequiredKeys.length > 0 ? "danger" : "default"
          }
        />
        <SummaryTile
          label="Optional blank"
          value={optionalBlank}
          testId="agreement-template-generate-review-optional-blank"
        />
      </div>

      <div className="mt-4 space-y-3">
        {requiredVariables.length > 0 && (
          <ReviewGroup
            heading="Required"
            variables={requiredVariables}
            values={values}
            missingRequiredKeys={missingRequiredKeys}
            testId="agreement-template-generate-review-required-group"
          />
        )}
        {optionalVariables.length > 0 && (
          <ReviewGroup
            heading="Optional"
            variables={optionalVariables}
            values={values}
            missingRequiredKeys={[]}
            testId="agreement-template-generate-review-optional-group"
          />
        )}
      </div>

      <p
        className="mt-4 rounded border border-rule bg-canvas px-3 py-2 text-xs text-ink-muted"
        data-testid="agreement-template-generate-review-result"
      >
        <span className="font-medium text-ink">Result:</span> this will
        create a Repository record with a Generated Word document. The
        template's source file is unchanged.
      </p>
      <p
        className="mt-2 rounded border border-rule bg-canvas px-3 py-2 text-xs text-ink-muted"
        data-testid="agreement-template-generate-review-privacy"
      >
        <span className="font-medium text-ink">Privacy:</span> variable
        values are sent only to generate this agreement and are not
        stored in template metadata.
      </p>

      {missingRequiredKeys.length > 0 && (
        <p
          className="mt-3 text-xs text-danger"
          data-testid="agreement-template-generate-review-missing-warning"
        >
          Fill missing required fields before generating.
        </p>
      )}

      {error && (
        <p
          className="mt-3 text-xs text-danger"
          data-testid="agreement-template-generate-review-error"
        >
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
        <button
          type="button"
          className="rounded border border-ink bg-ink px-3 py-1.5 text-canvas disabled:opacity-50"
          onClick={onConfirm}
          disabled={!canConfirm}
          data-testid="agreement-template-generate-review-confirm"
        >
          {generating ? "Generating…" : "Generate agreement"}
        </button>
        <button
          type="button"
          className="rounded border border-rule px-3 py-1.5 text-ink hover:bg-canvas-muted disabled:opacity-50"
          onClick={onBack}
          disabled={generating}
          data-testid="agreement-template-generate-review-back"
        >
          Back to edit
        </button>
      </div>
    </section>
  );
}

function SummaryTile({
  label,
  value,
  testId,
  tone = "default",
}: {
  label: string;
  value: number;
  testId: string;
  tone?: "default" | "danger";
}) {
  const danger = tone === "danger" && value > 0;
  return (
    <div
      className={`rounded border bg-canvas p-2 ${
        danger ? "border-danger-ring" : "border-rule"
      }`}
      data-testid={testId}
    >
      <p className="text-[11px] uppercase tracking-wide text-ink-subtle">
        {label}
      </p>
      <p
        className={`mt-1 text-lg font-semibold tabular-nums ${
          danger ? "text-danger" : "text-ink"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function ReviewGroup({
  heading,
  variables,
  values,
  missingRequiredKeys,
  testId,
}: {
  heading: string;
  variables: AgreementTemplateVariable[];
  values: Record<string, string>;
  missingRequiredKeys: string[];
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <h4 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
        {heading}
      </h4>
      <ul className="mt-1 space-y-1">
        {variables.map((v) => {
          const value = resolveValue(v, values).trim();
          return (
            <li
              key={v.id}
              className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-rule bg-canvas px-3 py-1.5 text-xs"
              data-testid="agreement-template-generate-review-row"
              data-variable-key={v.key}
              data-status={
                missingRequiredKeys.includes(v.key)
                  ? "missing"
                  : value === ""
                    ? "blank"
                    : "filled"
              }
            >
              <div className="min-w-0">
                <span className="text-ink">{v.label}</span>
                <span className="ml-2 font-mono text-[11px] text-ink-subtle">
                  {v.key}
                </span>
              </div>
              <div className="flex shrink-0 flex-wrap items-baseline gap-2">
                {value && (
                  <span className="max-w-[14rem] truncate text-ink-muted">
                    “{value}”
                  </span>
                )}
                <ReviewStatusChip
                  status={
                    missingRequiredKeys.includes(v.key)
                      ? "missing"
                      : value === ""
                        ? "blank"
                        : "filled"
                  }
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ReviewStatusChip({
  status,
}: {
  status: "filled" | "blank" | "missing";
}) {
  const map = {
    filled: {
      label: "Filled",
      cls: "bg-success/10 text-success border-success/40",
    },
    blank: {
      label: "Blank",
      cls: "bg-canvas-muted text-ink-muted border-rule",
    },
    missing: {
      label: "Missing",
      cls: "bg-danger/10 text-danger border-danger/40",
    },
  } as const;
  const { label, cls } = map[status];
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function resolveValue(
  variable: AgreementTemplateVariable,
  values: Record<string, string>,
): string {
  return values[variable.key] ?? variable.default_value ?? "";
}

/**
 * Template source file history (PR #102).
 *
 * Filters the artifact list to source-file uploads only (the
 * "original_upload" rows that operators uploaded), sorts them
 * newest-first, and visually marks the *current* source file —
 * defined as the most recent ``is_official`` row, falling back to
 * the most recent row when no row carries the flag. Renders only
 * safe metadata: a user-friendly label (via ``artifactDisplayLabel``,
 * so the raw artifact_type taxonomy never reaches the DOM), the
 * original filename, the MIME label, and the created date.
 *
 * No download / preview affordance in this PR — the existing upload
 * affordance and Text preview elsewhere on the page cover safe access;
 * a per-version download is intentional future work that requires its
 * own scoped endpoint + audit.
 */
function SourceHistorySection({
  artifacts,
}: {
  artifacts: AgreementTemplateArtifact[];
}) {
  const sources = artifacts
    .filter((a) => a.artifact_type === "original_upload")
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const currentSourceId =
    sources.find((s) => s.is_official)?.id ?? sources[0]?.id ?? null;
  return (
    <section
      className="rounded border border-rule p-4"
      data-testid="agreement-template-source-history"
    >
      <h2 className="text-sm font-medium text-ink">Source file history</h2>
      <p className="mt-1 text-xs text-ink-subtle">
        Every source file uploaded for this template, newest first.
        The current source file is the version operators distribute;
        older versions are kept for audit. Per-version download and
        side-by-side compare are future work.
      </p>
      {sources.length === 0 ? (
        <p
          className="mt-3 text-xs text-ink-subtle"
          data-testid="agreement-template-source-history-empty"
        >
          No source file uploads yet. Upload a DOCX or PDF above to
          start the history.
        </p>
      ) : (
        <ol
          className="mt-3 space-y-2 text-xs"
          data-testid="agreement-template-source-history-list"
        >
          {sources.map((s) => {
            const isCurrent = s.id === currentSourceId;
            return (
              <li
                key={s.id}
                className={`flex flex-wrap items-baseline gap-2 rounded border p-2 ${
                  isCurrent
                    ? "border-info-ring bg-info-soft"
                    : "border-rule bg-canvas"
                }`}
                data-testid="agreement-template-source-history-row"
                data-current={isCurrent ? "true" : "false"}
              >
                <span className="font-medium text-ink">Source file</span>
                {isCurrent && (
                  <span
                    className="rounded border border-info/40 bg-info/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-info"
                    data-testid="agreement-template-source-history-current-chip"
                    title="The version operators distribute"
                  >
                    Current
                  </span>
                )}
                {s.filename && (
                  <span className="text-ink-muted">{s.filename}</span>
                )}
                {s.mime_type && (
                  <span className="text-ink-subtle">
                    {mimeLabel(s.mime_type)}
                  </span>
                )}
                <span className="text-ink-subtle">
                  Uploaded {formatDate(s.created_at)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
