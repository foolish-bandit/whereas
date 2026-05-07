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
import { MOCK_DETAIL_BY_ID, MOCK_LIST } from "./mockData";
import type {
  ContractDetail,
  ContractListItem,
  UploadContractResponse,
} from "../types/contracts";

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
  };
  sessionList.unshift(item);
  sessionDetailById[id] = detail;
  return { ...item, extracted_fields: [], message: null };
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

/**
 * Test helper. Clears any uploads recorded during a vitest run so tests
 * don't leak state.
 */
export function __resetMockState(): void {
  sessionList.length = 0;
  for (const k of Object.keys(sessionDetailById)) {
    delete sessionDetailById[k];
  }
}
