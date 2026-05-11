import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import EmptyState from "../components/EmptyState";
import ErrorState from "../components/ErrorState";
import LoadingSkeleton from "../components/LoadingSkeleton";
import {
  archiveApprovalPolicy,
  createApprovalPolicy,
  listAgreementTemplates,
  listApprovalPolicies,
  listApprovalWorkflowTemplates,
} from "../lib/api";
import {
  DEEP_LINK_HIGHLIGHT_CLASS,
  scrollDeepLinkIntoView,
} from "../lib/deepLinkHighlight";
import type { AgreementTemplate } from "../types/agreementTemplates";
import type {
  ApprovalPolicy,
  ApprovalPolicyCreateRequest,
} from "../types/approvalPolicies";
import type { ApprovalWorkflowTemplate } from "../types/approvalWorkflowTemplates";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; rows: ApprovalPolicy[] }
  | { kind: "error"; message: string };

const EMPTY_FORM: ApprovalPolicyCreateRequest = {
  name: "",
  workflow_template_id: "",
  auto_attach: true,
  applies_to_generated_contracts: true,
};

/**
 * Approval Policies page (PR #53 introduced policies; PR #85 polished
 * this surface). Rules that match incoming requests by request_type /
 * contract_type / priority / linked Agreement Template and
 * automatically attach an approval workflow template. The page is
 * also the destination of the gate-remediation deep link
 * /approvals/policies?policy_id=<id> (PR #61).
 */
