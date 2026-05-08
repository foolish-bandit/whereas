import { getDevUserId } from "./devUser";
import { isDemoMode } from "./env";
import * as mockApi from "./mockApi";
import type {
  Clause,
  ContractDetail,
  ContractListItem,
  ContractMarkdownSnapshot,
  UploadContractResponse,
} from "../types/contracts";
import type {
  PlaybookDetail,
  PlaybookSummary,
  PlaybookValidateResponse,
  PlaybookValidationIssue,
} from "../types/playbooks";
import type {
  DeviationFinding,
  ListFindingsFilters,
  ReviewRunDetail,
  ReviewRunSummary,
  ReviewerFindingStatus,
} from "../types/findings";
import type { PlaybookReviewResult } from "../types/review";
import type { ClauseTemplate, ClauseTemplateCreateRequest, ClauseTemplateUpdateRequest } from "../types/clauseTemplates";
import type {
  CreateDevSetupRequest,
  CreateDevSetupResponse,
  SetupStatus,
} from "../types/setup";

const DEFAULT_BASE_URL = "http://localhost:8000";

function baseUrl(): string {
  const env = (import.meta.env.VITE_API_BASE_URL ?? "").trim();
  return env || DEFAULT_BASE_URL;
}

export class MissingDevUserError extends Error {
  constructor() {
    super("Set a development user ID to call the local API.");
    this.name = "MissingDevUserError";
  }
}

export class ApiError extends Error {
  status: number;
  detail?: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

interface ApiOptions {
  signal?: AbortSignal;
}

function devHeaders(): Record<string, string> {
  const id = getDevUserId();
  if (!id) {
    throw new MissingDevUserError();
  }
  return { "X-Whereas-Dev-User": id };
}

async function readErrorMessage(response: Response): Promise<string> {
  const status = response.status;
  let detail: string | undefined;
  try {
    const data = await response.json();
    if (data && typeof data === "object") {
      const d = (data as Record<string, unknown>).detail;
      if (typeof d === "string") {
        detail = d;
      } else if (d && typeof d === "object") {
        const msg = (d as Record<string, unknown>).message;
        if (typeof msg === "string") detail = msg;
      }
    }
  } catch {
    // body is not JSON; fall through to status-based message
  }
  if (detail) return detail;
  return defaultMessageForStatus(status);
}

function defaultMessageForStatus(status: number): string {
  switch (status) {
    case 400:
      return "The request was rejected by the server.";
    case 401:
      return "The development user ID is missing or invalid.";
    case 403:
      return "This user is not permitted to perform that action.";
    case 404:
      return "Not found.";
    case 409:
      return "This contract already exists or its keys are not initialized.";
    case 413:
      return "The uploaded file is too large.";
    case 422:
      return "The document could not be parsed.";
    case 500:
      return "The server failed to handle the request.";
    case 503:
      return "The backend is not available.";
    default:
      return `Request failed (HTTP ${status}).`;
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    throw new ApiError(
      response.status,
      "The server returned an empty response.",
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(
      response.status,
      "The server returned an unexpected response.",
    );
  }
}

async function dispatch<T>(
  path: string,
  init: RequestInit,
  headers: Headers,
  options: ApiOptions,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers,
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw new ApiError(
      0,
      "Could not reach the backend. Is the API running?",
      err instanceof Error ? err.message : undefined,
    );
  }
  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new ApiError(response.status, message);
  }
  return parseJson<T>(response);
}

async function call<T>(
  path: string,
  init: RequestInit,
  options: ApiOptions = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(devHeaders())) {
    headers.set(k, v);
  }
  return dispatch<T>(path, init, headers, options);
}

/**
 * Like `call()` but does NOT include the X-Whereas-Dev-User header. Used
 * by endpoints that exist precisely to bootstrap the dev user
 * (i.e. /api/setup/*).
 */
async function callPublic<T>(
  path: string,
  init: RequestInit,
  options: ApiOptions = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  return dispatch<T>(path, init, headers, options);
}

