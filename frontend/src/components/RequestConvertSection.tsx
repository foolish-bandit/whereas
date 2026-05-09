import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  ApiError,
  MissingDevUserError,
  convertRequestToContract,
  listAgreementTemplateVariables,
} from "../lib/api";
import { demoPath } from "../lib/routes";
import type { AgreementTemplateVariable } from "../types/agreementTemplates";
import type {
  ContractRequest,
  ConvertRequestToContractResponse,
} from "../types/requests";

interface Props {
  request: ContractRequest;
  /** Receives the freshly-converted state so the parent can update its
   *  list view in place without refetching. */
  onConverted: (response: ConvertRequestToContractResponse) => void;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; variables: AgreementTemplateVariable[] }
  | { kind: "error"; message: string };

/**
 * Inline conversion UI for a single request row.
 *
 * Rendered when the request has a ``linked_template_id`` and no
 * ``linked_contract_id``. The form mirrors the agreement-template
 * generation form so users see the same shape on both surfaces. On
 * success we hand the response back to the parent so it can swap the
 * row's state without re-fetching.
 *
 * Cancelled requests don't render this — the parent gates that.
 */
export default function RequestConvertSection({ request, onConverted }: Props) {
  const templateId = request.linked_template_id;
  const [varsState, setVarsState] = useState<LoadState>({ kind: "idle" });
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!templateId) {
      setVarsState({ kind: "idle" });
      return;
    }
    let aborted = false;
    setVarsState({ kind: "loading" });
    listAgreementTemplateVariables(templateId)
      .then((variables) => {
        if (aborted) return;
        setVarsState({ kind: "loaded", variables });
        // Pre-seed defaults into the form so the user only has to
        // override what's actually different.
        const seeded: Record<string, string> = {};
        for (const v of variables) {
          if (v.default_value !== null && v.default_value !== undefined) {
            seeded[v.key] = v.default_value;
          }
        }
        setValues(seeded);
      })
      .catch((err) => {
        if (aborted) return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setVarsState({ kind: "error", message: err.message });
        } else {
          setVarsState({ kind: "error", message: "Could not load template." });
        }
      });
    return () => {
      aborted = true;
    };
  }, [templateId]);

  if (!templateId) return null;

  const variables =
    varsState.kind === "loaded" ? varsState.variables : [];
  const missingRequired = variables.some(
    (v) =>
      v.required &&
      (values[v.key] === undefined || values[v.key].trim() === ""),
  );

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await convertRequestToContract(request.id, {
        title: title.trim() || null,
        variable_values: { ...values },
      });
      onConverted(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not convert request.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="mt-3 rounded border border-rule bg-canvas-subtle p-3 text-sm"
      data-testid="request-convert-section"
    >
      <p className="text-xs font-medium text-ink">Generate contract from template</p>
      <p className="mt-1 text-xs text-ink-subtle">
        Render a draft DOCX from the linked agreement template using the
        variable values below. The new contract will land in the contract
        repository as a draft; this does not send anything for signature.
      </p>

      {varsState.kind === "loading" && (
        <p className="mt-3 text-xs text-ink-muted">Loading template variables…</p>
      )}
      {varsState.kind === "error" && (
        <p className="mt-3 text-xs text-danger">{varsState.message}</p>
      )}

      {varsState.kind === "loaded" && (
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-ink-muted">
            Title (optional)
            <input
              type="text"
              className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
              placeholder={`e.g. ${request.title}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="request-convert-title"
            />
          </label>

          {variables.length === 0 ? (
            <p className="text-xs text-ink-subtle">
              No variables defined on this template. The contract will be
              generated as-is.
            </p>
          ) : (
            <div className="space-y-2">
              {variables.map((v) => (
                <label
                  key={v.id}
                  className="block text-xs text-ink-muted"
                  data-testid="request-convert-field"
                >
                  <span>
                    {v.label}
                    {v.required ? <span className="text-danger"> *</span> : null}
                    <span className="ml-2 text-ink-subtle">({v.variable_type})</span>
                  </span>
                  <input
                    className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
                    placeholder={v.help_text ?? v.key}
                    value={values[v.key] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [v.key]: e.target.value }))
                    }
                    data-testid={`request-convert-input-${v.key}`}
                  />
                </label>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="rounded border border-ink bg-ink px-3 py-1.5 text-xs text-canvas disabled:opacity-50"
              onClick={onSubmit}
              disabled={submitting || missingRequired}
              data-testid="request-convert-submit"
            >
              {submitting ? "Generating…" : "Generate contract"}
            </button>
            {error && (
              <span
                className="text-xs text-danger"
                data-testid="request-convert-error"
              >
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface LinkProps {
  contractId: string;
}

/**
 * Tiny "open the linked contract" affordance shared between the
 * just-converted state and the already-converted state.
 */
export function ConvertedContractLink({ contractId }: LinkProps) {
  return (
    <Link
      to={demoPath(`/contracts/${encodeURIComponent(contractId)}`)}
      className="text-xs underline"
      data-testid="request-convert-contract-link"
    >
      Open generated contract
    </Link>
  );
}