export default function ApprovalPoliciesPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [templates, setTemplates] = useState<ApprovalWorkflowTemplate[]>([]);
  const [agreementTemplates, setAgreementTemplates] = useState<
    AgreementTemplate[]
  >([]);
  const [form, setForm] = useState<ApprovalPolicyCreateRequest>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const [searchParams] = useSearchParams();
  const deepLinkPolicyId = searchParams.get("policy_id");
  const deepLinkRowRef = useRef<HTMLLIElement | null>(null);
  // Tracks whether we've already auto-toggled archived for this id so
  // we don't fight the user if they turn it back off.
  const autoArchivedRef = useRef<string | null>(null);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    listApprovalPolicies({ include_archived: includeArchived })
      .then((rows) => setState({ kind: "loaded", rows }))
      .catch((err) =>
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Could not load policies.",
        }),
      );
  }, [includeArchived]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    listApprovalWorkflowTemplates({ include_archived: true })
      .then(setTemplates)
      .catch(() => undefined);
    listAgreementTemplates({ include_archived: true })
      .then(setAgreementTemplates)
      .catch(() => undefined);
  }, []);

  const rows = state.kind === "loaded" ? state.rows : [];
  const deepLinkRowFound =
    deepLinkPolicyId !== null && rows.some((r) => r.id === deepLinkPolicyId);

  useEffect(() => {
    if (!deepLinkPolicyId) return;
    if (state.kind !== "loaded") return;
    if (deepLinkRowFound) return;
    if (includeArchived) return;
    if (autoArchivedRef.current === deepLinkPolicyId) return;
    autoArchivedRef.current = deepLinkPolicyId;
    setIncludeArchived(true);
  }, [deepLinkPolicyId, deepLinkRowFound, state.kind, includeArchived]);

  useEffect(() => {
    if (!deepLinkPolicyId) return;
    if (!deepLinkRowFound) return;
    scrollDeepLinkIntoView(deepLinkRowRef.current);
  }, [deepLinkPolicyId, deepLinkRowFound, rows.length]);

  async function submit() {
    setFormError(null);
    if (!form.name?.trim() || !form.workflow_template_id?.trim()) {
      setFormError("Name and workflow template are required.");
      return;
    }
    setSubmitting(true);
    try {
      await createApprovalPolicy({
        ...form,
        request_type: form.request_type || null,
        contract_type: form.contract_type || null,
        priority: form.priority || null,
        agreement_template_id: form.agreement_template_id || null,
      });
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Could not create policy.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmArchive(id: string) {
    setArchiveError(null);
    try {
      await archiveApprovalPolicy(id);
      setConfirmArchiveId(null);
      load();
    } catch (err) {
      setArchiveError(
        err instanceof Error ? err.message : "Could not archive policy.",
      );
    }
  }

  return (
    <div className="space-y-5" data-testid="approval-policies-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Approval Policies</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Rules that match incoming requests and automatically attach
            approval workflows. Policies also drive whether a
            request-linked contract can be sent for signature.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-subtle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Include archived
        </label>
      </div>

      {deepLinkPolicyId && state.kind === "loaded" && !deepLinkRowFound && (
        <p
          className="rounded border border-warning-ring bg-warning-soft px-3 py-2 text-xs text-ink"
          data-testid="approval-policies-deep-link-not-found"
        >
          The linked approval policy <code>{deepLinkPolicyId}</code> was not
          found in the current view.
        </p>
      )}

      <section
        className="grid gap-3 rounded border border-rule p-4"
        data-testid="approval-policies-create"
      >
        <h2 className="text-sm font-medium text-ink">Create policy</h2>
        <div className="grid gap-2">
          <label className="text-xs text-ink-subtle">
            Name
            <input
              placeholder="Name"
              value={form.name ?? ""}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-ink-subtle">
            Description (optional)
            <textarea
              placeholder="What does this policy enforce?"
              value={form.description ?? ""}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              className="mt-1 min-h-[3rem] w-full rounded border border-rule px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-ink-subtle">
            Workflow template
            <select
              value={form.workflow_template_id}
              onChange={(e) =>
                setForm({ ...form, workflow_template_id: e.target.value })
              }
              className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
            >
              <option value="">Select workflow template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-xs text-ink-subtle">
              Request type
              <input
                placeholder="Any"
                value={form.request_type ?? ""}
                onChange={(e) =>
                  setForm({ ...form, request_type: e.target.value })
                }
                className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-ink-subtle">
              Contract type
              <input
                placeholder="Any"
                value={form.contract_type ?? ""}
                onChange={(e) =>
                  setForm({ ...form, contract_type: e.target.value })
                }
                className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-ink-subtle">
              Priority
              <input
                placeholder="Any"
                value={form.priority ?? ""}
                onChange={(e) =>
                  setForm({ ...form, priority: e.target.value })
                }
                className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
              />
            </label>
          </div>
          <label className="text-xs text-ink-subtle">
            Agreement template
            <select
              value={form.agreement_template_id ?? ""}
              onChange={(e) =>
                setForm({ ...form, agreement_template_id: e.target.value })
              }
              className="mt-1 w-full rounded border border-rule px-2 py-1 text-sm"
            >
              <option value="">Any agreement template</option>
              {agreementTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-4 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.auto_attach ?? true}
                onChange={(e) =>
                  setForm({ ...form, auto_attach: e.target.checked })
                }
              />
              Auto attach to matching requests
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.applies_to_generated_contracts ?? true}
                onChange={(e) =>
                  setForm({
                    ...form,
                    applies_to_generated_contracts: e.target.checked,
                  })
                }
              />
              Applies to generated contracts
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:opacity-50 sm:w-fit sm:py-1.5"
            >
              {submitting ? "Creating…" : "Create"}
            </button>
            {formError && (
              <span
                className="text-xs text-danger"
                data-testid="approval-policies-error"
              >
                {formError}
              </span>
            )}
          </div>
        </div>
      </section>

      {archiveError && (
        <ErrorState title="Could not archive policy" description={archiveError} />
      )}

      {state.kind === "loading" && <LoadingSkeleton rows={3} />}
      {state.kind === "error" && (
        <ErrorState
          title="Could not load approval policies"
          description={state.message}
        />
      )}
      {state.kind === "loaded" && rows.length === 0 && (
        <EmptyState
          title={
            includeArchived
              ? "No policies to show"
              : "No active approval policies"
          }
          description={
            includeArchived
              ? "Create one above. Policies match new requests and automatically attach approval workflows."
              : "Create one above, or toggle “Include archived” to view archived policies."
          }
        />
      )}
      {state.kind === "loaded" && rows.length > 0 && (
        <ul className="space-y-2" data-testid="approval-policies-list">
          {rows.map((row) => {
            const isDeepLinkTarget = row.id === deepLinkPolicyId;
            const templateName =
              templates.find((t) => t.id === row.workflow_template_id)?.name ??
              row.workflow_template_id;
            const agreementName = row.agreement_template_id
              ? (agreementTemplates.find(
                  (t) => t.id === row.agreement_template_id,
                )?.name ?? row.agreement_template_id)
              : null;
            const isConfirming = confirmArchiveId === row.id;
            return (
              <li
                key={row.id}
                ref={isDeepLinkTarget ? deepLinkRowRef : undefined}
                className={`rounded border p-3 ${
                  isDeepLinkTarget ? DEEP_LINK_HIGHLIGHT_CLASS : "border-rule"
                }`}
                data-testid="approval-policy-row"
                data-deep-link-target={isDeepLinkTarget ? "true" : undefined}
                aria-label={
                  isDeepLinkTarget
                    ? "Linked approval policy from approval gate"
                    : undefined
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <p className="font-medium text-ink">{row.name}</p>
                      <PolicyStatusPill status={row.status} />
                      {!row.auto_attach && (
                        <span
                          className="rounded border border-rule bg-canvas-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted"
                          data-testid="approval-policy-manual-chip"
                        >
                          Manual attach
                        </span>
                      )}
                    </div>
                    {row.description && (
                      <p className="text-xs text-ink-muted">{row.description}</p>
                    )}
                    <p className="text-xs text-ink-subtle">
                      Workflow:{" "}
                      <span className="text-ink">{templateName}</span>
                    </p>
                    <PolicyCriteriaChips
                      requestType={row.request_type}
                      contractType={row.contract_type}
                      priority={row.priority}
                      agreementName={agreementName}
                    />
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2 text-xs">
                    {row.status === "active" &&
                      (isConfirming ? (
                        <>
                          <button
                            type="button"
                            className="rounded border border-danger bg-danger px-2 py-1 text-canvas"
                            onClick={() => confirmArchive(row.id)}
                            data-testid="approval-policy-confirm-archive"
                          >
                            Confirm archive
                          </button>
                          <button
                            type="button"
                            className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                            onClick={() => setConfirmArchiveId(null)}
                            data-testid="approval-policy-cancel-archive"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
                          onClick={() => setConfirmArchiveId(row.id)}
                        >
                          Archive
                        </button>
                      ))}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PolicyStatusPill({ status }: { status: string }) {
  const cls =
    status === "active"
      ? "bg-success/10 text-success border-success/40"
      : "bg-canvas-muted text-ink-muted border-rule";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
      data-testid="approval-policy-status-pill"
    >
      {status === "active" ? "Active" : "Archived"}
    </span>
  );
}

function PolicyCriteriaChips({
  requestType,
  contractType,
  priority,
  agreementName,
}: {
  requestType: string | null;
  contractType: string | null;
  priority: string | null;
  agreementName: string | null;
}) {
  const chips: { key: string; label: string }[] = [
    { key: "request", label: `Request type: ${requestType ?? "Any"}` },
    { key: "contract", label: `Contract type: ${contractType ?? "Any"}` },
    { key: "priority", label: `Priority: ${priority ?? "Any"}` },
    {
      key: "agreement",
      label: `Agreement: ${agreementName ?? "Any"}`,
    },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.key}
          className="rounded border border-rule bg-canvas-subtle px-1.5 py-0.5 text-[10px] text-ink-muted"
          data-testid={`approval-policy-criteria-${c.key}`}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}
