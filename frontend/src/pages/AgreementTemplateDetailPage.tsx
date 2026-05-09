import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  ApiError,
  MissingDevUserError,
  createAgreementTemplateVariable,
  deleteAgreementTemplateVariable,
  generateAgreementFromTemplate,
  getAgreementTemplate,
  getAgreementTemplateArtifacts,
  getAgreementTemplateMarkdown,
  listAgreementTemplateVariables,
  uploadAgreementTemplateArtifact,
} from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { demoPath } from "../lib/routes";
import type {
  AgreementGenerationResponse,
  AgreementTemplate,
  AgreementTemplateArtifact,
  AgreementTemplateMarkdownSnapshot,
  AgreementTemplateVariable,
} from "../types/agreementTemplates";

interface PageState {
  template: AgreementTemplate | null;
  artifacts: AgreementTemplateArtifact[];
  markdown: AgreementTemplateMarkdownSnapshot | null;
  variables: AgreementTemplateVariable[];
}

const EMPTY: PageState = {
  template: null,
  artifacts: [],
  markdown: null,
  variables: [],
};

export default function AgreementTemplateDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [state, setState] = useState<PageState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Variable form state
  const [varKey, setVarKey] = useState("");
  const [varLabel, setVarLabel] = useState("");
  const [varType, setVarType] = useState("text");
  const [varRequired, setVarRequired] = useState(false);
  const [varError, setVarError] = useState<string | null>(null);

  // Generation form state
  const [genTitle, setGenTitle] = useState("");
  const [genValues, setGenValues] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genResult, setGenResult] = useState<AgreementGenerationResponse | null>(
    null,
  );

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [template, artifacts, markdown, variables] = await Promise.all([
        getAgreementTemplate(id),
        getAgreementTemplateArtifacts(id),
        getAgreementTemplateMarkdown(id),
        listAgreementTemplateVariables(id),
      ]);
      setState({ template, artifacts, markdown, variables });
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
      const message =
        err instanceof Error ? err.message : "Upload failed.";
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
      setState((prev) => ({ ...prev, variables: [...prev.variables, created] }));
      setVarKey("");
      setVarLabel("");
      setVarRequired(false);
    } catch (err) {
      setVarError(err instanceof Error ? err.message : "Could not add variable.");
    }
  }

  async function onDeleteVariable(variableId: string) {
    await deleteAgreementTemplateVariable(id, variableId);
    setState((prev) => ({
      ...prev,
      variables: prev.variables.filter((v) => v.id !== variableId),
    }));
  }

  async function onGenerate() {
    setGenerating(true);
    setGenError(null);
    setGenResult(null);
    try {
      const result = await generateAgreementFromTemplate(id, {
        title: genTitle.trim() || undefined,
        variable_values: genValues,
      });
      setGenResult(result);
    } catch (err) {
      setGenError(
        err instanceof Error ? err.message : "Could not generate agreement.",
      );
    } finally {
      setGenerating(false);
    }
  }

  if (loading && !state.template) {
    return <p className="text-sm text-ink-muted">Loading template…</p>;
  }
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!state.template) return null;

  const t = state.template;
  const hasOriginalUpload = state.artifacts.some(
    (a) => a.artifact_type === "original_upload",
  );
  const missingRequired = state.variables
    .filter((v) => v.required)
    .some((v) => {
      const raw = genValues[v.key] ?? "";
      return raw.trim() === "";
    });

  return (
    <div className="space-y-5" data-testid="agreement-template-detail">
      <div>
        <Link to="/demo/agreement-templates" className="text-xs underline">
          ← All templates
        </Link>
        <h1 className="mt-2 text-lg font-semibold text-ink">{t.name}</h1>
        <p className="text-xs text-ink-subtle">
          {t.template_type ?? "Untyped"} · {t.status}
        </p>
        {t.description && (
          <p className="mt-2 text-sm text-ink-muted">{t.description}</p>
        )}
      </div>

      <section
        className="rounded border border-rule p-4"
        data-testid="agreement-template-upload"
      >
        <h2 className="text-sm font-medium text-ink">Original template file</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Upload the DOCX or PDF that operators distribute. The original is
          the official legal artifact; a Markdown preview is generated for
          fast skimming.
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
            <span className="text-xs text-danger">{uploadError}</span>
          )}
        </div>
        {state.artifacts.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-ink-muted">
            {state.artifacts.map((a) => (
              <li key={a.id} data-testid="agreement-template-artifact">
                {a.filename ?? "(no filename)"}{" "}
                <span className="text-ink-subtle">{a.artifact_type}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="overflow-hidden rounded border border-rule"
        data-testid="agreement-template-markdown"
      >
        <header className="border-b border-rule bg-canvas-subtle px-4 py-2.5">
          <h2 className="text-sm font-medium text-ink">Markdown preview</h2>
          <p className="mt-0.5 text-xs text-ink-subtle">
            Working copy. The original DOCX/PDF remains the official artifact.
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
            className="px-4 py-5 text-sm text-ink-muted sm:px-6 sm:py-6"
            data-testid="agreement-template-markdown-empty"
          >
            No markdown preview yet. Upload an original DOCX or PDF to
            generate one.
          </div>
        )}
      </section>

      <section
        className="rounded border border-rule p-4"
        data-testid="agreement-template-variables"
      >
        <h2 className="text-sm font-medium text-ink">Variables</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Variables are metadata only in this version. Generated DOCX
          rendering arrives in a later release.
        </p>

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

        {state.variables.length === 0 ? (
          <p className="mt-4 text-xs text-ink-subtle">No variables defined.</p>
        ) : (
          <ul className="mt-4 space-y-1">
            {state.variables.map((v) => (
              <li
                key={v.id}
                className="flex flex-wrap items-start justify-between gap-2 rounded border border-rule px-3 py-2 text-sm"
                data-testid="agreement-template-variable-row"
              >
                <div className="min-w-0 break-words">
                  <code className="text-xs text-ink-subtle">{v.key}</code>
                  <span className="ml-2 text-ink">{v.label}</span>
                  <span className="ml-2 text-xs text-ink-muted">
                    {v.variable_type}
                    {v.required ? " · required" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-xs underline"
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
          Render a draft DOCX from this template and the variable values
          below. The original template is not modified. Generated DOCX
          files become draft contracts in the repository — they are not
          sent to DocuSeal yet.
        </p>

        {!hasOriginalUpload && (
          <p
            className="mt-3 text-xs text-danger"
            data-testid="agreement-template-generate-needs-upload"
          >
            Upload an original DOCX template before generating an agreement.
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

          {state.variables.length === 0 ? (
            <p className="text-xs text-ink-subtle">
              No variables defined. The template will be generated as-is.
            </p>
          ) : (
            <div className="space-y-2">
              {state.variables.map((v) => (
                <label
                  key={v.id}
                  className="block text-xs text-ink-muted"
                  data-testid="agreement-template-generate-field"
                >
                  <span>
                    {v.label}
                    {v.required ? <span className="text-danger"> *</span> : null}
                    <span className="ml-2 text-ink-subtle">({v.variable_type})</span>
                  </span>
                  <input
                    className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
                    placeholder={v.help_text ?? v.key}
                    value={genValues[v.key] ?? v.default_value ?? ""}
                    onChange={(e) =>
                      setGenValues((prev) => ({
                        ...prev,
                        [v.key]: e.target.value,
                      }))
                    }
                    data-testid={`agreement-template-generate-input-${v.key}`}
                  />
                </label>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:opacity-50 sm:w-auto sm:py-1.5"
              onClick={onGenerate}
              disabled={generating || !hasOriginalUpload || missingRequired}
              data-testid="agreement-template-generate-submit"
            >
              {generating ? "Generating…" : "Generate DOCX"}
            </button>
            {genError && (
              <span
                className="text-xs text-danger"
                data-testid="agreement-template-generate-error"
              >
                {genError}
              </span>
            )}
          </div>

          {genResult && (
            <div
              className="rounded border border-rule bg-canvas-subtle px-3 py-2 text-sm"
              data-testid="agreement-template-generate-success"
            >
              <p className="text-ink">
                Generated{" "}
                <strong className="font-medium">
                  {genResult.contract.title}
                </strong>
                .
              </p>
              <p className="mt-1 text-xs text-ink-subtle">
                Filed as a draft contract. The original template is unchanged.
                Sending to DocuSeal is not enabled yet.
              </p>
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                <Link
                  to={demoPath(`/contracts/${genResult.contract.id}`)}
                  className="underline"
                  data-testid="agreement-template-generate-contract-link"
                >
                  Open generated contract
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

      {state.template.metadata_json && (
        <section className="text-xs text-ink-subtle">
          <details>
            <summary className="cursor-pointer">Metadata</summary>
            <pre className="mt-1 whitespace-pre-wrap">
              {JSON.stringify(state.template.metadata_json, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </div>
  );
}

