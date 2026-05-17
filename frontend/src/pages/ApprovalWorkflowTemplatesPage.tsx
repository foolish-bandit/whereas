import { useEffect, useMemo, useState } from "react";

import EmptyState from "../components/EmptyState";
import {
  ApiError,
  MissingDevUserError,
  archiveApprovalWorkflowTemplate,
  createApprovalWorkflowTemplate,
  instantiateApprovalWorkflowTemplate,
  listApprovalWorkflowTemplates,
} from "../lib/api";
import type {
  ApprovalWorkflowTemplate,
  ApprovalWorkflowTemplateStepCreate,
} from "../types/approvalWorkflowTemplates";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; rows: ApprovalWorkflowTemplate[] }
  | { kind: "error"; message: string };

interface DraftStep {
  title: string;
  approver_name: string;
  approver_email: string;
  due_in_days: string;
}

function emptyStep(): DraftStep {
  return { title: "", approver_name: "", approver_email: "", due_in_days: "" };
}

interface InstantiateForm {
  templateId: string;
  name: string;
  request_id: string;
  contract_id: string;
}

const TEMPLATE_TYPES = [
  "legal_review",
  "finance_review",
  "procurement_review",
  "executive_approval",
  "general",
];

export default function ApprovalWorkflowTemplatesPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [includeArchived, setIncludeArchived] = useState(false);

  // Create-template form state.
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateType, setTemplateType] = useState<string>("legal_review");
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep()]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Expanded-detail and instantiate-form state.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [instantiateById, setInstantiateById] = useState<
    Record<string, InstantiateForm>
  >({});
  const [instantiateError, setInstantiateError] = useState<string | null>(null);
  const [lastInstantiatedRunId, setLastInstantiatedRunId] = useState<
    string | null
  >(null);

  useEffect(() => {
    let aborted = false;
    setState({ kind: "loading" });
    listApprovalWorkflowTemplates({ include_archived: includeArchived })
      .then((rows) => {
        if (!aborted) setState({ kind: "loaded", rows });
      })
      .catch((err) => {
        if (aborted) return;
        if (err instanceof MissingDevUserError || err instanceof ApiError) {
          setState({ kind: "error", message: err.message });
        } else {
          setState({
            kind: "error",
            message: "Could not load workflow templates.",
          });
        }
      });
    return () => {
      aborted = true;
    };
  }, [includeArchived]);

  const canCreate = useMemo(() => {
    if (!name.trim()) return false;
    return steps.some((s) => s.title.trim().length > 0);
  }, [name, steps]);

  function onAddStep() {
    setSteps((prev) => [...prev, emptyStep()]);
  }

  function onRemoveStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  function onUpdateStep(
    index: number,
    field: keyof DraftStep,
    value: string,
  ) {
    setSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...step, [field]: value } : step)),
    );
  }

  async function onCreate() {
    if (!canCreate) return;
    setCreating(true);
    setCreateError(null);
    const payloadSteps: ApprovalWorkflowTemplateStepCreate[] = steps
      .filter((s) => s.title.trim().length > 0)
      .map((s, idx) => ({
        step_order: idx + 1,
        title: s.title.trim(),
        approver_name: s.approver_name.trim() || null,
        approver_email: s.approver_email.trim() || null,
        due_in_days: s.due_in_days.trim()
          ? Number.parseInt(s.due_in_days, 10)
          : null,
      }));
    try {
      const tmpl = await createApprovalWorkflowTemplate({
        name: name.trim(),
        description: description.trim() || null,
        template_type: templateType || null,
        steps: payloadSteps,
      });
      setName("");
      setDescription("");
      setTemplateType("legal_review");
      setSteps([emptyStep()]);
      setExpandedId(tmpl.id);
      setState((prev) =>
        prev.kind === "loaded"
          ? { kind: "loaded", rows: [tmpl, ...prev.rows] }
          : prev,
      );
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Could not create template.",
      );
    } finally {
      setCreating(false);
    }
  }

  function _replaceRow(updated: ApprovalWorkflowTemplate) {
    setState((prev) =>
      prev.kind === "loaded"
        ? {
            kind: "loaded",
            rows: prev.rows.map((r) => (r.id === updated.id ? updated : r)),
          }
        : prev,
    );
  }

  async function onArchive(id: string) {
    try {
      const updated = await archiveApprovalWorkflowTemplate(id);
      // Hide archived row from default list; re-fetching is the simplest
      // way to reflect the include_archived toggle and the new updated_at.
      if (!includeArchived) {
        setState((prev) =>
          prev.kind === "loaded"
            ? {
                kind: "loaded",
                rows: prev.rows.filter((r) => r.id !== id),
              }
            : prev,
        );
      } else {
        _replaceRow(updated);
      }
    } catch (err) {
      setInstantiateError(
        err instanceof Error ? err.message : "Could not archive template.",
      );
    }
  }

  function onToggleExpand(id: string) {
    setLastInstantiatedRunId(null);
    setInstantiateError(null);
    setExpandedId((prev) => (prev === id ? null : id));
    if (!instantiateById[id]) {
      setInstantiateById((prev) => ({
        ...prev,
        [id]: { templateId: id, name: "", request_id: "", contract_id: "" },
      }));
    }
  }

  function onUpdateInstantiate(
    id: string,
    field: keyof Omit<InstantiateForm, "templateId">,
    value: string,
  ) {
    setInstantiateById((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] ?? {
          templateId: id,
          name: "",
          request_id: "",
          contract_id: "",
        }),
        [field]: value,
      },
    }));
  }

  async function onInstantiate(id: string) {
    const form = instantiateById[id];
    if (!form || !form.name.trim()) return;
    if (!form.request_id.trim() && !form.contract_id.trim()) {
      setInstantiateError("Provide a request_id or contract_id to attach to.");
      return;
    }
    try {
      setInstantiateError(null);
      const run = await instantiateApprovalWorkflowTemplate(id, {
        name: form.name.trim(),
        request_id: form.request_id.trim() || null,
        contract_id: form.contract_id.trim() || null,
      });
      setLastInstantiatedRunId(run.id);
      setInstantiateById((prev) => ({
        ...prev,
        [id]: { templateId: id, name: "", request_id: "", contract_id: "" },
      }));
    } catch (err) {
      setInstantiateError(
        err instanceof Error ? err.message : "Could not instantiate template.",
      );
    }
  }

  return (
    <div className="space-y-5" data-testid="approval-templates-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-ink">Approval Templates</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Reusable approval workflow blueprints. Instantiating a template
            creates a concrete approval workflow + steps; only the first step
            opens an Inbox item. Editing a template here does not change
            workflows that are already in flight.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-subtle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            data-testid="approval-templates-include-archived"
          />
          Show archived
        </label>
      </div>

      <section
        className="grid gap-2 rounded border border-rule p-3"
        data-testid="approval-templates-create"
      >
        <h2 className="text-sm font-medium text-ink">New approval template</h2>
        <input
          className="rounded border border-rule px-2 py-1 text-sm"
          placeholder="Template name (e.g. Standard Legal Review)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="approval-templates-name"
        />
        <textarea
          className="min-h-[3rem] rounded border border-rule px-2 py-1 text-sm"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <select
          className="rounded border border-rule px-2 py-1 text-sm"
          value={templateType}
          onChange={(e) => setTemplateType(e.target.value)}
          data-testid="approval-templates-type"
        >
          {TEMPLATE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <div className="space-y-2">
          <p className="text-xs font-medium text-ink">Steps</p>
          {steps.map((step, index) => (
            <div
              key={index}
              className="grid gap-2 rounded border border-rule p-2 sm:grid-cols-4"
              data-testid="approval-templates-step-row"
            >
              <input
                className="rounded border border-rule px-2 py-1 text-sm sm:col-span-2"
                placeholder={`Step ${index + 1} title`}
                value={step.title}
                onChange={(e) => onUpdateStep(index, "title", e.target.value)}
              />
              <input
                className="rounded border border-rule px-2 py-1 text-sm"
                placeholder="Approver email"
                value={step.approver_email}
                onChange={(e) =>
                  onUpdateStep(index, "approver_email", e.target.value)
                }
              />
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={365}
                  className="flex-1 rounded border border-rule px-2 py-1 text-sm"
                  placeholder="Due in days"
                  value={step.due_in_days}
                  onChange={(e) =>
                    onUpdateStep(index, "due_in_days", e.target.value)
                  }
                />
                {steps.length > 1 && (
                  <button
                    type="button"
                    className="rounded border border-rule px-2 py-1 text-xs hover:bg-canvas-muted"
                    onClick={() => onRemoveStep(index)}
                    aria-label={`Remove step ${index + 1}`}
                  >
                    -
                  </button>
                )}
              </div>
              <input
                className="rounded border border-rule px-2 py-1 text-sm sm:col-span-4"
                placeholder="Approver name (optional)"
                value={step.approver_name}
                onChange={(e) =>
                  onUpdateStep(index, "approver_name", e.target.value)
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="rounded border border-rule px-3 py-1 text-xs hover:bg-canvas-muted"
            onClick={onAddStep}
            data-testid="approval-templates-add-step"
          >
            + Add step
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="w-full rounded border border-ink bg-ink px-3 py-2 text-sm text-canvas disabled:opacity-50 sm:w-fit sm:py-1.5"
            onClick={onCreate}
            disabled={creating || !canCreate}
            data-testid="approval-templates-create-submit"
          >
            {creating ? "Creating…" : "Create template"}
          </button>
          {createError && (
            <span
              className="text-xs text-danger"
              data-testid="approval-templates-create-error"
            >
              {createError}
            </span>
          )}
        </div>
      </section>

      {state.kind === "loading" && (
        <p className="text-sm text-ink-muted">Loading workflow templates…</p>
      )}
      {state.kind === "error" && (
        <p
          className="text-sm text-danger"
          data-testid="approval-templates-error"
        >
          {state.message}
        </p>
      )}
      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title="No approval templates yet"
          description="Create a template above. Templates are reusable blueprints; instantiating one creates a concrete approval workflow."
        />
      )}
      {state.kind === "loaded" && state.rows.length > 0 && (
        <ul
          className="space-y-2"
          data-testid="approval-templates-list"
        >
          {state.rows.map((row) => (
            <li
              key={row.id}
              className="rounded border border-rule p-3 text-sm"
              data-testid="approval-templates-row"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="font-medium text-ink">{row.name}</p>
                  <p className="text-xs text-ink-subtle">
                    Status:{" "}
                    <span data-testid="approval-template-status">
                      {row.status}
                    </span>
                    {row.template_type ? ` · ${row.template_type}` : ""}
                    {` · ${row.steps.length} step${
                      row.steps.length === 1 ? "" : "s"
                    }`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <button
                    type="button"
                    className="rounded border border-rule px-2 py-1 hover:bg-canvas-muted"
                    onClick={() => onToggleExpand(row.id)}
                    data-testid="approval-templates-toggle-detail"
                  >
                    {expandedId === row.id ? "Hide" : "Show"}
                  </button>
                  {row.status === "active" && (
                    <button
                      type="button"
                      className="rounded border border-rule px-2 py-1 text-danger hover:bg-canvas-muted"
                      onClick={() => onArchive(row.id)}
                      data-testid="approval-templates-archive"
                    >
                      Archive
                    </button>
                  )}
                </div>
              </div>

              {expandedId === row.id && (
                <TemplateDetail
                  template={row}
                  form={
                    instantiateById[row.id] ?? {
                      templateId: row.id,
                      name: "",
                      request_id: "",
                      contract_id: "",
                    }
                  }
                  onUpdateInstantiate={onUpdateInstantiate}
                  onInstantiate={onInstantiate}
                  instantiateError={instantiateError}
                  lastInstantiatedRunId={lastInstantiatedRunId}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplateDetail({
  template,
  form,
  onUpdateInstantiate,
  onInstantiate,
  instantiateError,
  lastInstantiatedRunId,
}: {
  template: ApprovalWorkflowTemplate;
  form: InstantiateForm;
  onUpdateInstantiate: (
    id: string,
    field: keyof Omit<InstantiateForm, "templateId">,
    value: string,
  ) => void;
  onInstantiate: (id: string) => void;
  instantiateError: string | null;
  lastInstantiatedRunId: string | null;
}) {
  return (
    <div
      className="mt-3 space-y-3 border-t border-rule pt-3 text-xs"
      data-testid="approval-template-detail"
    >
      <ol className="space-y-2" data-testid="approval-templates-step-list">
        {template.steps.map((step) => (
          <li
            key={step.id}
            className="rounded border border-rule p-2"
            data-testid="approval-templates-step-detail"
          >
            <p className="font-medium text-ink">
              {step.step_order}. {step.title}
            </p>
            <p className="text-ink-subtle">
              {step.approver_email ? `${step.approver_email} · ` : ""}
              {step.due_in_days !== null
                ? `due in ${step.due_in_days} day${
                    step.due_in_days === 1 ? "" : "s"
                  }`
                : "no due offset"}
            </p>
          </li>
        ))}
      </ol>
      {template.status === "active" && (
        <div
          className="grid gap-2 rounded border border-rule p-2"
          data-testid="approval-templates-instantiate"
        >
          <p className="text-xs font-medium text-ink">
            Instantiate this template
          </p>
          <input
            className="rounded border border-rule px-2 py-1 text-sm"
            placeholder="Workflow run name"
            value={form.name}
            onChange={(e) =>
              onUpdateInstantiate(template.id, "name", e.target.value)
            }
            data-testid="approval-templates-instantiate-name"
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="rounded border border-rule px-2 py-1 text-sm"
              placeholder="Request ID (optional)"
              value={form.request_id}
              onChange={(e) =>
                onUpdateInstantiate(template.id, "request_id", e.target.value)
              }
              data-testid="approval-templates-instantiate-request"
            />
            <input
              className="rounded border border-rule px-2 py-1 text-sm"
              placeholder="Contract ID (optional)"
              value={form.contract_id}
              onChange={(e) =>
                onUpdateInstantiate(template.id, "contract_id", e.target.value)
              }
              data-testid="approval-templates-instantiate-contract"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded border border-ink bg-ink px-3 py-1.5 text-sm text-canvas disabled:opacity-50"
              onClick={() => onInstantiate(template.id)}
              disabled={
                !form.name.trim() ||
                (!form.request_id.trim() && !form.contract_id.trim())
              }
              data-testid="approval-templates-instantiate-submit"
            >
              Create workflow
            </button>
            {instantiateError && (
              <span
                className="text-xs text-danger"
                data-testid="approval-templates-instantiate-error"
              >
                {instantiateError}
              </span>
            )}
            {lastInstantiatedRunId && (
              <span
                className="text-xs text-ink-muted"
                data-testid="approval-templates-instantiate-success"
              >
                Workflow created: {lastInstantiatedRunId.slice(0, 8)}…
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
