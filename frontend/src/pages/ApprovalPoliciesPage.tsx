import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { archiveApprovalPolicy, createApprovalPolicy, listAgreementTemplates, listApprovalPolicies, listApprovalWorkflowTemplates } from "../lib/api";
import {
  DEEP_LINK_HIGHLIGHT_CLASS,
  scrollDeepLinkIntoView,
} from "../lib/deepLinkHighlight";
import type { AgreementTemplate } from "../types/agreementTemplates";
import type { ApprovalPolicy, ApprovalPolicyCreateRequest } from "../types/approvalPolicies";
import type { ApprovalWorkflowTemplate } from "../types/approvalWorkflowTemplates";

export default function ApprovalPoliciesPage() {
  const [rows, setRows] = useState<ApprovalPolicy[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<ApprovalWorkflowTemplate[]>([]);
  const [agreementTemplates, setAgreementTemplates] = useState<AgreementTemplate[]>([]);
  const [form, setForm] = useState<ApprovalPolicyCreateRequest>({ name: "", workflow_template_id: "", auto_attach: true, applies_to_generated_contracts: true });

  // PR #61: ?policy_id=<id> is the gate-remediation deep-link target.
  // We highlight the matching policy and scroll it into view; if the
  // policy isn't in the current list (the page hides archived by
  // default) we automatically flip on `Include archived` once and
  // surface a notice if it's still not found.
  const [searchParams] = useSearchParams();
  const deepLinkPolicyId = searchParams.get("policy_id");
  const deepLinkRowRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether we've already auto-toggled archived for this id so
  // we don't fight the user if they turn it back off.
  const autoArchivedRef = useRef<string | null>(null);

  const load = () => { setLoading(true); listApprovalPolicies({ include_archived: includeArchived }).then(setRows).catch((e) => setError(e.message)).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, [includeArchived]);
  useEffect(() => { listApprovalWorkflowTemplates({ include_archived: true }).then(setTemplates).catch(() => undefined); listAgreementTemplates({ include_archived: true }).then(setAgreementTemplates).catch(() => undefined); }, []);

  const deepLinkRowFound =
    deepLinkPolicyId !== null && rows.some((r) => r.id === deepLinkPolicyId);

  useEffect(() => {
    if (!deepLinkPolicyId) return;
    if (loading) return;
    if (deepLinkRowFound) return;
    if (includeArchived) return;
    if (autoArchivedRef.current === deepLinkPolicyId) return;
    autoArchivedRef.current = deepLinkPolicyId;
    setIncludeArchived(true);
  }, [deepLinkPolicyId, deepLinkRowFound, loading, includeArchived]);

  useEffect(() => {
    if (!deepLinkPolicyId) return;
    if (!deepLinkRowFound) return;
    scrollDeepLinkIntoView(deepLinkRowRef.current);
  }, [deepLinkPolicyId, deepLinkRowFound, rows.length]);

  async function submit() {
    setError(null);
    if (!form.name?.trim() || !form.workflow_template_id?.trim()) { setError("Name and workflow template are required."); return; }
    await createApprovalPolicy({ ...form, request_type: form.request_type || null, contract_type: form.contract_type || null, priority: form.priority || null, agreement_template_id: form.agreement_template_id || null });
    setForm({ name: "", workflow_template_id: "", auto_attach: true, applies_to_generated_contracts: true });
    load();
  }

  return <div className="space-y-4" data-testid="approval-policies-page"><h1 className="text-lg font-semibold">Approval Policies</h1><p className="text-sm text-ink-muted">Policies match requests and automatically attach approval workflow templates. They also inform whether a request-linked contract can be sent for signature.</p>
    <label className="text-sm"><input type="checkbox" checked={includeArchived} onChange={(e)=>setIncludeArchived(e.target.checked)} /> Include archived</label>
    {deepLinkPolicyId && !loading && !deepLinkRowFound && (
      <p
        className="rounded border border-warning bg-warning/10 px-3 py-2 text-xs text-ink"
        data-testid="approval-policies-deep-link-not-found"
      >
        The linked approval policy <code>{deepLinkPolicyId}</code> was not
        found in the current view.
      </p>
    )}
    <div className="rounded border p-3 space-y-2"><h2 className="font-medium">Create policy</h2>
      <input placeholder="Name" value={form.name ?? ""} onChange={(e)=>setForm({...form, name:e.target.value})} className="w-full border rounded px-2 py-1"/>
      <textarea placeholder="Description" value={form.description ?? ""} onChange={(e)=>setForm({...form, description:e.target.value})} className="w-full border rounded px-2 py-1"/>
      <select value={form.workflow_template_id} onChange={(e)=>setForm({...form, workflow_template_id:e.target.value})} className="w-full border rounded px-2 py-1"><option value="">Select workflow template</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>
      <input placeholder="Request type (Any)" value={form.request_type ?? ""} onChange={(e)=>setForm({...form, request_type:e.target.value})} className="w-full border rounded px-2 py-1"/>
      <input placeholder="Contract type (Any)" value={form.contract_type ?? ""} onChange={(e)=>setForm({...form, contract_type:e.target.value})} className="w-full border rounded px-2 py-1"/>
      <input placeholder="Priority (Any)" value={form.priority ?? ""} onChange={(e)=>setForm({...form, priority:e.target.value})} className="w-full border rounded px-2 py-1"/>
      <select value={form.agreement_template_id ?? ""} onChange={(e)=>setForm({...form, agreement_template_id:e.target.value})} className="w-full border rounded px-2 py-1"><option value="">Any agreement template</option>{agreementTemplates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>
      <label><input type="checkbox" checked={form.auto_attach ?? true} onChange={(e)=>setForm({...form, auto_attach:e.target.checked})}/> Auto attach</label>
      <label><input type="checkbox" checked={form.applies_to_generated_contracts ?? true} onChange={(e)=>setForm({...form, applies_to_generated_contracts:e.target.checked})}/> Applies to generated contracts</label>
      <button onClick={submit} className="border px-2 py-1 rounded">Create</button>
    </div>
    {loading ? <p>Loading…</p> : rows.length===0 ? <p>No approval policies found.</p> : <div className="space-y-2">{rows.map(r => {
      const isDeepLinkTarget = r.id === deepLinkPolicyId;
      return (
      <div
        key={r.id}
        ref={isDeepLinkTarget ? deepLinkRowRef : undefined}
        className={`border rounded p-2 ${isDeepLinkTarget ? DEEP_LINK_HIGHLIGHT_CLASS : ""}`}
        data-testid="approval-policy-row"
        data-deep-link-target={isDeepLinkTarget ? "true" : undefined}
        aria-label={isDeepLinkTarget ? "Linked approval policy from approval gate" : undefined}
      ><div className="flex justify-between"><strong>{r.name}</strong><button onClick={async()=>{await archiveApprovalPolicy(r.id);load();}}>Archive</button></div><p className="text-xs">{r.status} · Workflow: {templates.find(t=>t.id===r.workflow_template_id)?.name ?? r.workflow_template_id}</p><p className="text-xs">Match: req={r.request_type ?? "Any"}, contract={r.contract_type ?? "Any"}, priority={r.priority ?? "Any"}, agreement={agreementTemplates.find(t=>t.id===r.agreement_template_id)?.name ?? r.agreement_template_id ?? "Any"}</p></div>
      );
    })}</div>}
    {error && <p className="text-danger" data-testid="approval-policies-error">{error}</p>}
  </div>
}
