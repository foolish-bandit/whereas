/**
 * In-process mock implementations of the backend API for demo mode.
 *
 * - Never calls fetch.
 * - Never reads/writes localStorage (the dev-user header is irrelevant here).
 * - Holds upload state in module-scoped memory; refresh wipes it. The user
 *   sees "newest first" order including any contracts they uploaded during
 *   the session, which is the only behavior worth preserving here.
 */
import { ApiError, type DownloadResult, type UploadInput } from "./api";
import {
  MOCK_DETAIL_BY_ID,
  MOCK_LIST,
  MOCK_PLAYBOOK_DETAIL_BY_ID,
  MOCK_PLAYBOOK_LIST,
  MOCK_REVIEW_BY_KEY,
} from "./mockData";
import type {
  Clause,
  ContractDetail,
  ContractListItem,
  UploadContractResponse,
} from "../types/contracts";
import type { ClauseTemplate, ClauseTemplateCreateRequest, ClauseTemplateUpdateRequest } from "../types/clauseTemplates";
import type {
  DeviationFinding,
  ListFindingsFilters,
  ReviewRunDetail,
  ReviewRunSummary,
  ReviewerFindingStatus,
} from "../types/findings";
import type { PlaybookDetail, PlaybookSummary } from "../types/playbooks";
import type { PlaybookReviewResult } from "../types/review";

interface ApiOptions {
  signal?: AbortSignal;
}

const MOCK_LATENCY_MS = 250;

const sessionList: ContractListItem[] = [];
const sessionDetailById: Record<string, ContractDetail> = {};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combinedList(): ContractListItem[] {
  return [...sessionList, ...MOCK_LIST];
}

export async function getContracts(
  options: ApiOptions = {},
): Promise<ContractListItem[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  return combinedList();
}

export async function getContract(
  id: string,
  options: ApiOptions = {},
): Promise<ContractDetail> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[id] ?? MOCK_DETAIL_BY_ID[id];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  return detail;
}

export async function getContractClauses(
  id: string,
  options: ApiOptions = {},
): Promise<Clause[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[id] ?? MOCK_DETAIL_BY_ID[id];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  return [...detail.clauses].sort((a, b) => a.ordinal - b.ordinal);
}

