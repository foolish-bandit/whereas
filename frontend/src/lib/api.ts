import { getDevUserId } from "./devUser";
import { isDemoMode } from "./env";
import * as mockApi from "./mockApi";
import type {
  ContractMetadataUpdateRequest,
  ContractMetadataView,
} from "../types/contractIntake";
import type {
  Clause,
  ContractArtifact,
  ContractDetail,
  ContractListItem,
  ContractMarkdownSnapshot,
  UploadContractResponse,
} from "../types/contracts";
import type { ArtifactCompareResponse } from "../types/compare";
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
  AgreementGenerationRequest,
  AgreementGenerationResponse,
  AgreementTemplate,
  AgreementTemplateArtifact,
  AgreementTemplateCreateRequest,
  AgreementTemplateMarkdownSnapshot,
  AgreementTemplateUpdateRequest,
  AgreementTemplateVariable,
  AgreementTemplateVariableCreateRequest,
  AgreementTemplateVariableUpdateRequest,
  TemplateVariableSuggestion,
} from "../types/agreementTemplates";
import type {
  ContractApprovalGate,
  SendContractToDocuSealRequest,
  SendContractToDocuSealResponse,
} from "../types/docuseal";
import type {
  CreateDevSetupRequest,
  CreateDevSetupResponse,
  SetupStatus,
} from "../types/setup";
import type {
  ContractRequest,
  ContractRequestCreateRequest,
  ContractRequestUpdateRequest,
  ConvertRequestToContractRequest,
  ConvertRequestToContractResponse,
  ConvertRequestUploadInput,
  ConvertRequestUploadResponse,
  ListContractRequestFilters,
} from "../types/requests";
import type { RequestApprovalStatus } from "../types/requestApprovalStatus";
import type { ActivityTimelineResponse } from "../types/activity";
import type {
  DuplicateCandidatesResponse,
  DuplicateMergeRequest,
  DuplicateMergeResponse,
} from "../types/duplicateMerge";
import type { DashboardSummary } from "../types/dashboard";
import type {
  InboxItem,
  InboxItemCreateRequest,
  InboxItemUpdateRequest,
  ListInboxItemFilters,
} from "../types/inboxItems";
import type {
  ApprovalStepDecisionRequest,
  ApprovalWorkflowRun,
  ApprovalWorkflowRunCreateRequest,
  ApprovalWorkflowRunListItem,
  ListApprovalWorkflowFilters,
} from "../types/approvalWorkflows";
import type {
  ApprovalWorkflowTemplate,
  ApprovalWorkflowTemplateCreateRequest,
  ApprovalWorkflowTemplatePatch,
  ApprovalWorkflowTemplateStep,
  ApprovalWorkflowTemplateStepCreate,
  ApprovalWorkflowTemplateStepPatch,
  CreateApprovalWorkflowFromTemplateRequest,
  CreateApprovalWorkflowFromTemplateResponse,
  ListApprovalWorkflowTemplateFilters,
} from "../types/approvalWorkflowTemplates";
import type {
  ApprovalPolicy,
  ApprovalPolicyCreateRequest,
  ApprovalPolicyPatchRequest,
  ListApprovalPolicyFilters,
} from "../types/approvalPolicies";
import type {
  CompleteConnectionRequest,
  ConnectSession,
  IntegrationConnection,
  IntegrationProvider,
  ListFoldersResult,
  ManualSyncResult,
  UpdateConnectionRequest,
} from "../types/integrations";

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
  "storage_key",
  "presigned_url",
  "presigned_uri",
  "private_url",
  "docuseal_webhook_secret",
  "docuseal_api_token",
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

export interface GetContractsOptions extends ApiOptions {
  /**
   * When true, list rows that have been merged into another Repository
   * record (PR #76). Default is false; the backend filters them out
   * server-side.
   */
  include_merged?: boolean;
  /**
   * Case-insensitive substring match against Repository record
   * ``title`` (PR #95). Blank / whitespace-only values are ignored
   * (no ``q`` param is sent) so the server returns the unfiltered
   * list.
   */
  q?: string;
}