const SECRET_KEYS = new Set([
  "wrapped_dek",
  "wrapped_master_key",
  "s3_key",
  "presigned_url",
  "presigned_uri",
]);

/**
 * Defensive scrub: strip any encryption / storage internals from a payload
 * before it reaches components, even if the backend regresses and starts
 * returning them.
 */
function scrubSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => scrubSecrets(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) continue;
      out[k] = scrubSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}

export async function getContracts(
  options: ApiOptions = {},
): Promise<ContractListItem[]> {
  if (isDemoMode()) return mockApi.getContracts(options);
  const data = await call<ContractListItem[]>(
    "/api/contracts",
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function getContract(
  id: string,
  options: ApiOptions = {},
): Promise<ContractDetail> {
  if (isDemoMode()) return mockApi.getContract(id, options);
  const data = await call<ContractDetail>(
    `/api/contracts/${encodeURIComponent(id)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

/**
 * Fetch the latest Markdown working snapshot for a contract.
 *
 * Returns ``null`` when the backend reports no snapshot (HTTP 404).
 * Other errors propagate as ``ApiError`` so callers can show the same
 * banners they show for other contract API failures. Demo mode is not
 * supported yet — callers should hide or stub the call there until
 * mock data exists.
 */
export async function getContractMarkdown(
  id: string,
  options: ApiOptions = {},
): Promise<ContractMarkdownSnapshot | null> {
  if (isDemoMode()) return null;
  try {
    const data = await call<ContractMarkdownSnapshot>(
      `/api/contracts/${encodeURIComponent(id)}/markdown`,
      { method: "GET" },
      options,
    );
    return scrubSecrets(data);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function getContractClauses(
  id: string,
  options: ApiOptions = {},
): Promise<Clause[]> {
  if (isDemoMode()) return mockApi.getContractClauses(id, options);
  const data = await call<Clause[]>(
    `/api/contracts/${encodeURIComponent(id)}/clauses`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export interface UploadInput {
  file: File;
  title?: string;
  signal?: AbortSignal;
}

export async function uploadContract(
  input: UploadInput,
): Promise<UploadContractResponse> {
  if (isDemoMode()) return mockApi.uploadContract(input);
  const formData = new FormData();
  formData.append("file", input.file);
  const trimmedTitle = (input.title ?? "").trim();
  if (trimmedTitle) {
    formData.append("title", trimmedTitle);
  }
  const data = await call<UploadContractResponse>(
    "/api/contracts/upload",
    {
      method: "POST",
      body: formData,
    },
    { signal: input.signal },
  );
  return scrubSecrets(data);
}

export interface DownloadResult {
  blob: Blob;
  filename: string | null;
  mimeType: string;
}

const FILENAME_RE = /filename="([^"]+)"/i;

export async function downloadContract(
  id: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  if (isDemoMode()) return mockApi.downloadContract(id, options);
  const headers = new Headers();
  for (const [k, v] of Object.entries(devHeaders())) {
    headers.set(k, v);
  }
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl()}/api/contracts/${encodeURIComponent(id)}/download`,
      { method: "GET", headers, signal: options.signal },
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw new ApiError(
      0,
      "Could not reach the backend. Is the API running?",
      err instanceof Error ? err.message : undefined,
    );
  }
  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new ApiError(response.status, message);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const m = FILENAME_RE.exec(disposition);
  return {
    blob,
    filename: m ? m[1] : null,
    mimeType: response.headers.get("Content-Type") ?? blob.type,
  };
}

// --------------------------------------------------------------------------
// First-run setup (dev only). Endpoints are open and DO NOT require the
// X-Whereas-Dev-User header — they exist to bootstrap that user.
//
// In demo mode these helpers throw a clean ApiError instead of dispatching:
// the setup card is hidden in demo mode so this is just a safety rail
// against accidental calls.
// --------------------------------------------------------------------------

export async function getSetupStatus(
  options: ApiOptions = {},
): Promise<SetupStatus> {
  if (isDemoMode()) {
    throw new ApiError(
      400,
      "Setup is not available in demo mode.",
    );
  }
  return callPublic<SetupStatus>("/api/setup/status", { method: "GET" }, options);
}

export async function createDevSetup(
  payload: CreateDevSetupRequest = {},
  options: ApiOptions = {},
): Promise<CreateDevSetupResponse> {
  if (isDemoMode()) {
    throw new ApiError(
      400,
      "Setup is not available in demo mode.",
    );
  }
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  };
  return callPublic<CreateDevSetupResponse>("/api/setup/dev", init, options);
}

// --------------------------------------------------------------------------
// Playbooks
//
// In demo mode, GET / list calls return the static demo data from
// `mockApi`; create/validate/deactivate are not supported in demo mode
// because a "saved" playbook in a stateless preview would mislead.
// --------------------------------------------------------------------------

/**
 * Thrown by `validatePlaybook` and `createPlaybook` when the server
 * rejects the YAML with structured per-field validation errors.
 *
 * The router returns 400 with `{detail: {ok: false, errors: [...]}}`,
 * which `readErrorMessage` would otherwise flatten to a single string.
 * This subclass preserves the issue list so the UI can render
 * per-field markers.
 */
export class PlaybookValidationError extends ApiError {
  issues: PlaybookValidationIssue[];

  constructor(issues: PlaybookValidationIssue[]) {
    const message =
      issues.length > 0
        ? issues.map((i) => i.message).join("; ")
        : "Playbook validation failed.";
    super(400, message);
    this.name = "PlaybookValidationError";
    this.issues = issues;
  }
}

interface BackendValidationDetail {
  ok: false;
  errors: PlaybookValidationIssue[];
}

function isValidationDetail(value: unknown): value is BackendValidationDetail {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.ok !== false) return false;
  if (!Array.isArray(v.errors)) return false;
  return v.errors.every(
    (e) => e && typeof e === "object" && typeof (e as { message: unknown }).message === "string",
  );
}