export async function uploadContract(
  input: UploadInput,
): Promise<UploadContractResponse> {
  await delay(MOCK_LATENCY_MS, input.signal);
  const id = `demo-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const title =
    (input.title ?? "").trim() ||
    input.file.name.replace(/\.[^.]+$/, "") ||
    "Demo upload";
  const now = new Date().toISOString();
  const mime =
    input.file.type ||
    (input.file.name.toLowerCase().endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf");
  const item: ContractListItem = {
    id,
    title,
    status: "ready",
    mime_type: mime,
    file_hash_sha256: id.padEnd(64, "0").slice(0, 64),
    page_count: null,
    created_at: now,
    updated_at: now,
  };
  const detail: ContractDetail = {
    ...item,
    full_text:
      "Demo upload. The contents of uploaded files are not parsed in demo " +
      "mode. Switch to a real backend (clear VITE_WHEREAS_DEMO_MODE) to " +
      "exercise the extraction pipeline.",
    extracted_fields: [],
    clauses: [],
  };
  sessionList.unshift(item);
  sessionDetailById[id] = detail;
  return { ...item, extracted_fields: [], clauses: [], message: null };
}

export async function downloadContract(
  id: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[id] ?? MOCK_DETAIL_BY_ID[id];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  const filename = (() => {
    const safe = detail.title.replace(/[^A-Za-z0-9._-]+/g, "_") || "contract";
    return `${safe}.demo.txt`.slice(0, 180);
  })();
  const body =
    `Whereas demo mode placeholder.\n\n` +
    `Title: ${detail.title}\n` +
    `Contract id: ${detail.id}\n\n` +
    `No real document is stored in demo mode. To exercise the actual ` +
    `download flow, run Whereas locally with a backend and clear ` +
    `VITE_WHEREAS_DEMO_MODE.\n`;
  return {
    blob: new Blob([body], { type: "text/plain" }),
    filename,
    mimeType: "text/plain",
  };
}

export async function getPlaybooks(
  options: ApiOptions & { includeInactive?: boolean } = {},
): Promise<PlaybookSummary[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  if (options.includeInactive) {
    return MOCK_PLAYBOOK_LIST;
  }
  return MOCK_PLAYBOOK_LIST.filter((p) => p.is_active);
}

export async function getPlaybook(
  id: string,
  options: ApiOptions & { includeInactive?: boolean } = {},
): Promise<PlaybookDetail> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = MOCK_PLAYBOOK_DETAIL_BY_ID[id];
  if (!detail) {
    throw new ApiError(404, "Playbook not found.");
  }
  if (!detail.is_active && !options.includeInactive) {
    throw new ApiError(404, "Playbook not found.");
  }
  return detail;
}

export async function reviewContractWithPlaybook(
  contractId: string,
  playbookId: string,
  options: ApiOptions = {},
): Promise<PlaybookReviewResult> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  const playbook = MOCK_PLAYBOOK_DETAIL_BY_ID[playbookId];
  if (!playbook) {
    throw new ApiError(404, "Playbook not found.");
  }
  if (!playbook.is_active) {
    // Symmetric with the live API: inactive playbooks 404 in review.
    throw new ApiError(404, "Playbook not found.");
  }
  if (detail.clauses.length === 0) {
    throw new ApiError(
      409,
      "Contract has no segmented clauses to review yet.",
    );
  }
  const result = MOCK_REVIEW_BY_KEY[`${contractId}|${playbookId}`];
  if (!result) {
    // Demo-only fallback: this combination was not pre-baked. Return an
    // empty review so the UI renders the "no rules ran" state cleanly.
    return {
      playbook_id: playbookId,
      playbook_name: playbook.name,
      contract_id: contractId,
      rules_checked: 0,
      passed_count: 0,
      failed_count: 0,
      results: [],
    };
  }
  return result;
}

// --------------------------------------------------------------------------
// Persisted playbook review (demo)
//
// Demo mode keeps a tiny in-memory store of review runs and findings so
// the Run/Save flow on the contract workspace exercises the same wire
// shapes as the live backend. State is cleared by `__resetMockState`
// and on page refresh; we don't pretend to provide durability here.
// --------------------------------------------------------------------------

interface DemoRun {
  summary: ReviewRunSummary;
  findings: DeviationFinding[];
  // Persist the matcher's full per-rule results so re-fetching a run
  // returns the same passes/fails the run was created with.
  results: ReviewRunDetail["results"];
}

const sessionRunsByContract: Record<string, DemoRun[]> = {};
const sessionFindingsById: Record<string, DeviationFinding> = {};

function _runId(): string {
  return `demo-run-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function _findingId(): string {
  return `demo-finding-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function _supersedeOpenFindings(
  contractId: string,
  playbookId: string,
): void {
  const runs = sessionRunsByContract[contractId];
  if (!runs) return;
  for (const run of runs) {
    if (run.summary.playbook_id !== playbookId) continue;
    for (const f of run.findings) {
      if (f.finding_status === "open") {
        f.finding_status = "superseded";
      }
    }
  }
}

function _buildFindingFromResult(
  contractId: string,
  playbookId: string,
  runId: string,
  organizationId: string,
  result: ReviewRunDetail["results"][number],
  now: string,
): DeviationFinding {
  const id = _findingId();
  return {
    id,
    organization_id: organizationId,
    contract_id: contractId,
    playbook_id: playbookId,
    review_run_id: runId,
    rule_id: result.rule_id,
    rule_title: result.title,
    rule_type: result.rule_type,
    clause_type: result.clause_type,
    severity: result.severity,
    status: result.status,
    finding_status: "open",
    message: result.message,
    clause_id: result.clause_id,
    evidence_text: result.evidence_text,
    span_start: result.span_start,
    span_end: result.span_end,
    matched_terms: [...result.matched_terms],
    expected_value: result.expected_value,
    guidance: result.guidance,
    preferred_language: result.preferred_language,
    created_at: now,
    updated_at: now,
  };
}

const DEMO_ORG_ID = "00000000-0000-4000-8000-0000000000aa";

export async function createPlaybookReviewRun(
  contractId: string,
  playbookId: string,
  options: ApiOptions = {},
): Promise<ReviewRunDetail> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  const playbook = MOCK_PLAYBOOK_DETAIL_BY_ID[playbookId];
  if (!playbook) {
    throw new ApiError(404, "Playbook not found.");
  }
  if (!playbook.is_active) {
    throw new ApiError(404, "Playbook not found.");
  }
  if (detail.clauses.length === 0) {
    throw new ApiError(
      409,
      "Contract has no segmented clauses to review yet.",
    );
  }

  // Use the canned review for the (contract, playbook) pair if one
  // exists; otherwise produce an empty run, mirroring the transient
  // demo path.
  const transient = MOCK_REVIEW_BY_KEY[`${contractId}|${playbookId}`];
  const results = transient ? transient.results : [];
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.length - passed;
  const now = new Date().toISOString();

  _supersedeOpenFindings(contractId, playbookId);

  const runIdValue = _runId();
  const summary: ReviewRunSummary = {
    id: runIdValue,
    organization_id: DEMO_ORG_ID,
    contract_id: contractId,
    playbook_id: playbookId,
    playbook_name: playbook.name,
    rules_checked: results.length,
    passed_count: passed,
    failed_count: failed,
    created_at: now,
  };

  const findings: DeviationFinding[] = results
    .filter((r) => r.status === "fail")
    .map((r) =>
      _buildFindingFromResult(
        contractId,
        playbookId,
        runIdValue,
        DEMO_ORG_ID,
        r,
        now,
      ),
    );
  for (const f of findings) {
    sessionFindingsById[f.id] = f;
  }

  const run: DemoRun = { summary, findings, results: [...results] };
  const list = sessionRunsByContract[contractId] ?? [];
  list.unshift(run);
  sessionRunsByContract[contractId] = list;

  return {
    ...summary,
    findings,
    results: [...results],
  };
}

export async function listPlaybookReviewRuns(
  contractId: string,
  options: ApiOptions = {},
): Promise<ReviewRunSummary[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  const runs = sessionRunsByContract[contractId] ?? [];
  return runs.map((r) => ({ ...r.summary }));
}

export async function getPlaybookReviewRun(
  contractId: string,
  runId: string,
  options: ApiOptions = {},
): Promise<ReviewRunDetail> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  const run = (sessionRunsByContract[contractId] ?? []).find(
    (r) => r.summary.id === runId,
  );
  if (!run) {
    throw new ApiError(404, "Review run not found.");
  }
  return {
    ...run.summary,
    findings: run.findings.map((f) => ({ ...f })),
    results: [...run.results],
  };
}

export async function listContractFindings(
  contractId: string,
  filters: ListFindingsFilters = {},
  options: ApiOptions = {},
): Promise<DeviationFinding[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  const allFindings = (sessionRunsByContract[contractId] ?? []).flatMap(
    (r) => r.findings,
  );
  return allFindings
    .filter((f) => {
      if (filters.playbook_id && f.playbook_id !== filters.playbook_id) {
        return false;
      }
      if (
        filters.finding_status &&
        f.finding_status !== filters.finding_status
      ) {
        return false;
      }
      if (filters.severity && f.severity !== filters.severity) {
        return false;
      }
      if (
        filters.review_run_id &&
        f.review_run_id !== filters.review_run_id
      ) {
        return false;
      }
      if (
        !filters.include_superseded &&
        !filters.finding_status &&
        f.finding_status === "superseded"
      ) {
        return false;
      }
      return true;
    })
    .map((f) => ({ ...f }));
}

export async function updateFindingStatus(
  contractId: string,
  findingId: string,
  status: ReviewerFindingStatus,
  options: ApiOptions = {},
): Promise<DeviationFinding> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  const finding = sessionFindingsById[findingId];
  if (!finding || finding.contract_id !== contractId) {
    throw new ApiError(404, "Finding not found.");
  }
  finding.finding_status = status;
  finding.updated_at = new Date().toISOString();
  return { ...finding };
}

/**
 * Test helper. Clears any uploads recorded during a vitest run so tests
 * don't leak state.
 */
export function __resetMockState(): void {
  sessionList.length = 0;
  for (const k of Object.keys(sessionDetailById)) {
    delete sessionDetailById[k];
  }
  for (const k of Object.keys(sessionRunsByContract)) {
    delete sessionRunsByContract[k];
  }
  for (const k of Object.keys(sessionFindingsById)) {
    delete sessionFindingsById[k];
  }
  sessionClauseTemplates.length = 0;
}

const DEMO_CLAUSE_TEMPLATES: ClauseTemplate[] = [
  { id: "ct-1", organization_id: "demo-org", name: "Mutual NDA confidentiality clause", clause_type: "confidentiality", text: "Each Party shall keep Confidential Information strictly confidential...", description: "Baseline NDA confidentiality", jurisdiction: "California", contract_type: "mutual_nda", version: "1.0", source: "Firm standard", tags: ["nda","core"], is_active: true, created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" },
  { id: "ct-2", organization_id: "demo-org", name: "Governing law clause", clause_type: "governing_law", text: "This Agreement is governed by California law...", description: null, jurisdiction: "California", contract_type: "msa", version: "1.0", source: null, tags: ["governing-law"], is_active: true, created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" },
  { id: "ct-3", organization_id: "demo-org", name: "Assignment clause", clause_type: "assignment", text: "Neither Party may assign this Agreement without prior written consent...", description: null, jurisdiction: null, contract_type: "msa", version: null, source: null, tags: ["assignment"], is_active: true, created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" },
];

const sessionClauseTemplates: ClauseTemplate[] = [];

export async function listClauseTemplates(filters: { clause_type?: string; jurisdiction?: string; contract_type?: string; tag?: string; include_inactive?: boolean } = {}, options: ApiOptions = {}): Promise<ClauseTemplate[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  let rows = [...sessionClauseTemplates, ...DEMO_CLAUSE_TEMPLATES];
  if (!filters.include_inactive) rows = rows.filter((r) => r.is_active);
  if (filters.clause_type) rows = rows.filter((r) => r.clause_type === filters.clause_type);
  if (filters.jurisdiction) rows = rows.filter((r) => r.jurisdiction === filters.jurisdiction);
  if (filters.contract_type) rows = rows.filter((r) => r.contract_type === filters.contract_type);
  if (filters.tag) rows = rows.filter((r) => r.tags.includes(filters.tag!));
  return rows;
}

export async function createClauseTemplate(payload: ClauseTemplateCreateRequest, options: ApiOptions = {}): Promise<ClauseTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const now = new Date().toISOString();
  const row: ClauseTemplate = { id: `ct-${Date.now()}`, organization_id: "demo-org", is_active: true, created_at: now, updated_at: now, description: null, jurisdiction: null, contract_type: null, version: null, source: null, ...payload, tags: payload.tags ?? [] };
  sessionClauseTemplates.unshift(row);
  return row;
}

export async function getClauseTemplate(id: string, options: ApiOptions = {}): Promise<ClauseTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = [...sessionClauseTemplates, ...DEMO_CLAUSE_TEMPLATES].find((r) => r.id === id);
  if (!row) throw new ApiError(404, "Clause template not found.");
  return row;
}

export async function updateClauseTemplate(id: string, payload: ClauseTemplateUpdateRequest, options: ApiOptions = {}): Promise<ClauseTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const idx = sessionClauseTemplates.findIndex((r) => r.id === id);
  if (idx < 0) throw new ApiError(404, "Clause template not found.");
  const updated = { ...sessionClauseTemplates[idx], ...payload, updated_at: new Date().toISOString(), tags: payload.tags ?? sessionClauseTemplates[idx].tags };
  sessionClauseTemplates[idx] = updated;
  return updated;
}

export async function deleteClauseTemplate(id: string, options: ApiOptions = {}): Promise<void> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const rows = [...sessionClauseTemplates, ...DEMO_CLAUSE_TEMPLATES];
  const row = rows.find((r) => r.id === id);
  if (!row) throw new ApiError(404, "Clause template not found.");
  if (sessionClauseTemplates.find((r) => r.id === id)) {
    await updateClauseTemplate(id, { is_active: false }, options);
  }
}