export async function getContracts(
  options: GetContractsOptions = {},
): Promise<ContractListItem[]> {
  if (isDemoMode()) return mockApi.getContracts(options);
  const params = new URLSearchParams();
  if (options.include_merged) params.set("include_merged", "true");
  const trimmedQ = options.q?.trim() ?? "";
  if (trimmedQ) params.set("q", trimmedQ);
  const qs = params.toString();
  const data = await call<ContractListItem[]>(
    `/api/contracts${qs ? `?${qs}` : ""}`,
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
  if (isDemoMode()) return mockApi.getContractMarkdown(id, options);
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

/**
 * Fetch the artifact list for a contract. Metadata only — no file
 * contents and no signed URLs. Returns an empty array when the
 * contract has no artifacts yet.
 */
export async function getContractArtifacts(
  id: string,
  options: ApiOptions = {},
): Promise<ContractArtifact[]> {
  if (isDemoMode()) return mockApi.getContractArtifacts(id, options);
  const data = await call<ContractArtifact[]>(
    `/api/contracts/${encodeURIComponent(id)}/artifacts`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
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

/**
 * Fetch the merged contract metadata view used by the upload-review
 * panel (PR #67). Reads ``title`` off ``Contract.title`` and the rest
 * off the latest ``original_upload`` artifact's ``metadata_json``.
 */
export async function getContractMetadata(
  id: string,
  options: ApiOptions = {},
): Promise<ContractMetadataView> {
  if (isDemoMode()) return mockApi.getContractMetadata(id, options);
  const data = await call<ContractMetadataView>(
    `/api/contracts/${encodeURIComponent(id)}/metadata`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

/**
 * User-confirmed metadata update for an existing contract (PR #67).
 * ``title`` persists on ``Contract.title``;
 * ``counterparty_name`` / ``contract_type`` / ``effective_date``
 * persist on the latest ``original_upload`` artifact's
 * ``metadata_json``. Empty strings clear the non-title fields.
 */
export async function updateContractMetadata(
  id: string,
  payload: ContractMetadataUpdateRequest,
  options: ApiOptions = {},
): Promise<ContractMetadataView> {
  if (isDemoMode())
    return mockApi.updateContractMetadata(id, payload, options);
  const data = await call<ContractMetadataView>(
    `/api/contracts/${encodeURIComponent(id)}/metadata`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export interface DownloadResult {
  blob: Blob;
  filename: string | null;
  mimeType: string;
}

const FILENAME_RE = /filename="([^"]+)"/i;

/**
 * Send a contract to DocuSeal for signature collection. Backend
 * resolves the right artifact (generated_docx > original_upload >
 * legacy contract.s3_key), decrypts it server-side, and POSTs the
 * bytes to DocuSeal as base64. The response carries the DocuSeal
 * submission id and any embed URL the upstream returned; storage
 * internals are scrubbed.
 */

export async function getContractApprovalGate(
  id: string,
  options: ApiOptions = {},
): Promise<ContractApprovalGate> {
  if (isDemoMode()) return mockApi.getContractApprovalGate(id, options);
  const data = await call<ContractApprovalGate>(
    `/api/contracts/${encodeURIComponent(id)}/approval-gate`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function sendContractToDocuseal(
  id: string,
  payload: SendContractToDocuSealRequest,
  options: ApiOptions = {},
): Promise<SendContractToDocuSealResponse> {
  if (isDemoMode()) return mockApi.sendContractToDocuseal(id, payload, options);
  const data = await call<SendContractToDocuSealResponse>(
    `/api/contracts/${encodeURIComponent(id)}/send-to-docuseal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function downloadContract(
  id: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  if (isDemoMode()) return mockApi.downloadContract(id, options);
  return downloadBlob(
    `/api/contracts/${encodeURIComponent(id)}/download`,
    options,
  );
}

/**
 * PR #70 — download a specific ContractArtifact version rather than
 * the current priority-winning document. Backed by the per-artifact
 * route, which is org + contract scoped server-side; a stray
 * cross-org or cross-contract call surfaces as a clean 404 here.
 *
 * The Document History row's "Download version" action calls this
 * helper. The header's "Download current document" action continues
 * to use ``downloadContract`` so changing the priority winner does
 * not require a UI update.
 */
export async function downloadContractArtifact(
  contractId: string,
  artifactId: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  if (isDemoMode()) {
    return mockApi.downloadContractArtifact(contractId, artifactId, options);
  }
  return downloadBlob(
    `/api/contracts/${encodeURIComponent(contractId)}/artifacts/${encodeURIComponent(
      artifactId,
    )}/download`,
    options,
  );
}

/**
 * PR #71 — text-based artifact version compare.
 *
 * Calls the org + contract scoped compare endpoint and returns the
 * structured diff payload. The response carries safe metadata only;
 * the storage internals scrub still runs as a belt-and-braces guard
 * against future regressions.
 */

export async function previewContractArtifact(
  contractId: string,
  artifactId: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  if (isDemoMode()) {
    return mockApi.previewContractArtifact(contractId, artifactId, options);
  }
  return downloadBlob(
    `/api/contracts/${encodeURIComponent(contractId)}/artifacts/${encodeURIComponent(artifactId)}/preview`,
    options,
  );
}

export async function compareContractArtifacts(
  contractId: string,
  baseArtifactId: string,
  compareArtifactId: string,
  options: ApiOptions = {},
): Promise<ArtifactCompareResponse> {
  if (isDemoMode()) {
    return mockApi.compareContractArtifacts(
      contractId,
      baseArtifactId,
      compareArtifactId,
      options,
    );
  }
  const data = await call<ArtifactCompareResponse>(
    `/api/contracts/${encodeURIComponent(contractId)}/artifacts/compare`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_artifact_id: baseArtifactId,
        compare_artifact_id: compareArtifactId,
      }),
    },
    options,
  );
  return scrubSecrets(data);
}

/**
 * Persist a comparison report as a ``redline`` ``ContractArtifact``
 * in Document History (PR #91).
 *
 * Same body shape as `exportContractArtifactsCompare`; resolves to
 * the new artifact's safe metadata (``ContractArtifact`` projection
 * — no ``storage_key`` / ``wrapped_dek``). Saved redlines are
 * deliberately not "official" and are not in the download priority
 * chain, so the default *Download current document* action keeps
 * preferring ``signed_pdf`` → ``generated_docx`` → ``original_upload``.
 */
export async function saveContractArtifactsCompare(
  contractId: string,
  baseArtifactId: string,
  compareArtifactId: string,
  options: ApiOptions = {},
): Promise<ContractArtifact> {
  if (isDemoMode()) {
    return mockApi.saveContractArtifactsCompare(
      contractId,
      baseArtifactId,
      compareArtifactId,
      options,
    );
  }
  const data = await call<ContractArtifact>(
    `/api/contracts/${encodeURIComponent(
      contractId,
    )}/artifacts/compare/save`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_artifact_id: baseArtifactId,
        compare_artifact_id: compareArtifactId,
      }),
    },
    options,
  );
  return scrubSecrets(data);
}

/**
 * On-demand redline-style export of a comparison report DOCX (PR #90).
 *
 * POSTs the same body shape as `compareContractArtifacts` and resolves
 * to a `Blob` carrying the DOCX bytes, the suggested filename from
 * the `Content-Disposition` header, and the response content-type.
 *
 * Demo mode is routed to `mockApi` so the hosted demo can simulate a
 * download without contacting a backend.
 */
export async function exportContractArtifactsCompare(
  contractId: string,
  baseArtifactId: string,
  compareArtifactId: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  if (isDemoMode()) {
    return mockApi.exportContractArtifactsCompare(
      contractId,
      baseArtifactId,
      compareArtifactId,
      options,
    );
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [k, v] of Object.entries(devHeaders())) {
    headers.set(k, v);
  }
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl()}/api/contracts/${encodeURIComponent(
        contractId,
      )}/artifacts/compare/export`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          base_artifact_id: baseArtifactId,
          compare_artifact_id: compareArtifactId,
        }),
        signal: options.signal,
      },
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

async function downloadBlob(
  path: string,
  options: ApiOptions,
): Promise<DownloadResult> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(devHeaders())) {
    headers.set(k, v);
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method: "GET",
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
  if (isDemoMode()) return mockApi.getSetupStatus(options);
  return callPublic<SetupStatus>("/api/setup/status", { method: "GET" }, options);
}

export async function createDevSetup(
  payload: CreateDevSetupRequest = {},
  options: ApiOptions = {},
): Promise<CreateDevSetupResponse> {
  if (isDemoMode()) return mockApi.createDevSetup(payload, options);
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
  if (isDemoMode()) return mockApi.validatePlaybook(yamlSource, options);
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
  if (isDemoMode()) return mockApi.createPlaybook(yamlSource, options);
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
  if (isDemoMode()) return mockApi.deactivatePlaybook(id, options);
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

// ---------------------------------------------------------------------------
// Agreement templates
// ---------------------------------------------------------------------------

export interface ListAgreementTemplatesFilters {
  include_archived?: boolean;
  template_type?: string;
}

function agreementTemplateQuery(filters: ListAgreementTemplatesFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.include_archived) params.set("include_archived", "true");
  if (filters.template_type) params.set("template_type", filters.template_type);
  const q = params.toString();
  return q ? `?${q}` : "";
}

export async function listAgreementTemplates(
  filters: ListAgreementTemplatesFilters = {},
  options: ApiOptions = {},
): Promise<AgreementTemplate[]> {
  if (isDemoMode()) return mockApi.listAgreementTemplates(filters, options);
  const data = await call<AgreementTemplate[]>(
    `/api/agreement-templates${agreementTemplateQuery(filters)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function getAgreementTemplate(
  id: string,
  options: ApiOptions = {},
): Promise<AgreementTemplate> {
  if (isDemoMode()) return mockApi.getAgreementTemplate(id, options);
  const data = await call<AgreementTemplate>(
    `/api/agreement-templates/${encodeURIComponent(id)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function createAgreementTemplate(
  payload: AgreementTemplateCreateRequest,
  options: ApiOptions = {},
): Promise<AgreementTemplate> {
  if (isDemoMode()) return mockApi.createAgreementTemplate(payload, options);
  const data = await call<AgreementTemplate>(
    `/api/agreement-templates`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function updateAgreementTemplate(
  id: string,
  payload: AgreementTemplateUpdateRequest,
  options: ApiOptions = {},
): Promise<AgreementTemplate> {
  if (isDemoMode()) return mockApi.updateAgreementTemplate(id, payload, options);
  const data = await call<AgreementTemplate>(
    `/api/agreement-templates/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function archiveAgreementTemplate(
  id: string,
  options: ApiOptions = {},
): Promise<void> {
  if (isDemoMode()) return mockApi.archiveAgreementTemplate(id, options);
  const headers = new Headers();
  for (const [k, v] of Object.entries(devHeaders())) headers.set(k, v);
  const res = await fetch(
    `${baseUrl()}/api/agreement-templates/${encodeURIComponent(id)}`,
    { method: "DELETE", headers, signal: options.signal },
  );
  if (!res.ok) throw new ApiError(res.status, await readErrorMessage(res));
}

export async function uploadAgreementTemplateArtifact(
  id: string,
  file: File,
  options: ApiOptions = {},
): Promise<AgreementTemplateArtifact> {
  if (isDemoMode()) return mockApi.uploadAgreementTemplateArtifact(id, file, options);
  const formData = new FormData();
  formData.append("file", file);
  const data = await call<AgreementTemplateArtifact>(
    `/api/agreement-templates/${encodeURIComponent(id)}/upload`,
    { method: "POST", body: formData },
    options,
  );
  return scrubSecrets(data);
}

export async function getAgreementTemplateArtifacts(
  id: string,
  options: ApiOptions = {},
): Promise<AgreementTemplateArtifact[]> {
  if (isDemoMode()) return mockApi.getAgreementTemplateArtifacts(id, options);
  const data = await call<AgreementTemplateArtifact[]>(
    `/api/agreement-templates/${encodeURIComponent(id)}/artifacts`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

/**
 * PR #103 — download a specific AgreementTemplateArtifact version
 * (a historical source-file upload) from the Source file history
 * view. Org + template + artifact scoped server-side; cross-org or
 * cross-template requests surface as a clean 404 here. Returns the
 * raw bytes as a Blob via the shared download helper.
 */
/**
 * PR #106 — restore a prior ``AgreementTemplateArtifact`` as the
 * template's current source file. Org + template + artifact scoped
 * server-side; cross-org / wrong-template / missing artifact
 * surface as a clean 404 here. Only source uploads
 * (``artifact_type='original_upload'``) can be restored.
 */
export async function restoreAgreementTemplateArtifact(
  templateId: string,
  artifactId: string,
  options: ApiOptions = {},
): Promise<AgreementTemplateArtifact> {
  if (isDemoMode()) {
    return mockApi.restoreAgreementTemplateArtifact(
      templateId,
      artifactId,
      options,
    );
  }
  const data = await call<AgreementTemplateArtifact>(
    `/api/agreement-templates/${encodeURIComponent(templateId)}/artifacts/${encodeURIComponent(
      artifactId,
    )}/restore`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    },
    options,
  );
  return scrubSecrets(data);
}

export async function downloadAgreementTemplateArtifact(
  templateId: string,
  artifactId: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  if (isDemoMode()) {
    return mockApi.downloadAgreementTemplateArtifact(
      templateId,
      artifactId,
      options,
    );
  }
  return downloadBlob(
    `/api/agreement-templates/${encodeURIComponent(templateId)}/artifacts/${encodeURIComponent(
      artifactId,
    )}/download`,
    options,
  );
}

export async function getAgreementTemplateMarkdown(
  id: string,
  options: ApiOptions = {},
): Promise<AgreementTemplateMarkdownSnapshot | null> {
  if (isDemoMode()) return mockApi.getAgreementTemplateMarkdown(id, options);
  try {
    const data = await call<AgreementTemplateMarkdownSnapshot>(
      `/api/agreement-templates/${encodeURIComponent(id)}/markdown`,
      { method: "GET" },
      options,
    );
    return scrubSecrets(data);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function listAgreementTemplateVariables(
  id: string,
  options: ApiOptions = {},
): Promise<AgreementTemplateVariable[]> {
  if (isDemoMode()) return mockApi.listAgreementTemplateVariables(id, options);
  const data = await call<AgreementTemplateVariable[]>(
    `/api/agreement-templates/${encodeURIComponent(id)}/variables`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

/**
 * Deterministic ``{{placeholder}}`` detection on the template's Text
 * preview (PR #96). Keys that already exist as
 * ``AgreementTemplateVariable`` rows are filtered out server-side, so
 * the returned list is *new* suggestions only.
 */
export async function listAgreementTemplateVariableSuggestions(
  id: string,
  options: ApiOptions = {},
): Promise<TemplateVariableSuggestion[]> {
  if (isDemoMode()) {
    return mockApi.listAgreementTemplateVariableSuggestions(id, options);
  }
  const data = await call<TemplateVariableSuggestion[]>(
    `/api/agreement-templates/${encodeURIComponent(id)}/variable-suggestions`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function createAgreementTemplateVariable(
  id: string,
  payload: AgreementTemplateVariableCreateRequest,
  options: ApiOptions = {},
): Promise<AgreementTemplateVariable> {
  if (isDemoMode()) return mockApi.createAgreementTemplateVariable(id, payload, options);
  const data = await call<AgreementTemplateVariable>(
    `/api/agreement-templates/${encodeURIComponent(id)}/variables`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function updateAgreementTemplateVariable(
  templateId: string,
  variableId: string,
  payload: AgreementTemplateVariableUpdateRequest,
  options: ApiOptions = {},
): Promise<AgreementTemplateVariable> {
  if (isDemoMode())
    return mockApi.updateAgreementTemplateVariable(templateId, variableId, payload, options);
  const data = await call<AgreementTemplateVariable>(
    `/api/agreement-templates/${encodeURIComponent(templateId)}/variables/${encodeURIComponent(
      variableId,
    )}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function deleteAgreementTemplateVariable(
  templateId: string,
  variableId: string,
  options: ApiOptions = {},
): Promise<void> {
  if (isDemoMode())
    return mockApi.deleteAgreementTemplateVariable(templateId, variableId, options);
  const headers = new Headers();
  for (const [k, v] of Object.entries(devHeaders())) headers.set(k, v);
  const res = await fetch(
    `${baseUrl()}/api/agreement-templates/${encodeURIComponent(templateId)}/variables/${encodeURIComponent(variableId)}`,
    { method: "DELETE", headers, signal: options.signal },
  );
  if (!res.ok) throw new ApiError(res.status, await readErrorMessage(res));
}

/**
 * Render a DOCX from a template + variable values. Creates a new
 * draft Contract row plus a `generated_docx` ContractArtifact and
 * returns both. Does NOT send anything to DocuSeal.
 */
export async function generateAgreementFromTemplate(
  templateId: string,
  payload: AgreementGenerationRequest,
  options: ApiOptions = {},
): Promise<AgreementGenerationResponse> {
  if (isDemoMode())
    return mockApi.generateAgreementFromTemplate(templateId, payload, options);
  const data = await call<AgreementGenerationResponse>(
    `/api/agreement-templates/${encodeURIComponent(templateId)}/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

// ---------------------------------------------------------------------------
// Contract requests (PR #47 — CLM intake foundation)
// ---------------------------------------------------------------------------

function contractRequestQuery(filters: ListContractRequestFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.request_type) params.set("request_type", filters.request_type);
  if (filters.contract_type) params.set("contract_type", filters.contract_type);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.assigned_to) params.set("assigned_to", filters.assigned_to);
  if (filters.due_before) params.set("due_before", filters.due_before);
  if (filters.due_after) params.set("due_after", filters.due_after);
  if (filters.include_cancelled) params.set("include_cancelled", "true");
  const q = params.toString();
  return q ? `?${q}` : "";
}

export async function listRequests(
  filters: ListContractRequestFilters = {},
  options: ApiOptions = {},
): Promise<ContractRequest[]> {
  if (isDemoMode()) return mockApi.listRequests(filters, options);
  const data = await call<ContractRequest[]>(
    `/api/requests${contractRequestQuery(filters)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function getRequest(
  id: string,
  options: ApiOptions = {},
): Promise<ContractRequest> {
  if (isDemoMode()) return mockApi.getRequest(id, options);
  const data = await call<ContractRequest>(
    `/api/requests/${encodeURIComponent(id)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function createRequest(
  payload: ContractRequestCreateRequest,
  options: ApiOptions = {},
): Promise<ContractRequest> {
  if (isDemoMode()) return mockApi.createRequest(payload, options);
  const data = await call<ContractRequest>(
    `/api/requests`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function updateRequest(
  id: string,
  payload: ContractRequestUpdateRequest,
  options: ApiOptions = {},
): Promise<ContractRequest> {
  if (isDemoMode()) return mockApi.updateRequest(id, payload, options);
  const data = await call<ContractRequest>(
    `/api/requests/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function cancelRequest(
  id: string,
  options: ApiOptions = {},
): Promise<void> {
  if (isDemoMode()) return mockApi.cancelRequest(id, options);
  const headers = new Headers();
  for (const [k, v] of Object.entries(devHeaders())) headers.set(k, v);
  const res = await fetch(
    `${baseUrl()}/api/requests/${encodeURIComponent(id)}`,
    { method: "DELETE", headers, signal: options.signal },
  );
  if (!res.ok) throw new ApiError(res.status, await readErrorMessage(res));
}

/**
 * Convert an open request into a draft Contract via its linked
 * agreement template. Server-side this reuses the same template
 * generation path as ``generateAgreementFromTemplate``; on success
 * the request is marked completed and the linked ``request_review``
 * inbox item is resolved in the same transaction.
 */
export async function convertRequestToContract(
  id: string,
  payload: ConvertRequestToContractRequest,
  options: ApiOptions = {},
): Promise<ConvertRequestToContractResponse> {
  if (isDemoMode()) return mockApi.convertRequestToContract(id, payload, options);
  const data = await call<ConvertRequestToContractResponse>(
    `/api/requests/${encodeURIComponent(id)}/convert-to-contract`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

/**
 * Convert an open request into a Repository contract by uploading a
 * third-party / counterparty agreement file (PR #65). Multipart POST
 * — backend stores the file, creates an ``original_upload``
 * ``ContractArtifact`` with ``source='request_upload'``, links the
 * new contract back to the request, and resolves the request_review
 * inbox item in the same transaction.
 */
export async function convertRequestWithUpload(
  id: string,
  input: ConvertRequestUploadInput,
): Promise<ConvertRequestUploadResponse> {
  if (isDemoMode()) return mockApi.convertRequestWithUpload(id, input);
  const formData = new FormData();
  formData.append("file", input.file);
  const trimmedTitle = (input.title ?? "").trim();
  if (trimmedTitle) formData.append("title", trimmedTitle);
  const trimmedCounterparty = (input.counterparty_name ?? "").trim();
  if (trimmedCounterparty) {
    formData.append("counterparty_name", trimmedCounterparty);
  }
  const trimmedType = (input.contract_type ?? "").trim();
  if (trimmedType) formData.append("contract_type", trimmedType);
  const trimmedNotes = (input.notes ?? "").trim();
  if (trimmedNotes) formData.append("notes", trimmedNotes);
  const data = await call<ConvertRequestUploadResponse>(
    `/api/requests/${encodeURIComponent(id)}/convert-upload`,
    {
      method: "POST",
      body: formData,
    },
    { signal: input.signal },
  );
  return scrubSecrets(data);
}

/**
 * Read-only approval visibility for a request: matching policies,
 * attached workflow runs, and a summary aligned with the DocuSeal send
 * gate. The response is server-derived; this helper does not derive
 * additional state on the client.
 */
export async function getRequestApprovalStatus(
  id: string,
  options: ApiOptions = {},
): Promise<RequestApprovalStatus> {
  if (isDemoMode()) return mockApi.getRequestApprovalStatus(id, options);
  const data = await call<RequestApprovalStatus>(
    `/api/requests/${encodeURIComponent(id)}/approval-status`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

/**
 * Read-only chronological activity feed for a request. Server-rendered
 * titles + descriptions; the client just lays them out.
 */
export async function getRequestActivity(
  id: string,
  options: ApiOptions & { limit?: number } = {},
): Promise<ActivityTimelineResponse> {
  if (isDemoMode()) return mockApi.getRequestActivity(id, options);
  const qs = options.limit ? `?limit=${options.limit}` : "";
  const data = await call<ActivityTimelineResponse>(
    `/api/requests/${encodeURIComponent(id)}/activity${qs}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

/**
 * Read-only chronological activity feed for a contract. Server-rendered
 * titles + descriptions; the client just lays them out.
 */
export async function getContractActivity(
  id: string,
  options: ApiOptions & { limit?: number } = {},
): Promise<ActivityTimelineResponse> {
  if (isDemoMode()) return mockApi.getContractActivity(id, options);
  const qs = options.limit ? `?limit=${options.limit}` : "";
  const data = await call<ActivityTimelineResponse>(
    `/api/contracts/${encodeURIComponent(id)}/activity${qs}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

/**
 * Allowed export format values, mirroring the backend's
 * ``activity_export.SUPPORTED_FORMATS``. Restricting the type here
 * (rather than ``string``) keeps misspellings from reaching the
 * network — the backend would reject them with a 422 anyway, but
 * compile-time is cheaper.
 */
export type ActivityExportFormat = "csv" | "json";

/**
 * PR #75 — download a Repository's activity timeline as a CSV or
 * JSON file. The server returns a sanitized projection of the
 * existing audit-backed timeline (no raw audit details, no storage
 * internals, no document bytes); this helper only conveys the bytes
 * to the caller for the browser-side download flow.
 */
export async function exportContractActivity(
  contractId: string,
  format: ActivityExportFormat,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  if (isDemoMode()) {
    return mockApi.exportContractActivity(contractId, format, options);
  }
  return downloadBlob(
    `/api/contracts/${encodeURIComponent(contractId)}/activity/export?format=${encodeURIComponent(format)}`,
    options,
  );
}

/**
 * PR #75 — download a Request's activity timeline as CSV or JSON.
 * Symmetric with ``exportContractActivity``; see notes there.
 */
export async function exportRequestActivity(
  requestId: string,
  format: ActivityExportFormat,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  if (isDemoMode()) {
    return mockApi.exportRequestActivity(requestId, format, options);
  }
  return downloadBlob(
    `/api/requests/${encodeURIComponent(requestId)}/activity/export?format=${encodeURIComponent(format)}`,
    options,
  );
}

/**
 * PR #76 — fetch possible duplicate Repository records for an
 * existing contract. The detail page calls this lazily so the
 * merge affordance only loads when the user opens the duplicate
 * section. Server scrubs storage internals; we run the defensive
 * scrub anyway.
 */
export async function getContractDuplicateCandidates(
  contractId: string,
  options: ApiOptions = {},
): Promise<DuplicateCandidatesResponse> {
  if (isDemoMode()) {
    return mockApi.getContractDuplicateCandidates(contractId, options);
  }
  const data = await call<DuplicateCandidatesResponse>(
    `/api/contracts/${encodeURIComponent(contractId)}/duplicate-candidates`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

/**
 * PR #76 — merge a source duplicate Repository record into the
 * target (canonical) record. The server does not delete files; the
 * source row stays in the database with a merged-into pointer so
 * deep links keep resolving.
 *
 * Errors surface as ``ApiError`` with these statuses:
 * - 400: same-record merge (source equals target)
 * - 404: cross-org / missing source or target
 * - 409: source or target already merged
 */
export async function mergeDuplicateContract(
  targetContractId: string,
  sourceContractId: string,
  mergeNote?: string | null,
  options: ApiOptions = {},
): Promise<DuplicateMergeResponse> {
  const payload: DuplicateMergeRequest = {
    source_contract_id: sourceContractId,
    ...(mergeNote ? { merge_note: mergeNote } : {}),
  };
  if (isDemoMode()) {
    return mockApi.mergeDuplicateContract(
      targetContractId,
      sourceContractId,
      mergeNote ?? null,
      options,
    );
  }
  const data = await call<DuplicateMergeResponse>(
    `/api/contracts/${encodeURIComponent(targetContractId)}/merge-duplicate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

// ---------------------------------------------------------------------------
// Inbox items (PR #47 — CLM work queue foundation)
// ---------------------------------------------------------------------------

function inboxItemQuery(filters: ListInboxItemFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.item_type) params.set("item_type", filters.item_type);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.assigned_to) params.set("assigned_to", filters.assigned_to);
  if (filters.due_before) params.set("due_before", filters.due_before);
  if (filters.due_after) params.set("due_after", filters.due_after);
  if (filters.include_dismissed) params.set("include_dismissed", "true");
  const q = params.toString();
  return q ? `?${q}` : "";
}

export async function listInboxItems(
  filters: ListInboxItemFilters = {},
  options: ApiOptions = {},
): Promise<InboxItem[]> {
  if (isDemoMode()) return mockApi.listInboxItems(filters, options);
  const data = await call<InboxItem[]>(
    `/api/inbox-items${inboxItemQuery(filters)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function getInboxItem(
  id: string,
  options: ApiOptions = {},
): Promise<InboxItem> {
  if (isDemoMode()) return mockApi.getInboxItem(id, options);
  const data = await call<InboxItem>(
    `/api/inbox-items/${encodeURIComponent(id)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function createInboxItem(
  payload: InboxItemCreateRequest,
  options: ApiOptions = {},
): Promise<InboxItem> {
  if (isDemoMode()) return mockApi.createInboxItem(payload, options);
  const data = await call<InboxItem>(
    `/api/inbox-items`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function updateInboxItem(
  id: string,
  payload: InboxItemUpdateRequest,
  options: ApiOptions = {},
): Promise<InboxItem> {
  if (isDemoMode()) return mockApi.updateInboxItem(id, payload, options);
  const data = await call<InboxItem>(
    `/api/inbox-items/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function dismissInboxItem(
  id: string,
  options: ApiOptions = {},
): Promise<void> {
  if (isDemoMode()) return mockApi.dismissInboxItem(id, options);
  const headers = new Headers();
  for (const [k, v] of Object.entries(devHeaders())) headers.set(k, v);
  const res = await fetch(
    `${baseUrl()}/api/inbox-items/${encodeURIComponent(id)}`,
    { method: "DELETE", headers, signal: options.signal },
  );
  if (!res.ok) throw new ApiError(res.status, await readErrorMessage(res));
}


// ---------------------------------------------------------------------------
// Approval workflows (PR #50 — narrow approval foundation)
// ---------------------------------------------------------------------------

function approvalWorkflowQuery(
  filters: ListApprovalWorkflowFilters = {},
): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.request_id) params.set("request_id", filters.request_id);
  if (filters.contract_id) params.set("contract_id", filters.contract_id);
  if (filters.include_terminal === false) {
    params.set("include_terminal", "false");
  }
  const q = params.toString();
  return q ? `?${q}` : "";
}

export async function listApprovalWorkflows(
  filters: ListApprovalWorkflowFilters = {},
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRunListItem[]> {
  if (isDemoMode()) return mockApi.listApprovalWorkflows(filters, options);
  const data = await call<ApprovalWorkflowRunListItem[]>(
    `/api/approval-workflows${approvalWorkflowQuery(filters)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function getApprovalWorkflow(
  id: string,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRun> {
  if (isDemoMode()) return mockApi.getApprovalWorkflow(id, options);
  const data = await call<ApprovalWorkflowRun>(
    `/api/approval-workflows/${encodeURIComponent(id)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function createApprovalWorkflow(
  payload: ApprovalWorkflowRunCreateRequest,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRun> {
  if (isDemoMode()) return mockApi.createApprovalWorkflow(payload, options);
  const data = await call<ApprovalWorkflowRun>(
    `/api/approval-workflows`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function approveApprovalStep(
  workflowId: string,
  stepId: string,
  payload: ApprovalStepDecisionRequest = {},
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRun> {
  if (isDemoMode()) {
    return mockApi.approveApprovalStep(workflowId, stepId, payload, options);
  }
  const data = await call<ApprovalWorkflowRun>(
    `/api/approval-workflows/${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepId)}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function rejectApprovalStep(
  workflowId: string,
  stepId: string,
  payload: ApprovalStepDecisionRequest = {},
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRun> {
  if (isDemoMode()) {
    return mockApi.rejectApprovalStep(workflowId, stepId, payload, options);
  }
  const data = await call<ApprovalWorkflowRun>(
    `/api/approval-workflows/${encodeURIComponent(workflowId)}/steps/${encodeURIComponent(stepId)}/reject`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function cancelApprovalWorkflow(
  workflowId: string,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRun> {
  if (isDemoMode()) return mockApi.cancelApprovalWorkflow(workflowId, options);
  const data = await call<ApprovalWorkflowRun>(
    `/api/approval-workflows/${encodeURIComponent(workflowId)}/cancel`,
    { method: "PATCH" },
    options,
  );
  return scrubSecrets(data);
}


// ---------------------------------------------------------------------------
// Approval workflow templates (PR #51 — reusable approval blueprints)
// ---------------------------------------------------------------------------

function approvalWorkflowTemplateQuery(
  filters: ListApprovalWorkflowTemplateFilters = {},
): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.template_type) params.set("template_type", filters.template_type);
  if (filters.include_archived === true) {
    params.set("include_archived", "true");
  }
  if (filters.query) params.set("query", filters.query);
  const q = params.toString();
  return q ? `?${q}` : "";
}

export async function listApprovalWorkflowTemplates(
  filters: ListApprovalWorkflowTemplateFilters = {},
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate[]> {
  if (isDemoMode()) {
    return mockApi.listApprovalWorkflowTemplates(filters, options);
  }
  const data = await call<ApprovalWorkflowTemplate[]>(
    `/api/approval-workflow-templates${approvalWorkflowTemplateQuery(filters)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function getApprovalWorkflowTemplate(
  id: string,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate> {
  if (isDemoMode()) {
    return mockApi.getApprovalWorkflowTemplate(id, options);
  }
  const data = await call<ApprovalWorkflowTemplate>(
    `/api/approval-workflow-templates/${encodeURIComponent(id)}`,
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function createApprovalWorkflowTemplate(
  payload: ApprovalWorkflowTemplateCreateRequest,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate> {
  if (isDemoMode()) {
    return mockApi.createApprovalWorkflowTemplate(payload, options);
  }
  const data = await call<ApprovalWorkflowTemplate>(
    `/api/approval-workflow-templates`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function updateApprovalWorkflowTemplate(
  id: string,
  payload: ApprovalWorkflowTemplatePatch,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate> {
  if (isDemoMode()) {
    return mockApi.updateApprovalWorkflowTemplate(id, payload, options);
  }
  const data = await call<ApprovalWorkflowTemplate>(
    `/api/approval-workflow-templates/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function archiveApprovalWorkflowTemplate(
  id: string,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate> {
  if (isDemoMode()) {
    return mockApi.archiveApprovalWorkflowTemplate(id, options);
  }
  const data = await call<ApprovalWorkflowTemplate>(
    `/api/approval-workflow-templates/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    options,
  );
  return scrubSecrets(data);
}

export async function addApprovalWorkflowTemplateStep(
  templateId: string,
  payload: ApprovalWorkflowTemplateStepCreate,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplateStep> {
  if (isDemoMode()) {
    return mockApi.addApprovalWorkflowTemplateStep(templateId, payload, options);
  }
  const data = await call<ApprovalWorkflowTemplateStep>(
    `/api/approval-workflow-templates/${encodeURIComponent(templateId)}/steps`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function updateApprovalWorkflowTemplateStep(
  templateId: string,
  stepId: string,
  payload: ApprovalWorkflowTemplateStepPatch,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplateStep> {
  if (isDemoMode()) {
    return mockApi.updateApprovalWorkflowTemplateStep(
      templateId,
      stepId,
      payload,
      options,
    );
  }
  const data = await call<ApprovalWorkflowTemplateStep>(
    `/api/approval-workflow-templates/${encodeURIComponent(templateId)}/steps/${encodeURIComponent(stepId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function deleteApprovalWorkflowTemplateStep(
  templateId: string,
  stepId: string,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate> {
  if (isDemoMode()) {
    return mockApi.deleteApprovalWorkflowTemplateStep(
      templateId,
      stepId,
      options,
    );
  }
  const data = await call<ApprovalWorkflowTemplate>(
    `/api/approval-workflow-templates/${encodeURIComponent(templateId)}/steps/${encodeURIComponent(stepId)}`,
    { method: "DELETE" },
    options,
  );
  return scrubSecrets(data);
}

export async function instantiateApprovalWorkflowTemplate(
  templateId: string,
  payload: CreateApprovalWorkflowFromTemplateRequest,
  options: ApiOptions = {},
): Promise<CreateApprovalWorkflowFromTemplateResponse> {
  if (isDemoMode()) {
    return mockApi.instantiateApprovalWorkflowTemplate(
      templateId,
      payload,
      options,
    );
  }
  const data = await call<CreateApprovalWorkflowFromTemplateResponse>(
    `/api/approval-workflow-templates/${encodeURIComponent(templateId)}/instantiate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}


// ---------------------------------------------------------------------------
// Dashboard summary (PR #49 — read-only aggregate of CLM state)
// ---------------------------------------------------------------------------

/**
 * Fetch the dashboard summary: counts, upcoming due-soon lists, and
 * recent-activity feeds. Org-scoped on the server. The mock-mode
 * variant returns a coherent snapshot derived from the same demo
 * fixtures the rest of the app uses.
 */
export async function getDashboardSummary(
  options: ApiOptions & { limit?: number } = {},
): Promise<DashboardSummary> {
  if (isDemoMode()) return mockApi.getDashboardSummary(options);
  const qs = options.limit ? `?limit=${options.limit}` : "";
  const data = await call<DashboardSummary>(
    `/api/dashboard/summary${qs}`,
    { method: "GET" },
    { signal: options.signal },
  );
  return scrubSecrets(data);
}


function approvalPolicyQuery(filters: ListApprovalPolicyFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.include_archived === true) params.set("include_archived", "true");
  if (filters.status) params.set("status", filters.status);
  if (filters.request_type) params.set("request_type", filters.request_type);
  if (filters.contract_type) params.set("contract_type", filters.contract_type);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.workflow_template_id) params.set("workflow_template_id", filters.workflow_template_id);
  const q = params.toString();
  return q ? `?${q}` : "";
}

export async function listApprovalPolicies(
  filters: ListApprovalPolicyFilters = {},
  options: ApiOptions = {},
): Promise<ApprovalPolicy[]> {
  if (isDemoMode()) return mockApi.listApprovalPolicies(filters, options);
  const data = await call<ApprovalPolicy[]>(`/api/approval-policies${approvalPolicyQuery(filters)}`, { method: "GET" }, options);
  return scrubSecrets(data);
}

export async function getApprovalPolicy(
  policyId: string,
  options: ApiOptions = {},
): Promise<ApprovalPolicy> {
  if (isDemoMode()) return mockApi.getApprovalPolicy(policyId, options);
  const data = await call<ApprovalPolicy>(`/api/approval-policies/${encodeURIComponent(policyId)}`, { method: "GET" }, options);
  return scrubSecrets(data);
}

export async function createApprovalPolicy(
  payload: ApprovalPolicyCreateRequest,
  options: ApiOptions = {},
): Promise<ApprovalPolicy> {
  if (isDemoMode()) return mockApi.createApprovalPolicy(payload, options);
  const data = await call<ApprovalPolicy>(`/api/approval-policies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, options);
  return scrubSecrets(data);
}

export async function updateApprovalPolicy(
  policyId: string,
  payload: ApprovalPolicyPatchRequest,
  options: ApiOptions = {},
): Promise<ApprovalPolicy> {
  if (isDemoMode()) return mockApi.updateApprovalPolicy(policyId, payload, options);
  const data = await call<ApprovalPolicy>(`/api/approval-policies/${encodeURIComponent(policyId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, options);
  return scrubSecrets(data);
}

export async function archiveApprovalPolicy(
  policyId: string,
  options: ApiOptions = {},
): Promise<ApprovalPolicy> {
  if (isDemoMode()) return mockApi.archiveApprovalPolicy(policyId, options);
  const data = await call<ApprovalPolicy>(`/api/approval-policies/${encodeURIComponent(policyId)}`, { method: "DELETE" }, options);
  return scrubSecrets(data);
}

// ---------------------------------------------------------------------------
// Integrations (Nango bridge)
// ---------------------------------------------------------------------------

export async function listIntegrationProviders(
  options: ApiOptions = {},
): Promise<IntegrationProvider[]> {
  if (isDemoMode()) return mockApi.listIntegrationProviders(options);
  const data = await call<IntegrationProvider[]>(
    "/api/integrations/providers",
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function listIntegrationConnections(
  options: ApiOptions = {},
): Promise<IntegrationConnection[]> {
  if (isDemoMode()) return mockApi.listIntegrationConnections(options);
  const data = await call<IntegrationConnection[]>(
    "/api/integrations/connections",
    { method: "GET" },
    options,
  );
  return scrubSecrets(data);
}

export async function createIntegrationConnectSession(
  payload: { provider: string },
  options: ApiOptions = {},
): Promise<ConnectSession> {
  if (isDemoMode()) return mockApi.createIntegrationConnectSession(payload, options);
  const data = await call<ConnectSession>(
    "/api/integrations/connect-sessions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function upsertIntegrationConnection(
  payload: CompleteConnectionRequest,
  options: ApiOptions = {},
): Promise<IntegrationConnection> {
  if (isDemoMode()) return mockApi.upsertIntegrationConnection(payload, options);
  const data = await call<IntegrationConnection>(
    "/api/integrations/connections",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function updateIntegrationConnection(
  connectionId: string,
  payload: UpdateConnectionRequest,
  options: ApiOptions = {},
): Promise<IntegrationConnection> {
  if (isDemoMode())
    return mockApi.updateIntegrationConnection(connectionId, payload, options);
  const data = await call<IntegrationConnection>(
    `/api/integrations/connections/${encodeURIComponent(connectionId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}

export async function deleteIntegrationConnection(
  connectionId: string,
  options: ApiOptions = {},
): Promise<void> {
  if (isDemoMode()) return mockApi.deleteIntegrationConnection(connectionId, options);
  await call<void>(
    `/api/integrations/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
    options,
  );
}

export async function triggerIntegrationSync(
  connectionId: string,
  options: ApiOptions = {},
): Promise<ManualSyncResult> {
  if (isDemoMode()) return mockApi.triggerIntegrationSync(connectionId, options);
  const data = await call<ManualSyncResult>(
    `/api/integrations/connections/${encodeURIComponent(connectionId)}/sync`,
    { method: "POST" },
    options,
  );
  return scrubSecrets(data);
}

export async function listIntegrationFolders(
  connectionId: string,
  payload: { parent_id: string | null },
  options: ApiOptions = {},
): Promise<ListFoldersResult> {
  if (isDemoMode())
    return mockApi.listIntegrationFolders(connectionId, payload, options);
  const data = await call<ListFoldersResult>(
    `/api/integrations/connections/${encodeURIComponent(connectionId)}/list-folders`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    options,
  );
  return scrubSecrets(data);
}
