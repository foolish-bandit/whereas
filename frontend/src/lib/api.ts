import { getDevUserId } from "./devUser";
import { isDemoMode } from "./env";
import * as mockApi from "./mockApi";
import type {
  ContractDetail,
  ContractListItem,
  UploadContractResponse,
} from "../types/contracts";
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