async function dispatchPlaybookWrite<T>(
  path: string,
  body: unknown,
  options: ApiOptions = {},
): Promise<T> {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [k, v] of Object.entries(devHeaders())) {
    headers.set(k, v);
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw new ApiError(
      0,
      "Could not reach the backend. Is the API running?",
      err instanceof Error ? err.message : undefined,
    );
  }
  if (response.status === 400) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    const detail =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).detail
        : undefined;
    if (isValidationDetail(detail)) {
      throw new PlaybookValidationError(detail.errors);
    }
    const message = await readErrorMessage(
      new Response(parsed === undefined ? "" : JSON.stringify(parsed), {
        status: 400,
      }),
    );
    throw new ApiError(400, message);
  }
  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new ApiError(response.status, message);
  }
  return parseJson<T>(response);
}

export async function getPlaybooks(
  options: ApiOptions & { includeInactive?: boolean } = {},
): Promise<PlaybookSummary[]> {
  if (isDemoMode()) return mockApi.getPlaybooks(options);
  const qs = options.includeInactive ? "?include_inactive=true" : "";
  const data = await call<PlaybookSummary[]>(
    `/api/playbooks${qs}`,
    { method: "GET" },
    { signal: options.signal },
  );
  return scrubSecrets(data);
}

export async function getPlaybook(
  id: string,
  options: ApiOptions & { includeInactive?: boolean } = {},
): Promise<PlaybookDetail> {
  if (isDemoMode()) return mockApi.getPlaybook(id, options);
  const qs = options.includeInactive ? "?include_inactive=true" : "";
  const data = await call<PlaybookDetail>(
    `/api/playbooks/${encodeURIComponent(id)}${qs}`,
    { method: "GET" },
    { signal: options.signal },
  );
  return scrubSecrets(data);
}

export async function validatePlaybook(
  yamlSource: string,
  options: ApiOptions = {},
): Promise<PlaybookValidateResponse> {
  if (isDemoMode()) {
    throw new ApiError(
      400,
      "Playbook validation is not available in demo mode.",
    );
  }
  return dispatchPlaybookWrite<PlaybookValidateResponse>(
    "/api/playbooks/validate",
    { yaml_source: yamlSource },
    options,
  );
}

