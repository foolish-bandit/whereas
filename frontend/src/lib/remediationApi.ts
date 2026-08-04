import type { DeviationFinding } from "../types/findings";
import type { InboxItem } from "../types/inboxItems";
import type {
  FindingRemediationPlan,
  FindingRemediationSourceType,
  FindingRemediationTaskRequest,
  FindingRemediationTaskResponse,
} from "../types/remediation";
import { ApiError, MissingDevUserError } from "./api";
import { getDevUserId } from "./devUser";
import { isDemoMode } from "./env";
import * as mockApi from "./mockApi";

interface ApiOptions {
  signal?: AbortSignal;
}

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEMO_LATENCY_MS = 120;

const SECRET_KEYS = new Set([
  "wrapped_dek",
  "wrapped_master_key",
  "s3_key",
  "storage_key",
  "presigned_url",
  "presigned_uri",
  "private_url",
  "docuseal_webhook_secret",
  "docuseal_api_token",
]);

interface DemoApprovedSource {
  id: string;
  name: string;
  text: string;
  scopeWarning: string | null;
}

const DEMO_APPROVED_SOURCES: Record<string, DemoApprovedSource> = {
  governing_law: {
    id: "00000000-0000-4000-8000-000000000201",
    name: "California Governing Law",
    text:
      "This Agreement is governed by the laws of the State of California, without regard to its conflict-of-laws principles.",
    scopeWarning:
      "This demo Clause Manager source is scoped to California. Confirm it fits the Repository record before using it.",
  },
  assignment: {
    id: "00000000-0000-4000-8000-000000000202",
    name: "Prior Written Consent Assignment",
    text:
      "Neither party may assign this Agreement without the other party's prior written consent, except to a successor in connection with a merger or sale of substantially all assets.",
    scopeWarning: null,
  },
  confidentiality: {
    id: "00000000-0000-4000-8000-000000000203",
    name: "Mutual Confidentiality Standard",
    text:
      "Each party shall protect the other party's Confidential Information using at least reasonable care and use it only to perform under this Agreement.",
    scopeWarning: null,
  },
};

// Store only the shared mock Inbox identifier. The task itself remains owned
// by mockApi, so completion, dismissal, filtering, and reopening stay coherent
// across the remediation card and Inbox page.
const demoTaskIdByFindingId = new Map<string, string>();

function baseUrl(): string {
  const configured = (import.meta.env.VITE_API_BASE_URL ?? "").trim();
  return configured || DEFAULT_BASE_URL;
}

function devHeaders(): Record<string, string> {
  const userId = getDevUserId();
  if (!userId) throw new MissingDevUserError();
  return { "X-Whereas-Dev-User": userId };
}

function scrubSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => scrubSecrets(entry)) as T;
  }
  if (value && typeof value === "object") {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SECRET_KEYS.has(key)) continue;
      scrubbed[key] = scrubSecrets(entry);
    }
    return scrubbed as T;
  }
  return value;
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as unknown;
    if (payload && typeof payload === "object") {
      const detail = (payload as Record<string, unknown>).detail;
      if (typeof detail === "string" && detail.trim()) return detail;
      if (detail && typeof detail === "object") {
        const message = (detail as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) return message;
      }
    }
  } catch {
    // Non-JSON error bodies fall through to a status-based message.
  }
  if (response.status === 401) return "The development user ID is invalid.";
  if (response.status === 404) return "Finding not found.";
  if (response.status === 409) {
    return "The remediation task could not be created safely.";
  }
  if (response.status === 422) return "The remediation request is invalid.";
  return `Request failed (HTTP ${response.status}).`;
}

async function request<T>(
  path: string,
  init: RequestInit,
  options: ApiOptions,
): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(devHeaders())) {
    headers.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ApiError(
      0,
      "Could not reach the backend. Is the API running?",
      error instanceof Error ? error.message : undefined,
    );
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readError(response));
  }

  try {
    return scrubSecrets((await response.json()) as T);
  } catch {
    throw new ApiError(
      response.status,
      "The server returned an unexpected response.",
    );
  }
}

export async function getFindingRemediationPlan(
  contractId: string,
  finding: DeviationFinding,
  options: ApiOptions = {},
): Promise<FindingRemediationPlan> {
  if (isDemoMode()) {
    await delay(DEMO_LATENCY_MS, options.signal);
    return buildDemoPlan(contractId, finding, options);
  }
  return request<FindingRemediationPlan>(
    `/api/contracts/${encodeURIComponent(contractId)}/findings/${encodeURIComponent(
      finding.id,
    )}/remediation`,
    { method: "GET" },
    options,
  );
}