export async function createPlaybook(
  yamlSource: string,
  options: ApiOptions = {},
): Promise<PlaybookDetail> {
  if (isDemoMode()) {
    throw new ApiError(
      400,
      "Playbook creation is not available in demo mode.",
    );
  }
  const data = await dispatchPlaybookWrite<PlaybookDetail>(
    "/api/playbooks",
    { yaml_source: yamlSource },
    options,
  );
  return scrubSecrets(data);
}

export async function deactivatePlaybook(
  id: string,
  options: ApiOptions = {},
): Promise<PlaybookSummary> {
  if (isDemoMode()) {
    throw new ApiError(
      400,
      "Playbook deactivation is not available in demo mode.",
    );
  }
  const data = await call<PlaybookSummary>(
    `/api/playbooks/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    options,
  );
  return scrubSecrets(data);
}

// --------------------------------------------------------------------------
// Playbook review (transient, deterministic)
//
// PR #21 surface. Results are not persisted — every call recomputes
// against the contract's current clauses. In demo mode this returns a
// hardcoded result for the sample NDA + sample playbook.
// --------------------------------------------------------------------------

export async function reviewContractWithPlaybook(
  contractId: string,
  playbookId: string,
  options: ApiOptions = {},
): Promise<PlaybookReviewResult> {
  if (isDemoMode()) {
    return mockApi.reviewContractWithPlaybook(contractId, playbookId, options);
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [k, v] of Object.entries(devHeaders())) {
    headers.set(k, v);
  }
  const init: RequestInit = {
    method: "POST",
    body: JSON.stringify({ playbook_id: playbookId }),
  };
  const data = await dispatch<PlaybookReviewResult>(
    `/api/contracts/${encodeURIComponent(contractId)}/playbook-review`,
    init,
    headers,
    options,
  );
  return scrubSecrets(data);
}

// --------------------------------------------------------------------------
// Persisted playbook review (runs + findings)
//
// PR #22 surface. Creating a run persists the matcher's failed outcomes
// as `DeviationFinding` rows under a parent `PlaybookReviewRun`; passes
// are not stored. Reviewers can update each finding's `finding_status`
// (open / reviewed / ignored) via PATCH.
// --------------------------------------------------------------------------

export async function createPlaybookReviewRun(
  contractId: string,
  playbookId: string,
  options: ApiOptions = {},
): Promise<ReviewRunDetail> {
  if (isDemoMode()) {
    return mockApi.createPlaybookReviewRun(contractId, playbookId, options);
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [k, v] of Object.entries(devHeaders())) {
    headers.set(k, v);
  }
  const init: RequestInit = {
    method: "POST",
    body: JSON.stringify({ playbook_id: playbookId }),
  };
  const data = await dispatch<ReviewRunDetail>(
    `/api/contracts/${encodeURIComponent(contractId)}/playbook-review/runs`,
    init,
    headers,
    options,
  );
  return scrubSecrets(data);
}

export async function listPlaybookReviewRuns(
  contractId: string,
  options: ApiOptions = {},
): Promise<ReviewRunSummary[]> {
  if (isDemoMode()) {
    return mockApi.listPlaybookReviewRuns(contractId, options);
  }
  const data = await call<ReviewRunSummary[]>(
    `/api/contracts/${encodeURIComponent(contractId)}/playbook-review/runs`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function getPlaybookReviewRun(
  contractId: string,
  runId: string,
  options: ApiOptions = {},
): Promise<ReviewRunDetail> {
  if (isDemoMode()) {
    return mockApi.getPlaybookReviewRun(contractId, runId, options);
  }
  const data = await call<ReviewRunDetail>(
    `/api/contracts/${encodeURIComponent(
      contractId,
    )}/playbook-review/runs/${encodeURIComponent(runId)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

function buildFindingsQueryString(filters: ListFindingsFilters): string {
  const params = new URLSearchParams();
  if (filters.playbook_id) params.set("playbook_id", filters.playbook_id);
  if (filters.finding_status) params.set("finding_status", filters.finding_status);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.review_run_id) params.set("review_run_id", filters.review_run_id);
  if (filters.include_superseded) params.set("include_superseded", "true");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function listContractFindings(
  contractId: string,
  filters: ListFindingsFilters = {},
  options: ApiOptions = {},
): Promise<DeviationFinding[]> {
  if (isDemoMode()) {
    return mockApi.listContractFindings(contractId, filters, options);
  }
  const qs = buildFindingsQueryString(filters);
  const data = await call<DeviationFinding[]>(
    `/api/contracts/${encodeURIComponent(contractId)}/findings${qs}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function updateFindingStatus(
  contractId: string,
  findingId: string,
  status: ReviewerFindingStatus,
  options: ApiOptions = {},
): Promise<DeviationFinding> {
  if (isDemoMode()) {
    return mockApi.updateFindingStatus(contractId, findingId, status, options);
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [k, v] of Object.entries(devHeaders())) {
    headers.set(k, v);
  }
  const init: RequestInit = {
    method: "PATCH",
    body: JSON.stringify({ finding_status: status }),
  };
  const data = await dispatch<DeviationFinding>(
    `/api/contracts/${encodeURIComponent(
      contractId,
    )}/findings/${encodeURIComponent(findingId)}`,
    init,
    headers,
    options,
  );
  return scrubSecrets(data);
}


export interface ClauseTemplateListFilters {
  clause_type?: string;
  jurisdiction?: string;
  contract_type?: string;
  tag?: string;
  include_inactive?: boolean;
}

function clauseTemplateQuery(filters: ClauseTemplateListFilters = {}): string {
  const params = new URLSearchParams();
  for (const [k,v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const q = params.toString();
  return q ? `?${q}` : "";
}

export async function listClauseTemplates(filters: ClauseTemplateListFilters = {}, options: ApiOptions = {}): Promise<ClauseTemplate[]> {
  if (isDemoMode()) return mockApi.listClauseTemplates(filters, options);
  const data = await call<ClauseTemplate[]>(`/api/clause-templates${clauseTemplateQuery(filters)}`, { method: "GET" }, options);
  return scrubSecrets(data);
}

export async function createClauseTemplate(payload: ClauseTemplateCreateRequest, options: ApiOptions = {}): Promise<ClauseTemplate> {
  if (isDemoMode()) return mockApi.createClauseTemplate(payload, options);
  const data = await call<ClauseTemplate>(`/api/clause-templates`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload) }, options);
  return scrubSecrets(data);
}

export async function getClauseTemplate(id: string, options: ApiOptions = {}): Promise<ClauseTemplate> {
  if (isDemoMode()) return mockApi.getClauseTemplate(id, options);
  const data = await call<ClauseTemplate>(`/api/clause-templates/${encodeURIComponent(id)}`, { method: "GET" }, options);
  return scrubSecrets(data);
}

export async function updateClauseTemplate(id: string, payload: ClauseTemplateUpdateRequest, options: ApiOptions = {}): Promise<ClauseTemplate> {
  if (isDemoMode()) return mockApi.updateClauseTemplate(id, payload, options);
  const data = await call<ClauseTemplate>(`/api/clause-templates/${encodeURIComponent(id)}`, { method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload) }, options);
  return scrubSecrets(data);
}

export async function deleteClauseTemplate(id: string, options: ApiOptions = {}): Promise<void> {
  if (isDemoMode()) return mockApi.deleteClauseTemplate(id, options);
  const headers = new Headers();
  for (const [k, v] of Object.entries(devHeaders())) headers.set(k, v);
  const res = await fetch(`${baseUrl()}/api/clause-templates/${encodeURIComponent(id)}`, { method: "DELETE", headers, signal: options.signal });
  if (!res.ok) throw new ApiError(res.status, await readErrorMessage(res));
}