export async function createFindingRemediationTask(
  contractId: string,
  finding: DeviationFinding,
  payload: FindingRemediationTaskRequest = {},
  options: ApiOptions = {},
): Promise<FindingRemediationTaskResponse> {
  if (isDemoMode()) {
    return createDemoTask(contractId, finding, payload, options);
  }
  return request<FindingRemediationTaskResponse>(
    `/api/contracts/${encodeURIComponent(contractId)}/findings/${encodeURIComponent(
      finding.id,
    )}/remediation/task`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
}

async function buildDemoPlan(
  contractId: string,
  finding: DeviationFinding,
  options: ApiOptions,
): Promise<FindingRemediationPlan> {
  if (finding.contract_id !== contractId) {
    throw new ApiError(404, "Finding not found.");
  }

  const preferredLanguage = finding.preferred_language?.trim() ?? "";
  let suggestedLanguage: string | null = null;
  let sourceType: FindingRemediationSourceType = "none";
  let sourceId: string | null = null;
  let sourceName: string | null = null;
  let rationale =
    "No approved language source matches this finding. Add preferred language to the playbook rule or an active Clause Manager source with the same clause type.";
  let scopeWarning: string | null = null;

  if (preferredLanguage) {
    suggestedLanguage = preferredLanguage;
    sourceType = "playbook_preferred_language";
    sourceId = finding.playbook_id;
    sourceName = finding.rule_title;
    rationale =
      "Firm-authored preferred language was stored with this playbook rule.";
  } else {
    const approved =
      DEMO_APPROVED_SOURCES[normalizeClauseType(finding.clause_type)];
    if (approved) {
      suggestedLanguage = approved.text;
      sourceType = "clause_template";
      sourceId = approved.id;
      sourceName = approved.name;
      rationale =
        "Selected the active demo Clause Manager source with the same normalized clause type.";
      scopeWarning = approved.scopeWarning;
    }
  }

  return {
    finding_id: finding.id,
    contract_id: contractId,
    review_run_id: finding.review_run_id,
    playbook_id: finding.playbook_id,
    rule_id: finding.rule_id,
    rule_title: finding.rule_title,
    clause_type: normalizeClauseType(finding.clause_type),
    severity: finding.severity,
    finding_status: finding.finding_status,
    suggested_language: suggestedLanguage,
    source_type: sourceType,
    source_id: sourceId,
    source_name: sourceName,
    rationale,
    scope_warning: scopeWarning,
    existing_task: await getDemoTask(finding.id, options),
  };
}

async function createDemoTask(
  contractId: string,
  finding: DeviationFinding,
  payload: FindingRemediationTaskRequest,
  options: ApiOptions,
): Promise<FindingRemediationTaskResponse> {
  if (finding.contract_id !== contractId) {
    throw new ApiError(404, "Finding not found.");
  }
  if (finding.finding_status === "superseded") {
    throw new ApiError(
      409,
      "This finding was superseded by a newer review. Open the latest review run before creating remediation work.",
    );
  }

  const plan = await buildDemoPlan(contractId, finding, options);
  const existing = plan.existing_task;
  if (existing && existing.status !== "dismissed") {
    return {
      plan,
      task: existing,
      created: false,
      reopened: false,
    };
  }

  if (existing?.status === "dismissed") {
    const reopened = await mockApi.updateInboxItem(
      existing.id,
      {
        title: remediationTitle(finding.rule_title),
        description: remediationDescription(finding.clause_type),
        status: "open",
        priority: priorityForSeverity(finding.severity),
        assigned_to: payload.assigned_to ?? existing.assigned_to,
        due_date: payload.due_date ?? null,
        contract_id: contractId,
        metadata_json: remediationMetadata(finding, plan),
      },
      options,
    );
    return {
      plan: { ...plan, existing_task: reopened },
      task: reopened,
      created: false,
      reopened: true,
    };
  }

  const task = await mockApi.createInboxItem(
    {
      title: remediationTitle(finding.rule_title),
      description: remediationDescription(finding.clause_type),
      item_type: "finding_remediation",
      priority: priorityForSeverity(finding.severity),
      assigned_to: payload.assigned_to ?? null,
      due_date: payload.due_date ?? null,
      contract_id: contractId,
      metadata_json: remediationMetadata(finding, plan),
    },
    options,
  );
  demoTaskIdByFindingId.set(finding.id, task.id);
  return {
    plan: { ...plan, existing_task: task },
    task,
    created: true,
    reopened: false,
  };
}

async function getDemoTask(
  findingId: string,
  options: ApiOptions,
): Promise<InboxItem | null> {
  const taskId = demoTaskIdByFindingId.get(findingId);
  if (!taskId) return null;
  try {
    return await mockApi.getInboxItem(taskId, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      demoTaskIdByFindingId.delete(findingId);
      return null;
    }
    throw error;
  }
}

function remediationMetadata(
  finding: DeviationFinding,
  plan: FindingRemediationPlan,
): Record<string, string | null> {
  return {
    finding_id: finding.id,
    review_run_id: finding.review_run_id,
    playbook_id: finding.playbook_id,
    rule_id: finding.rule_id,
    clause_type: normalizeClauseType(finding.clause_type),
    severity: finding.severity.toLowerCase(),
    source_type: plan.source_type,
    source_id: plan.source_id,
  };
}

function normalizeClauseType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function priorityForSeverity(severity: string): string {
  const normalized = severity.trim().toLowerCase();
  if (normalized === "blocker" || normalized === "critical") {
    return "urgent";
  }
  if (normalized === "high") return "high";
  if (normalized === "medium") return "normal";
  return "low";
}

function remediationTitle(ruleTitle: string): string {
  const compact = ruleTitle.trim().replace(/\s+/g, " ") || "Playbook finding";
  return `Remediate: ${compact}`.slice(0, 255);
}

function remediationDescription(clauseType: string): string {
  const friendly =
    normalizeClauseType(clauseType).replace(/_/g, " ") || "record";
  return `Review this ${friendly} finding and apply approved firm language in the linked Repository record as appropriate.`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function __resetRemediationDemoState(): void {
  demoTaskIdByFindingId.clear();
}