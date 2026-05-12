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
import type {
  ArtifactCompareResponse,
  DiffBlock,
} from "../types/compare";
import {
  MOCK_DETAIL_BY_ID,
  MOCK_FAILED_ID,
  MOCK_LIST,
  MOCK_MARKDOWN_BY_CONTRACT_ID,
  MOCK_NDA_ID,
  MOCK_PLAYBOOK_DETAIL_BY_ID,
  MOCK_PLAYBOOK_LIST,
  MOCK_REVIEW_BY_KEY,
} from "./mockData";
import type {
  Clause,
  ContractArtifact,
  ContractDetail,
  ContractListItem,
  ContractMarkdownSnapshot,
  UploadContractResponse,
} from "../types/contracts";
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
  DeviationFinding,
  ListFindingsFilters,
  ReviewRunDetail,
  ReviewRunSummary,
  ReviewerFindingStatus,
} from "../types/findings";
import type {
  PlaybookDetail,
  PlaybookRuleSummary,
  PlaybookSummary,
  PlaybookValidateResponse,
} from "../types/playbooks";
import type { PlaybookReviewResult } from "../types/review";
import type {
  CreateDevSetupRequest,
  CreateDevSetupResponse,
  SetupStatus,
} from "../types/setup";
import type {
  ContractApprovalGate,
  SendContractToDocuSealRequest,
  SendContractToDocuSealResponse,
} from "../types/docuseal";
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
import type {
  RequestApprovalPolicySummary,
  RequestApprovalStatus,
  RequestApprovalWorkflowSummary,
} from "../types/requestApprovalStatus";
import type {
  DashboardApprovalAnalytics,
  DashboardApprovalAssigneeBucket,
  DashboardContractSummary,
  DashboardCounts,
  DashboardInboxSummary,
  DashboardOldestPendingStep,
  DashboardRequestSummary,
  DashboardSummary,
} from "../types/dashboard";
import type {
  InboxItem,
  InboxItemCreateRequest,
  InboxItemUpdateRequest,
  ListInboxItemFilters,
} from "../types/inboxItems";
import type {
  ApprovalStep,
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
import type { ApprovalPolicy, ApprovalPolicyCreateRequest, ApprovalPolicyPatchRequest, ListApprovalPolicyFilters } from "../types/approvalPolicies";
import {
  MOCK_DEMO_ORG_ID,
  MOCK_INBOX_ITEMS,
  MOCK_REQUESTS,
  MOCK_APPROVAL_POLICIES,
} from "./mockData";

interface ApiOptions {
  signal?: AbortSignal;
}

const MOCK_LATENCY_MS = 250;

const sessionList: ContractListItem[] = [];
const sessionDetailById: Record<string, ContractDetail> = {};
// PR #91 — saved redlines, keyed by contract_id. These are layered on
// top of the synthesized lifecycle artifacts in getContractArtifacts
// so a demo user who clicks "Save to Document History" sees their
// new redline row immediately, as they would against the real backend.
const sessionSavedRedlinesByContractId: Record<string, ContractArtifact[]> = {};

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
  options: ApiOptions & { include_merged?: boolean; q?: string } = {},
): Promise<ContractListItem[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const includeMerged = options.include_merged === true;
  let rows = combinedList();
  if (!includeMerged) {
    rows = rows.filter((row) => !row.merged_into_contract_id);
  }
  // PR #95 / PR #100 — case-insensitive substring match against the
  // record title OR the attached Text preview body (mirroring the
  // backend EXISTS subquery against ContractMarkdownSnapshot). The
  // raw Text preview body is not returned in the list response;
  // matching is purely a filter.
  // PR #101 — when q is active we also compute the closed
  // ``search_match_source`` hint per row (title / text_preview /
  // both) so the UI can render a small chip. When q is absent or
  // whitespace-only the field stays null on every row.
  const needle = (options.q ?? "").trim().toLowerCase();
  if (needle) {
    const annotated: ContractListItem[] = [];
    for (const row of rows) {
      const titleHit = row.title.toLowerCase().includes(needle);
      const snapshot = MOCK_MARKDOWN_BY_CONTRACT_ID[row.id];
      const textHit =
        snapshot != null
          ? snapshot.markdown_text.toLowerCase().includes(needle)
          : false;
      if (!titleHit && !textHit) continue;
      let source: ContractListItem["search_match_source"];
      if (titleHit && textHit) source = "title_and_text_preview";
      else if (titleHit) source = "title";
      else source = "text_preview";
      annotated.push({ ...row, search_match_source: source });
    }
    return annotated;
  }
  return rows.map((row) => ({ ...row, search_match_source: null }));
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

export async function getContractMarkdown(
  id: string,
  options: ApiOptions = {},
): Promise<ContractMarkdownSnapshot | null> {
  await delay(MOCK_LATENCY_MS, options.signal);
  // Session uploads in demo mode never get a snapshot — there's no
  // converter to run client-side. Hard-coded demo contracts may have
  // one in MOCK_MARKDOWN_BY_CONTRACT_ID.
  if (id in sessionDetailById) {
    return null;
  }
  if (!(id in MOCK_DETAIL_BY_ID)) {
    throw new ApiError(404, "Contract not found.");
  }
  return MOCK_MARKDOWN_BY_CONTRACT_ID[id] ?? null;
}

export async function getContractArtifacts(
  id: string,
  options: ApiOptions = {},
): Promise<ContractArtifact[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[id] ?? MOCK_DETAIL_BY_ID[id];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  // Demo mode synthesizes a small artifact lifecycle so the
  // Repository detail view exercises the full lifecycle strip + the
  // PR #69 document-history surface end to end. The seed NDA gets
  // all three stages (uploaded source, generated Word document,
  // signed PDF). The failed-upload demo intentionally returns no
  // artifacts so the legacy-fallback row is exercised. Other rows
  // just get a single original upload.
  if (id === MOCK_FAILED_ID) {
    return [];
  }
  const original: ContractArtifact = {
    id: `${id}-artifact-original`,
    contract_id: id,
    artifact_type: "original_upload",
    storage_backend: "s3",
    filename: `${detail.title}.${detail.mime_type === "application/pdf" ? "pdf" : "docx"}`,
    mime_type: detail.mime_type,
    file_hash_sha256: detail.file_hash_sha256,
    size_bytes: null,
    source: "user_upload",
    is_official: true,
    created_at: detail.created_at,
    metadata_json: null,
  };
  if (id !== MOCK_NDA_ID) {
    const savedNonNda = sessionSavedRedlinesByContractId[id] ?? [];
    return savedNonNda.length === 0
      ? [original]
      : [...savedNonNda, original];
  }
  const generated: ContractArtifact = {
    id: `${id}-artifact-generated`,
    contract_id: id,
    artifact_type: "generated_docx",
    storage_backend: "s3",
    filename: `${detail.title}.docx`,
    mime_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    file_hash_sha256: detail.file_hash_sha256,
    size_bytes: null,
    source: "template_generation",
    is_official: true,
    created_at: detail.created_at,
    metadata_json: {
      template_id: "11111111-1111-4111-8111-111111111111",
      template_name: "Mutual NDA template",
    },
  };
  const signed: ContractArtifact = {
    id: `${id}-artifact-signed`,
    contract_id: id,
    artifact_type: "signed_pdf",
    storage_backend: "s3",
    filename: `${detail.title}.signed.pdf`,
    mime_type: "application/pdf",
    file_hash_sha256: detail.file_hash_sha256,
    size_bytes: null,
    source: "docuseal",
    is_official: true,
    created_at: detail.updated_at,
    metadata_json: { docuseal_submission_id: "demo-submission-1" },
  };
  // Listing order: newest first, matching the real backend's
  // ``created_at desc`` ordering.
  const base = [signed, generated, original];
  const saved = sessionSavedRedlinesByContractId[id] ?? [];
  if (saved.length === 0) return base;
  return [...saved, ...base];
}

export async function uploadContract(
  input: UploadInput,
): Promise<UploadContractResponse> {
  await delay(MOCK_LATENCY_MS, input.signal);
  const id = `demo-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const explicitTitle = (input.title ?? "").trim();
  const filename = input.file.name;
  const intake = buildDemoIntake(filename, explicitTitle, sessionList);
  const title =
    explicitTitle ||
    intake.extracted_metadata?.suggested_title ||
    filename.replace(/\.[^.]+$/, "") ||
    "Demo upload";
  const now = new Date().toISOString();
  const mime =
    input.file.type ||
    (filename.toLowerCase().endsWith(".docx")
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
  return {
    ...item,
    extracted_fields: [],
    clauses: [],
    message: null,
    extracted_metadata: intake.extracted_metadata,
    duplicate_candidates: intake.duplicate_candidates,
  };
}

/**
 * Demo-mode helper for the PR #66 upload-intake fields.
 *
 * Returns a small, deterministic ``ExtractedContractMetadata`` derived
 * from the filename and a duplicate-candidate list pulled from the
 * session's contract memory when the new title matches an existing
 * one. The mock is intentionally simple — it isn't trying to mirror
 * the backend's regex set, just to give the demo something sensible
 * to render so reviewers can click through the UI.
 */
function buildDemoIntake(
  filename: string,
  explicitTitle: string,
  list: ContractListItem[],
): {
  extracted_metadata: import("../types/contractIntake").ExtractedContractMetadata;
  duplicate_candidates: import("../types/contractIntake").DuplicateContractCandidate[];
} {
  const stem = filename.replace(/\.[^.]+$/, "");
  const normalized = stem.replace(/[_\-\.]+/g, " ").trim();
  const suggestedTitle = normalized || null;
  const upper = (normalized || filename).toUpperCase();
  const typeMatch: string | null = upper.includes("AMENDMENT")
    ? "Amendment"
    : upper.includes("SOW") || upper.includes("STATEMENT OF WORK")
      ? "SOW"
      : upper.includes("NDA")
        ? "NDA"
        : upper.includes("DPA")
          ? "DPA"
          : upper.includes("MSA")
            ? "MSA"
            : upper.includes("EMPLOYMENT")
              ? "Employment Agreement"
              : null;
  const warnings: string[] = [];
  if (typeMatch === null) warnings.push("contract_type_unknown");
  warnings.push("counterparty_unknown", "effective_date_unknown");

  const matchTitleLower = (explicitTitle || normalized).toLowerCase();
  const duplicate_candidates: import("../types/contractIntake").DuplicateContractCandidate[] =
    matchTitleLower
      ? list
          .filter((c) => c.title.toLowerCase() === matchTitleLower)
          .slice(0, 5)
          .map((c) => ({
            contract_id: c.id,
            title: c.title,
            reason: "similar_title" as const,
            confidence: "possible" as const,
            created_at: c.created_at,
            status: c.status,
          }))
      : [];

  return {
    extracted_metadata: {
      suggested_title: suggestedTitle,
      likely_contract_type: typeMatch,
      possible_counterparty_name: null,
      effective_date: null,
      warnings,
    },
    duplicate_candidates,
  };
}


// ---------------------------------------------------------------------------
// PR #67 — demo metadata GET / PATCH for the upload-review panel.
//
// Stored entirely in module-local state so the demo can round-trip
// confirmed metadata through GET / PATCH cycles without a backend.
// ---------------------------------------------------------------------------

interface DemoContractMetadata {
  title: string;
  counterparty_name: string | null;
  contract_type: string | null;
  effective_date: string | null;
  updated_at: string;
}

const sessionMetadataById: Record<string, DemoContractMetadata> = {};


function _ensureMetadataEntry(contractId: string): DemoContractMetadata {
  const existing = sessionMetadataById[contractId];
  if (existing) return existing;
  const item =
    sessionList.find((c) => c.id === contractId) ??
    sessionDetailById[contractId];
  const title =
    (item as ContractListItem | ContractDetail | undefined)?.title ??
    "Untitled contract";
  const next: DemoContractMetadata = {
    title,
    counterparty_name: null,
    contract_type: null,
    effective_date: null,
    updated_at:
      ((item as ContractListItem | ContractDetail | undefined)?.updated_at) ??
      new Date().toISOString(),
  };
  sessionMetadataById[contractId] = next;
  return next;
}


export async function getContractMetadata(
  id: string,
  options: ApiOptions = {},
): Promise<import("../types/contractIntake").ContractMetadataView> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const entry = _ensureMetadataEntry(id);
  return {
    contract_id: id,
    title: entry.title,
    counterparty_name: entry.counterparty_name,
    contract_type: entry.contract_type,
    effective_date: entry.effective_date,
    updated_at: entry.updated_at,
    changed_fields: [],
  };
}


export async function updateContractMetadata(
  id: string,
  payload: import("../types/contractIntake").ContractMetadataUpdateRequest,
  options: ApiOptions = {},
): Promise<import("../types/contractIntake").ContractMetadataView> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const entry = _ensureMetadataEntry(id);
  const changed: string[] = [];

  if ("title" in payload) {
    const next =
      (payload.title ?? "").trim().slice(0, 500) || "Untitled contract";
    if (next !== entry.title) {
      entry.title = next;
      changed.push("title");
    }
  }
  if ("counterparty_name" in payload) {
    const raw = payload.counterparty_name ?? null;
    const next = raw && raw.trim() ? raw.trim().slice(0, 255) : null;
    if (next !== entry.counterparty_name) {
      entry.counterparty_name = next;
      changed.push("counterparty_name");
    }
  }
  if ("contract_type" in payload) {
    const raw = payload.contract_type ?? null;
    const next = raw && raw.trim() ? raw.trim().slice(0, 64) : null;
    if (next !== entry.contract_type) {
      entry.contract_type = next;
      changed.push("contract_type");
    }
  }
  if ("effective_date" in payload) {
    const next = payload.effective_date ?? null;
    if (next !== entry.effective_date) {
      entry.effective_date = next;
      changed.push("effective_date");
    }
  }

  if (changed.length > 0) {
    entry.updated_at = new Date().toISOString();
    // Mirror the title back onto the session list so the rest of the
    // demo UI reflects the rename without a refetch.
    const listItem = sessionList.find((c) => c.id === id);
    if (listItem) {
      listItem.title = entry.title;
      listItem.updated_at = entry.updated_at;
    }
    const detail = sessionDetailById[id];
    if (detail) {
      detail.title = entry.title;
      detail.updated_at = entry.updated_at;
    }
  }

  return {
    contract_id: id,
    title: entry.title,
    counterparty_name: entry.counterparty_name,
    contract_type: entry.contract_type,
    effective_date: entry.effective_date,
    updated_at: entry.updated_at,
    changed_fields: changed,
  };
}



export async function getContractApprovalGate(
  id: string,
  options: ApiOptions = {},
): Promise<ContractApprovalGate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  if (id.includes("policy-blocked")) {
    // PR #59 demo: gate blocked by an unmet approval policy with a
    // human-readable name; exercises the named-policy rendering path
    // in SendToDocusealPanel without requiring a real backend.
    const policy = {
      id: "demo-policy-1",
      name: "Standard Legal Review",
      workflow_template_id: "demo-tpl-1",
      auto_attach: true,
      applies_to_generated_contracts: true,
      request_type: null,
      contract_type: null,
      priority: null,
      agreement_template_id: null,
    };
    return {
      allowed: false,
      code: "required_approval_policy_unmet",
      request_id: "demo-request-1",
      blocking_workflow_ids: [],
      completed_workflow_ids: [],
      active_count: 0,
      rejected_count: 0,
      cancelled_count: 0,
      completed_count: 0,
      required_policy_ids: [policy.id],
      missing_policy_ids: [policy.id],
      required_policies: [policy],
      missing_policies: [policy],
    };
  }
  if (id.includes("blocked")) {
    return {
      allowed: false,
      code: "active_approval_workflows",
      request_id: "demo-request-1",
      blocking_workflow_ids: ["demo-wf-1"],
      completed_workflow_ids: [],
      active_count: 1,
      rejected_count: 0,
      cancelled_count: 0,
      completed_count: 0,
      required_policy_ids: [],
      missing_policy_ids: [],
      required_policies: [],
      missing_policies: [],
    };
  }
  return {
    allowed: true,
    code: "no_linked_request",
    request_id: null,
    blocking_workflow_ids: [],
    completed_workflow_ids: [],
    active_count: 0,
    rejected_count: 0,
    cancelled_count: 0,
    completed_count: 0,
    required_policy_ids: [],
    missing_policy_ids: [],
    required_policies: [],
    missing_policies: [],
  };
}

export async function sendContractToDocuseal(
  id: string,
  payload: SendContractToDocuSealRequest,
  options: ApiOptions = {},
): Promise<SendContractToDocuSealResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[id] ?? MOCK_DETAIL_BY_ID[id];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  if (!payload.signers || payload.signers.length === 0) {
    throw new ApiError(400, "At least one signer is required.");
  }
  const gate = await getContractApprovalGate(id, options);
  if (!gate.allowed && !payload.approval_override) {
    throw new ApiError(
      409,
      "Contract cannot be sent to DocuSeal until approvals are completed.",
    );
  }
  if (!gate.allowed && !payload.approval_override_reason?.trim()) {
    throw new ApiError(422, "approval_override_reason is required when override is enabled.");
  }
  const submissionId = `demo-submission-${Date.now().toString(36)}`;
  return {
    contract_id: detail.id,
    artifact_id: `demo-art-${Date.now().toString(36)}`,
    artifact_type: "generated_docx",
    filename: `${detail.title.replace(/[^A-Za-z0-9._-]+/g, "_")}.docx`.slice(
      0,
      180,
    ),
    submission_id: submissionId,
    status: "sent_for_signature",
    embed_url: null,
    signer_count: payload.signers.length,
    raw: { id: submissionId, demo: true },
  };
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
 * PR #70 — per-artifact download in demo mode. Mirrors the real
 * client's surface so the Document History "Download version" action
 * works on the demo deployment too. No real bytes are stored, so we
 * just return a deterministic placeholder that names the artifact
 * being requested.
 */
export async function downloadContractArtifact(
  contractId: string,
  artifactId: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  const safeTitle =
    detail.title.replace(/[^A-Za-z0-9._-]+/g, "_") || "contract";
  const filename = `${safeTitle}.version-${artifactId.slice(0, 8)}.demo.txt`.slice(
    0,
    180,
  );
  const body =
    `Whereas demo mode placeholder.\n\n` +
    `Title: ${detail.title}\n` +
    `Contract id: ${detail.id}\n` +
    `Artifact id: ${artifactId}\n\n` +
    `No real document is stored in demo mode. To exercise the actual ` +
    `per-version download flow, run Whereas locally with a backend ` +
    `and clear VITE_WHEREAS_DEMO_MODE.\n`;
  return {
    blob: new Blob([body], { type: "text/plain" }),
    filename,
    mimeType: "text/plain",
  };
}


export async function previewContractArtifact(
  contractId: string,
  artifactId: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  if (!detail) throw new ApiError(404, "Contract not found.");
  const artifacts = await getContractArtifacts(contractId, options);
  const artifact = artifacts.find((a) => a.id === artifactId);
  if (!artifact) throw new ApiError(404, "Artifact not found.");
  if (artifact.mime_type !== "application/pdf") {
    throw new ApiError(422, "PDF preview is not available for this file type yet.");
  }
  const body = `%PDF-1.1\n% demo preview for ${artifact.filename ?? "artifact"}\n`;
  return { blob: new Blob([body], { type: "application/pdf" }), filename: artifact.filename ?? "preview.pdf", mimeType: "application/pdf" };
}

/**
 * PR #71 — demo-mode artifact compare. The real backend extracts
 * comparable text via MarkItDown and diffs the result; demo mode
 * synthesizes a small, deterministic redline so the panel renders
 * end-to-end without a backend. The seed NDA's three lifecycle
 * artifacts (source / generated / signed) each have a canned
 * plain-text body; comparing any two yields a structured diff with
 * realistic added/removed/context counts.
 */
export async function compareContractArtifacts(
  contractId: string,
  baseArtifactId: string,
  compareArtifactId: string,
  options: ApiOptions = {},
): Promise<ArtifactCompareResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const detail = sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  if (!detail) {
    throw new ApiError(404, "Contract not found.");
  }
  const artifacts = await getContractArtifacts(contractId, options);
  const base = artifacts.find((a) => a.id === baseArtifactId);
  const compareArt = artifacts.find((a) => a.id === compareArtifactId);
  if (!base || !compareArt) {
    throw new ApiError(404, "Artifact not found.");
  }
  const baseText = _demoArtifactText(base.artifact_type, detail.title);
  const compareText = _demoArtifactText(compareArt.artifact_type, detail.title);
  const diff = _demoDiff(baseText, compareText);
  return {
    base: {
      artifact_id: base.id,
      artifact_type: base.artifact_type,
      label: _demoLabel(base.artifact_type),
      filename: base.filename ?? null,
      created_at: base.created_at,
    },
    compare: {
      artifact_id: compareArt.id,
      artifact_type: compareArt.artifact_type,
      label: _demoLabel(compareArt.artifact_type),
      filename: compareArt.filename ?? null,
      created_at: compareArt.created_at,
    },
    summary: diff.summary,
    diff_blocks: diff.blocks,
    warnings: [],
  };
}

/**
 * Demo-mode counterpart for the PR #91 persisted-redline save. Adds
 * a synthetic ``redline`` ContractArtifact row to the session
 * artifacts map for the given contract so the Document History list
 * picks it up on the next fetch.
 */
export async function saveContractArtifactsCompare(
  contractId: string,
  baseArtifactId: string,
  compareArtifactId: string,
  options: ApiOptions = {},
): Promise<ContractArtifact> {
  await delay(MOCK_LATENCY_MS, options.signal);
  // Reuse the compare path for org/contract/artifact resolution so
  // the demo error handling matches the live backend.
  const compare = await compareContractArtifacts(
    contractId,
    baseArtifactId,
    compareArtifactId,
    options,
  );
  const detail =
    sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  const contractTitle = detail?.title ?? "comparison-report";
  const safe =
    (contractTitle || "comparison-report")
      .replace(/[^A-Za-z0-9 _-]/g, "_")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 80) || "comparison-report";
  const now = new Date().toISOString();
  const redline: ContractArtifact = {
    id: `${contractId}-redline-${Date.now().toString(36)}`,
    contract_id: contractId,
    artifact_type: "redline",
    storage_backend: "s3",
    filename: `${safe}-comparison-report.docx`,
    mime_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    file_hash_sha256: null,
    size_bytes: 4096,
    source: "comparison_report",
    is_official: false,
    created_at: now,
    metadata_json: {
      base_artifact_id: compare.base.artifact_id,
      compare_artifact_id: compare.compare.artifact_id,
      base_artifact_type: compare.base.artifact_type,
      compare_artifact_type: compare.compare.artifact_type,
      added_lines: compare.summary.added_lines,
      removed_lines: compare.summary.removed_lines,
      changed_blocks: compare.summary.changed_blocks,
      unchanged_lines: compare.summary.unchanged_lines,
      format: "docx",
      source_kind: "comparison_report",
    },
  };
  const existing = sessionSavedRedlinesByContractId[contractId] ?? [];
  sessionSavedRedlinesByContractId[contractId] = [redline, ...existing];
  return redline;
}

/**
 * Demo-mode counterpart for the PR #90 redline export. The mock
 * synthesizes a small, valid-looking text blob and returns it as a
 * Blob so the browser still triggers a real download flow in demo
 * mode. The blob is plain-text rather than a real DOCX — the
 * comparison-report rendering is server-only — but it carries enough
 * structure (title, disclaimer, version metadata, diff) that the demo
 * shows the "this is a comparison preview, not an official Word
 * redline" framing.
 */
export async function exportContractArtifactsCompare(
  contractId: string,
  baseArtifactId: string,
  compareArtifactId: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const compare = await compareContractArtifacts(
    contractId,
    baseArtifactId,
    compareArtifactId,
    options,
  );
  const detail =
    sessionDetailById[contractId] ?? MOCK_DETAIL_BY_ID[contractId];
  const contractTitle = detail?.title ?? "comparison-report";
  const lines: string[] = [
    `Comparison report — ${contractTitle}`,
    "",
    "This is a text comparison preview, not an official Word redline.",
    "Differences are highlighted as a working aid; the underlying",
    "official documents remain authoritative.",
    "",
    `Left version:  ${compare.base.label}` +
      (compare.base.filename ? ` — ${compare.base.filename}` : ""),
    `Right version: ${compare.compare.label}` +
      (compare.compare.filename ? ` — ${compare.compare.filename}` : ""),
    "",
    `Summary: added ${compare.summary.added_lines}, ` +
      `removed ${compare.summary.removed_lines}, ` +
      `changed blocks ${compare.summary.changed_blocks}, ` +
      `unchanged ${compare.summary.unchanged_lines}`,
    "",
    "Differences:",
  ];
  for (const block of compare.diff_blocks) {
    if (block.type === "context") {
      lines.push(
        `… ${block.lines.length} unchanged line${
          block.lines.length === 1 ? "" : "s"
        } …`,
      );
      continue;
    }
    for (const line of block.lines) {
      const prefix =
        line.type === "removed" ? "- " : line.type === "added" ? "+ " : "  ";
      lines.push(prefix + line.text);
    }
  }
  const body = lines.join("\n");
  const blob = new Blob([body], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const safe = (contractTitle || "comparison-report")
    .replace(/[^A-Za-z0-9 _-]/g, "_")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 80) || "comparison-report";
  return {
    blob,
    filename: `${safe}-comparison-report.docx`,
    mimeType: blob.type,
  };
}

function _demoLabel(artifactType: string): string {
  switch (artifactType) {
    case "original_upload":
      return "Source file";
    case "generated_docx":
      return "Generated Word document";
    case "signed_pdf":
      return "Signed PDF";
    case "redline":
      return "Redline";
    case "attachment":
      return "Attachment";
    case "exhibit":
      return "Exhibit";
    default:
      return "File";
  }
}

function _demoArtifactText(artifactType: string, title: string): string {
  // Each lifecycle stage gets a slightly different canned body so the
  // demo diff shows realistic added/removed/changed paragraphs.
  // PR #93 — paragraphs are blank-line-separated so the new
  // paragraph-aware splitter produces multiple comparable units
  // instead of collapsing the whole body into one paragraph.
  const heading = `# ${title}`;
  if (artifactType === "signed_pdf") {
    return [
      heading,
      "",
      "Section 1. Term.",
      "",
      "The Agreement is for two (2) years from the Effective Date.",
      "",
      "Section 2. Confidentiality.",
      "",
      "Each party shall hold the other party's Confidential Information in strict confidence.",
      "",
      "Signed by both parties.",
      "",
    ].join("\n");
  }
  if (artifactType === "generated_docx") {
    return [
      heading,
      "",
      "Section 1. Term.",
      "",
      "The Agreement is for two (2) years from the Effective Date.",
      "",
      "Section 2. Confidentiality.",
      "",
      "Each party shall hold the other party's Confidential Information in strict confidence.",
      "",
    ].join("\n");
  }
  // Source / original / other → use the more conservative one-year
  // template so the compare panel has something to surface.
  return [
    heading,
    "",
    "Section 1. Term.",
    "",
    "The Agreement is for one (1) year from the Effective Date.",
    "",
    "Section 2. Confidentiality.",
    "",
    "Each party shall hold Confidential Information in confidence.",
    "",
  ].join("\n");
}

/**
 * Split ``text`` into paragraph-shaped blocks mirroring the backend's
 * ``_split_paragraphs`` (PR #93): blank-line-separated, internal
 * whitespace collapsed to single spaces, empty paragraphs dropped.
 * Production diffs come from the backend; this is the in-browser
 * equivalent used by the hosted demo so the demo behaves like prod.
 */
function _splitParagraphs(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const chunks = normalized.split(/\n[ \t]*\n[\s]*/);
  const paragraphs: string[] = [];
  for (const chunk of chunks) {
    const collapsed = chunk.replace(/\s+/g, " ").trim();
    if (collapsed) paragraphs.push(collapsed);
  }
  return paragraphs;
}

function _demoDiff(
  baseText: string,
  compareText: string,
): { summary: ArtifactCompareResponse["summary"]; blocks: DiffBlock[] } {
  // Paragraph-by-paragraph walk over the splitter output. Good
  // enough for the demo's canned text; production diffs come from
  // the backend.
  const baseLines = _splitParagraphs(baseText);
  const compareLines = _splitParagraphs(compareText);
  const blocks: DiffBlock[] = [];
  let summary = {
    added_lines: 0,
    removed_lines: 0,
    changed_blocks: 0,
    unchanged_lines: 0,
  };
  let i = 0;
  let j = 0;
  while (i < baseLines.length || j < compareLines.length) {
    const baseLine = baseLines[i];
    const compareLine = compareLines[j];
    if (i < baseLines.length && j < compareLines.length && baseLine === compareLine) {
      const block: DiffBlock = {
        type: "context",
        base_line_start: i + 1,
        compare_line_start: j + 1,
        lines: [],
      };
      while (
        i < baseLines.length &&
        j < compareLines.length &&
        baseLines[i] === compareLines[j]
      ) {
        block.lines.push({ type: "context", text: baseLines[i] });
        summary.unchanged_lines += 1;
        i += 1;
        j += 1;
      }
      blocks.push(block);
      continue;
    }
    if (
      i < baseLines.length &&
      j < compareLines.length &&
      baseLine !== compareLine
    ) {
      blocks.push({
        type: "changed",
        base_line_start: i + 1,
        compare_line_start: j + 1,
        lines: [
          { type: "removed", text: baseLine },
          { type: "added", text: compareLine },
        ],
      });
      summary = {
        ...summary,
        added_lines: summary.added_lines + 1,
        removed_lines: summary.removed_lines + 1,
        changed_blocks: summary.changed_blocks + 1,
      };
      i += 1;
      j += 1;
      continue;
    }
    if (i < baseLines.length) {
      blocks.push({
        type: "removed",
        base_line_start: i + 1,
        compare_line_start: j + 1,
        lines: [{ type: "removed", text: baseLine }],
      });
      summary = { ...summary, removed_lines: summary.removed_lines + 1 };
      i += 1;
      continue;
    }
    if (j < compareLines.length) {
      blocks.push({
        type: "added",
        base_line_start: i + 1,
        compare_line_start: j + 1,
        lines: [{ type: "added", text: compareLine }],
      });
      summary = { ...summary, added_lines: summary.added_lines + 1 };
      j += 1;
      continue;
    }
  }
  return { summary, blocks };
}

function _applyCannedDeactivations<T extends { id: string; is_active: boolean }>(
  rows: T[],
): T[] {
  return rows.map((p) =>
    cannedDeactivations.has(p.id) ? { ...p, is_active: false } : p,
  );
}

export async function getPlaybooks(
  options: ApiOptions & { includeInactive?: boolean } = {},
): Promise<PlaybookSummary[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const merged = _applyCannedDeactivations([
    ...sessionPlaybookList,
    ...MOCK_PLAYBOOK_LIST,
  ]);
  if (options.includeInactive) {
    return merged;
  }
  return merged.filter((p) => p.is_active);
}

export async function getPlaybook(
  id: string,
  options: ApiOptions & { includeInactive?: boolean } = {},
): Promise<PlaybookDetail> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const raw = sessionPlaybookDetailById[id] ?? MOCK_PLAYBOOK_DETAIL_BY_ID[id];
  if (!raw) {
    throw new ApiError(404, "Playbook not found.");
  }
  const detail = cannedDeactivations.has(id)
    ? { ...raw, is_active: false }
    : raw;
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
  archivedDemoClauseIds.clear();
  for (const k of Object.keys(sessionSavedRedlinesByContractId)) {
    delete sessionSavedRedlinesByContractId[k];
  }
  sessionPlaybookList.length = 0;
  for (const k of Object.keys(sessionPlaybookDetailById)) {
    delete sessionPlaybookDetailById[k];
  }
  cannedDeactivations.clear();
  demoSetupCompleted = false;
  sessionApprovalRuns.length = 0;
  sessionApprovalRuns.push(..._buildDemoApprovalRuns());
  sessionApprovalTemplates.length = 0;
  sessionApprovalPolicies.length = 0;
  sessionApprovalPolicies.push(...(MOCK_APPROVAL_POLICIES as ApprovalPolicy[]).map((p) => ({ ...p })));
}

const DEMO_CLAUSE_TEMPLATES: ClauseTemplate[] = [
  { id: "ct-1", organization_id: "demo-org", name: "Mutual NDA confidentiality clause", clause_type: "confidentiality", text: "Each Party shall keep Confidential Information strictly confidential...", description: "Baseline NDA confidentiality", jurisdiction: "California", contract_type: "mutual_nda", version: "1.0", source: "Firm standard", tags: ["nda","core"], is_active: true, created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" },
  { id: "ct-2", organization_id: "demo-org", name: "Governing law clause", clause_type: "governing_law", text: "This Agreement is governed by California law...", description: null, jurisdiction: "California", contract_type: "msa", version: "1.0", source: null, tags: ["governing-law"], is_active: true, created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" },
  { id: "ct-3", organization_id: "demo-org", name: "Assignment clause", clause_type: "assignment", text: "Neither Party may assign this Agreement without prior written consent...", description: null, jurisdiction: null, contract_type: "msa", version: null, source: null, tags: ["assignment"], is_active: true, created_at: "2026-05-01T00:00:00Z", updated_at: "2026-05-01T00:00:00Z" },
  { id: "ct-4", organization_id: "demo-org", name: "Legacy indemnity clause (archived)", clause_type: "indemnification", text: "Each Party shall indemnify and hold harmless the other Party...", description: "Superseded by 2026 mutual-indemnity standard.", jurisdiction: null, contract_type: "msa", version: "0.9", source: "Legacy template", tags: ["indemnity","legacy"], is_active: false, created_at: "2025-09-12T00:00:00Z", updated_at: "2026-02-04T00:00:00Z" },
];

const sessionClauseTemplates: ClauseTemplate[] = [];

// Demo rows are read-only by reference, but Archive should still work
// in demo mode. Track soft-archive overrides for demo IDs here so the
// list reflects the user's action without mutating the baseline data.
const archivedDemoClauseIds: Set<string> = new Set();

function withClauseArchiveOverride(row: ClauseTemplate): ClauseTemplate {
  if (archivedDemoClauseIds.has(row.id) && row.is_active) {
    return { ...row, is_active: false };
  }
  return row;
}

export async function listClauseTemplates(filters: { clause_type?: string; jurisdiction?: string; contract_type?: string; tag?: string; include_inactive?: boolean } = {}, options: ApiOptions = {}): Promise<ClauseTemplate[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  let rows = [...sessionClauseTemplates, ...DEMO_CLAUSE_TEMPLATES].map(
    withClauseArchiveOverride,
  );
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
  return withClauseArchiveOverride(row);
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
    return;
  }
  // Demo (read-only) row: record a soft-archive override so the
  // list reflects the action without mutating the baseline fixture.
  archivedDemoClauseIds.add(id);
}

// ---------------------------------------------------------------------------
// Agreement templates (demo mode)
// ---------------------------------------------------------------------------

const DEMO_ORG_AT = "00000000-0000-4000-8000-0000000000aa";
const NDA_ID = "11111111-1111-4111-8111-111111111111";
const MSA_ID = "22222222-2222-4222-8222-222222222222";

// Archived demo template id — surfaces archived UI states without
// touching the two active templates the existing tests / demo flows
// already rely on.
const LEGACY_NDA_ID = "33333333-3333-4333-8333-333333333344";

const demoAgreementTemplates: AgreementTemplate[] = [
  {
    id: NDA_ID,
    organization_id: DEMO_ORG_AT,
    name: "Mutual NDA",
    description: "Standard mutual non-disclosure agreement.",
    template_type: "NDA",
    status: "active",
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-15T10:00:00Z",
    metadata_json: null,
  },
  {
    id: MSA_ID,
    organization_id: DEMO_ORG_AT,
    name: "Master Services Agreement",
    description: "Default MSA template; warnings on import.",
    template_type: "MSA",
    status: "active",
    created_at: "2026-04-02T10:00:00Z",
    updated_at: "2026-04-20T10:00:00Z",
    metadata_json: null,
  },
  {
    id: LEGACY_NDA_ID,
    organization_id: DEMO_ORG_AT,
    name: "Legacy NDA (2024)",
    description:
      "Archived — superseded by the current mutual NDA. Kept for audit history.",
    template_type: "NDA",
    status: "archived",
    created_at: "2024-08-12T10:00:00Z",
    updated_at: "2026-02-04T10:00:00Z",
    metadata_json: null,
  },
];

const demoAgreementTemplateMarkdown: Record<
  string,
  AgreementTemplateMarkdownSnapshot | null
> = {
  [NDA_ID]: {
    id: "33333333-3333-4333-8333-333333333333",
    template_id: NDA_ID,
    markdown_text:
      "# Mutual NDA\n\nThis Mutual Non-Disclosure Agreement is entered into by **{{counterparty_name}}** and the Company as of {{effective_date}}.\n\n## Confidential Information\n\nEach party agrees to protect the other's Confidential Information.",
    source_kind: "original_upload",
    converter_name: "markitdown",
    converter_version: "0.0.1",
    conversion_status: "ready",
    conversion_warnings: null,
    created_at: "2026-04-01T10:05:00Z",
  },
  // MSA conversion produced warnings and no snapshot — exercises the empty
  // state in the UI.
  [MSA_ID]: null,
  [LEGACY_NDA_ID]: null,
};

const demoAgreementTemplateArtifacts: Record<string, AgreementTemplateArtifact[]> = {
  [NDA_ID]: [
    // Newest source upload — the current source file.
    {
      id: "44444444-4444-4444-8444-444444444444",
      template_id: NDA_ID,
      artifact_type: "original_upload",
      storage_backend: "s3",
      filename: "mutual-nda.docx",
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      file_hash_sha256: null,
      size_bytes: 24576,
      source: "user_upload",
      is_official: true,
      created_at: "2026-04-01T10:05:00Z",
      metadata_json: null,
    },
    // Older source upload — kept so the version history section
    // (PR #102) has more than one row to render. Non-official so the
    // "current source" marker only applies to the row above.
    {
      id: "44444444-4444-4444-8444-444444444443",
      template_id: NDA_ID,
      artifact_type: "original_upload",
      storage_backend: "s3",
      filename: "mutual-nda-v1.docx",
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      file_hash_sha256: null,
      size_bytes: 23552,
      source: "user_upload",
      is_official: false,
      created_at: "2026-03-15T08:30:00Z",
      metadata_json: null,
    },
  ],
  [MSA_ID]: [],
  [LEGACY_NDA_ID]: [],
};

const demoAgreementTemplateVariables: Record<string, AgreementTemplateVariable[]> = {
  [NDA_ID]: [
    {
      id: "55555555-5555-4555-8555-555555555551",
      template_id: NDA_ID,
      key: "counterparty_name",
      label: "Counterparty Name",
      variable_type: "text",
      required: true,
      default_value: null,
      help_text: "Legal name of the other party.",
      sort_order: 1,
      metadata_json: null,
      created_at: "2026-04-01T10:00:00Z",
      updated_at: "2026-04-01T10:00:00Z",
    },
    {
      id: "55555555-5555-4555-8555-555555555552",
      template_id: NDA_ID,
      key: "effective_date",
      label: "Effective Date",
      variable_type: "date",
      required: true,
      default_value: null,
      help_text: null,
      sort_order: 2,
      metadata_json: null,
      created_at: "2026-04-01T10:00:00Z",
      updated_at: "2026-04-01T10:00:00Z",
    },
    // Two optional variables exercise the required/optional grouping
    // in the generation form (PR #94).
    {
      id: "55555555-5555-4555-8555-555555555553",
      template_id: NDA_ID,
      key: "term_years",
      label: "Term (years)",
      variable_type: "number",
      required: false,
      default_value: "2",
      help_text: "Default is two (2) years.",
      sort_order: 3,
      metadata_json: null,
      created_at: "2026-04-01T10:00:00Z",
      updated_at: "2026-04-01T10:00:00Z",
    },
    {
      id: "55555555-5555-4555-8555-555555555554",
      template_id: NDA_ID,
      key: "governing_law",
      label: "Governing Law",
      variable_type: "text",
      required: false,
      default_value: "California",
      help_text: null,
      sort_order: 4,
      metadata_json: null,
      created_at: "2026-04-01T10:00:00Z",
      updated_at: "2026-04-01T10:00:00Z",
    },
  ],
  [MSA_ID]: [],
  [LEGACY_NDA_ID]: [],
};

function _findTemplate(id: string): AgreementTemplate | undefined {
  return demoAgreementTemplates.find((t) => t.id === id);
}

export async function listAgreementTemplates(
  filters: { include_archived?: boolean; template_type?: string } = {},
  options: ApiOptions = {},
): Promise<AgreementTemplate[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  let rows = demoAgreementTemplates.slice();
  if (!filters.include_archived) {
    rows = rows.filter((t) => t.status === "active");
  }
  if (filters.template_type) {
    rows = rows.filter((t) => t.template_type === filters.template_type);
  }
  return rows;
}

export async function getAgreementTemplate(
  id: string,
  options: ApiOptions = {},
): Promise<AgreementTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = _findTemplate(id);
  if (!row) throw new ApiError(404, "Agreement template not found.");
  return row;
}

export async function createAgreementTemplate(
  payload: AgreementTemplateCreateRequest,
  options: ApiOptions = {},
): Promise<AgreementTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const now = new Date().toISOString();
  const row: AgreementTemplate = {
    id: `demo-${Math.random().toString(36).slice(2)}`,
    organization_id: DEMO_ORG_AT,
    name: payload.name,
    description: payload.description ?? null,
    template_type: payload.template_type ?? null,
    status: "active",
    created_at: now,
    updated_at: now,
    metadata_json: payload.metadata_json ?? null,
  };
  demoAgreementTemplates.unshift(row);
  demoAgreementTemplateMarkdown[row.id] = null;
  demoAgreementTemplateArtifacts[row.id] = [];
  demoAgreementTemplateVariables[row.id] = [];
  return row;
}

export async function updateAgreementTemplate(
  id: string,
  payload: AgreementTemplateUpdateRequest,
  options: ApiOptions = {},
): Promise<AgreementTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = _findTemplate(id);
  if (!row) throw new ApiError(404, "Agreement template not found.");
  if (payload.name !== undefined) row.name = payload.name;
  if (payload.description !== undefined) row.description = payload.description;
  if (payload.template_type !== undefined)
    row.template_type = payload.template_type;
  if (payload.status !== undefined) row.status = payload.status;
  if (payload.metadata_json !== undefined)
    row.metadata_json = payload.metadata_json;
  row.updated_at = new Date().toISOString();
  return row;
}

export async function archiveAgreementTemplate(
  id: string,
  options: ApiOptions = {},
): Promise<void> {
  await updateAgreementTemplate(id, { status: "archived" }, options);
}

export async function uploadAgreementTemplateArtifact(
  id: string,
  file: File,
  options: ApiOptions = {},
): Promise<AgreementTemplateArtifact> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = _findTemplate(id);
  if (!row) throw new ApiError(404, "Agreement template not found.");
  const artifact: AgreementTemplateArtifact = {
    id: `demo-art-${Math.random().toString(36).slice(2)}`,
    template_id: id,
    artifact_type: "original_upload",
    storage_backend: "s3",
    filename: file.name,
    mime_type: file.type || null,
    file_hash_sha256: null,
    size_bytes: file.size,
    source: "user_upload",
    is_official: true,
    created_at: new Date().toISOString(),
    metadata_json: null,
  };
  const existing = demoAgreementTemplateArtifacts[id] ?? [];
  demoAgreementTemplateArtifacts[id] = [artifact, ...existing];
  return artifact;
}

export async function getAgreementTemplateArtifacts(
  id: string,
  options: ApiOptions = {},
): Promise<AgreementTemplateArtifact[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  return demoAgreementTemplateArtifacts[id] ?? [];
}

export async function downloadAgreementTemplateArtifact(
  templateId: string,
  artifactId: string,
  options: ApiOptions = {},
): Promise<DownloadResult> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const artifacts = demoAgreementTemplateArtifacts[templateId] ?? [];
  const artifact = artifacts.find((a) => a.id === artifactId);
  if (!artifact) {
    throw new ApiError(404, "Template artifact not found.");
  }
  const safeName =
    (artifact.filename ?? "template-source")
      .replace(/[^A-Za-z0-9._-]+/g, "_") || "template-source";
  const filename = `${safeName}.demo.txt`.slice(0, 180);
  const body =
    `Whereas demo mode placeholder.\n\n` +
    `Template id: ${templateId}\n` +
    `Artifact id: ${artifactId}\n` +
    `Original filename: ${artifact.filename ?? "(none)"}\n\n` +
    `No real document is stored in demo mode. To exercise the actual ` +
    `per-version download flow, run Whereas locally with a backend ` +
    `and clear VITE_WHEREAS_DEMO_MODE.\n`;
  return {
    blob: new Blob([body], { type: "text/plain" }),
    filename,
    mimeType: "text/plain",
  };
}

export async function getAgreementTemplateMarkdown(
  id: string,
  options: ApiOptions = {},
): Promise<AgreementTemplateMarkdownSnapshot | null> {
  await delay(MOCK_LATENCY_MS, options.signal);
  return demoAgreementTemplateMarkdown[id] ?? null;
}

export async function listAgreementTemplateVariables(
  id: string,
  options: ApiOptions = {},
): Promise<AgreementTemplateVariable[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const rows = (demoAgreementTemplateVariables[id] ?? []).slice();
  rows.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
  return rows;
}

/**
 * Demo-mode counterpart for PR #96 placeholder detection. Mirrors the
 * backend's deterministic regex extractor closely enough for the
 * hosted demo: matches ``{{ identifier }}``, normalizes keys, dedupes
 * with occurrence counts, and filters out keys that already have an
 * ``AgreementTemplateVariable`` row.
 */
const _DEMO_PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export async function listAgreementTemplateVariableSuggestions(
  id: string,
  options: ApiOptions = {},
): Promise<TemplateVariableSuggestion[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const snapshot = demoAgreementTemplateMarkdown[id];
  if (!snapshot) return [];
  const existing = new Set(
    (demoAgreementTemplateVariables[id] ?? []).map((v) => v.key.toLowerCase()),
  );
  const counts = new Map<string, number>();
  for (const match of snapshot.markdown_text.matchAll(_DEMO_PLACEHOLDER_RE)) {
    const key = match[1].toLowerCase();
    if (existing.has(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const suggestions: TemplateVariableSuggestion[] = [];
  for (const [key, occurrences] of counts) {
    const label = key
      .split("_")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
    suggestions.push({ key, label, occurrences });
  }
  suggestions.sort((a, b) => {
    if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
    return a.key.localeCompare(b.key);
  });
  return suggestions;
}

export async function createAgreementTemplateVariable(
  id: string,
  payload: AgreementTemplateVariableCreateRequest,
  options: ApiOptions = {},
): Promise<AgreementTemplateVariable> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const existing = demoAgreementTemplateVariables[id] ?? [];
  if (existing.some((v) => v.key === payload.key)) {
    throw new ApiError(
      409,
      "A variable with this key already exists on the template.",
    );
  }
  const now = new Date().toISOString();
  const variable: AgreementTemplateVariable = {
    id: `demo-var-${Math.random().toString(36).slice(2)}`,
    template_id: id,
    key: payload.key,
    label: payload.label,
    variable_type: payload.variable_type,
    required: payload.required ?? false,
    default_value: payload.default_value ?? null,
    help_text: payload.help_text ?? null,
    sort_order: payload.sort_order ?? 0,
    metadata_json: payload.metadata_json ?? null,
    created_at: now,
    updated_at: now,
  };
  demoAgreementTemplateVariables[id] = [...existing, variable];
  return variable;
}

export async function updateAgreementTemplateVariable(
  templateId: string,
  variableId: string,
  payload: AgreementTemplateVariableUpdateRequest,
  options: ApiOptions = {},
): Promise<AgreementTemplateVariable> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const list = demoAgreementTemplateVariables[templateId] ?? [];
  const idx = list.findIndex((v) => v.id === variableId);
  if (idx < 0) throw new ApiError(404, "Variable not found.");
  const current = list[idx];
  const updated: AgreementTemplateVariable = {
    ...current,
    ...payload,
    metadata_json:
      payload.metadata_json !== undefined ? payload.metadata_json : current.metadata_json,
    updated_at: new Date().toISOString(),
  };
  list[idx] = updated;
  demoAgreementTemplateVariables[templateId] = list;
  return updated;
}

export async function deleteAgreementTemplateVariable(
  templateId: string,
  variableId: string,
  options: ApiOptions = {},
): Promise<void> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const list = demoAgreementTemplateVariables[templateId] ?? [];
  demoAgreementTemplateVariables[templateId] = list.filter(
    (v) => v.id !== variableId,
  );
}

export async function generateAgreementFromTemplate(
  templateId: string,
  payload: AgreementGenerationRequest,
  options: ApiOptions = {},
): Promise<AgreementGenerationResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const template = _findTemplate(templateId);
  if (!template) throw new ApiError(404, "Agreement template not found.");

  // Mirror the backend's variable validation so the demo exercises the
  // same error states the real API surfaces.
  const variables = demoAgreementTemplateVariables[templateId] ?? [];
  const known = new Set(variables.map((v) => v.key));
  const provided = payload.variable_values ?? {};
  const unknown = Object.keys(provided).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new ApiError(400, `Unknown variable(s): ${unknown.join(", ")}.`);
  }
  for (const v of variables) {
    if (!v.required) continue;
    const raw = provided[v.key];
    if (
      raw === undefined ||
      raw === null ||
      (typeof raw === "string" && raw.trim() === "")
    ) {
      throw new ApiError(400, `Missing required variable: ${v.key}.`);
    }
  }
  // Existing demo artifacts include the original_upload only when an
  // operator has uploaded one; surface a clean precondition error if
  // nothing has been uploaded yet, mirroring the backend.
  const artifacts = demoAgreementTemplateArtifacts[templateId] ?? [];
  const hasOriginal = artifacts.some((a) => a.artifact_type === "original_upload");
  if (!hasOriginal) {
    throw new ApiError(
      409,
      "Upload an original DOCX template before generating an agreement.",
    );
  }

  const now = new Date().toISOString();
  const title = (payload.title ?? "").trim() || `${template.name} — generated`;
  const id = `demo-contract-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const variableValues: Record<string, unknown> = {};
  const usedKeys: string[] = [];
  for (const v of variables) {
    const raw = provided[v.key];
    if (raw === undefined || raw === null || raw === "") {
      variableValues[v.key] = "";
      continue;
    }
    variableValues[v.key] = raw;
    usedKeys.push(v.key);
  }
  return {
    contract: {
      id,
      title,
      status: "ready",
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      file_hash_sha256: id.padEnd(64, "0").slice(0, 64),
      page_count: null,
      created_at: now,
      updated_at: now,
    },
    artifact: {
      id: `demo-art-${Math.random().toString(36).slice(2)}`,
      contract_id: id,
      artifact_type: "generated_docx",
      storage_backend: "s3",
      filename: `${title.replace(/[^A-Za-z0-9._-]+/g, "_")}.docx`,
      mime_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      file_hash_sha256: null,
      size_bytes: 32_000,
      source: "template_generation",
      is_official: true,
      created_at: now,
      metadata_json: {
        template_id: templateId,
        template_name: template.name,
        // Mirror the backend's privacy stance: keep keys, drop values.
        // The values are already in the rendered DOCX.
        variable_keys: [...usedKeys].sort(),
        generated_at: now,
      },
    },
    markdown_snapshot: {
      id: `demo-md-${Math.random().toString(36).slice(2)}`,
      contract_id: id,
      markdown_text:
        `# ${title}\n\nDemo-mode generated agreement. Variables used:\n\n` +
        usedKeys.map((k) => `- **${k}**: ${variableValues[k]}`).join("\n"),
      source_kind: "generated",
      converter_name: "demo",
      converter_version: "0.0.1",
      conversion_status: "ready",
      conversion_warnings: null,
      created_at: now,
    },
    variables_used: usedKeys.sort(),
  };
}

// ---------------------------------------------------------------------------
// First-run setup (demo mode)
//
// The real backend exposes /api/setup/{status,dev} so a fresh deployment
// can bootstrap an organization + dev user. Demo mode reproduces the
// surface so the FirstRunSetupCard renders the same way it would
// against a real, never-set-up backend — and the user can click through
// to see the success card.
// ---------------------------------------------------------------------------

let demoSetupCompleted = false;
const DEMO_DEV_USER_ID = "00000000-0000-4000-8000-000000000001";

export async function getSetupStatus(
  options: ApiOptions = {},
): Promise<SetupStatus> {
  await delay(MOCK_LATENCY_MS, options.signal);
  if (demoSetupCompleted) {
    return {
      setup_required: false,
      organization_count: 1,
      user_count: 1,
      dev_mode_enabled: true,
      message: "Demo workspace already initialized.",
    };
  }
  return {
    setup_required: true,
    organization_count: 0,
    user_count: 0,
    dev_mode_enabled: true,
    message:
      "Demo workspace. Setup is simulated — nothing leaves the browser.",
  };
}

export async function createDevSetup(
  payload: CreateDevSetupRequest = {},
  options: ApiOptions = {},
): Promise<CreateDevSetupResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  demoSetupCompleted = true;
  return {
    organization_id: DEMO_ORG_ID,
    user_id: DEMO_DEV_USER_ID,
    dev_user_id: DEMO_DEV_USER_ID,
    organization_name: payload.organization_name?.trim() || "Demo Workspace",
    user_email: payload.user_email?.trim() || "demo@whereas.local",
    message:
      "Demo workspace created. This is a simulated bootstrap — no real " +
      "data was stored.",
  };
}

// ---------------------------------------------------------------------------
// Playbook authoring (demo mode)
//
// The real app exposes validate/create/deactivate over /api/playbooks.
// Demo mode runs a tiny structural validator over the YAML so the
// authoring surface is exercised without shipping a full YAML parser
// in the demo bundle. Created playbooks live in module-scoped memory
// and are merged into the playbook list returned by `getPlaybooks`.
// ---------------------------------------------------------------------------

const sessionPlaybookList: PlaybookSummary[] = [];
const sessionPlaybookDetailById: Record<string, PlaybookDetail> = {};

const NAME_RE = /^name\s*:\s*(.+?)\s*$/m;
const DESCRIPTION_RE = /^description\s*:\s*(.+?)\s*$/m;
const VERSION_RE = /^version\s*:\s*['"]?([\w.-]+)['"]?\s*$/m;
const JURISDICTION_RE = /^jurisdiction\s*:\s*(.+?)\s*$/m;
const CONTRACT_TYPE_RE = /^contract_type\s*:\s*(.+?)\s*$/m;

function _stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function _parsePlaybookYaml(yamlSource: string): {
  name: string;
  description: string | null;
  version: string;
  jurisdiction: string | null;
  contract_type: string | null;
  rules: PlaybookRuleSummary[];
} | null {
  // The demo doesn't ship a YAML parser. We surface the most-common
  // top-level fields with regex so the authoring flow renders something
  // believable. Returns null when the document doesn't look like a
  // playbook (no name, no rules block).
  const nameMatch = NAME_RE.exec(yamlSource);
  if (!nameMatch) return null;
  const name = _stripQuotes(nameMatch[1]);
  const description = DESCRIPTION_RE.exec(yamlSource)?.[1];
  const version = VERSION_RE.exec(yamlSource)?.[1] ?? "1.0";
  const jurisdiction = JURISDICTION_RE.exec(yamlSource)?.[1];
  const contractType = CONTRACT_TYPE_RE.exec(yamlSource)?.[1];
  // Each rule is identified by an `- id:` line. We then look forward for
  // a `title:` and `severity:` to fill out the row.
  const rules: PlaybookRuleSummary[] = [];
  const ruleRe = /-\s*id\s*:\s*([\w.-]+)\s*\n([\s\S]*?)(?=\n\s*-\s*id\s*:|\Z)/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(yamlSource)) !== null) {
    const ruleId = match[1].trim();
    const body = match[2];
    const title = /title\s*:\s*(.+?)\s*$/m.exec(body)?.[1] ?? ruleId;
    const ruleType =
      /rule_type\s*:\s*(.+?)\s*$/m.exec(body)?.[1] ?? "required_clause";
    const clauseType =
      /clause_type\s*:\s*(.+?)\s*$/m.exec(body)?.[1] ?? "general";
    const severity =
      /severity\s*:\s*(.+?)\s*$/m.exec(body)?.[1] ?? "medium";
    rules.push({
      id: ruleId,
      title: _stripQuotes(title),
      rule_type: _stripQuotes(ruleType),
      clause_type: _stripQuotes(clauseType),
      severity: _stripQuotes(severity),
    });
  }
  if (rules.length === 0) return null;
  return {
    name,
    description: description ? _stripQuotes(description) : null,
    version,
    jurisdiction: jurisdiction ? _stripQuotes(jurisdiction) : null,
    contract_type: contractType ? _stripQuotes(contractType) : null,
    rules,
  };
}

export async function validatePlaybook(
  yamlSource: string,
  options: ApiOptions = {},
): Promise<PlaybookValidateResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const parsed = _parsePlaybookYaml(yamlSource);
  if (!parsed) {
    throw new ApiError(
      400,
      "Demo validator: YAML must define `name:` and at least one `- id:` rule.",
    );
  }
  return {
    ok: true,
    schema_version: "demo",
    name: parsed.name,
    description: parsed.description,
    jurisdiction: parsed.jurisdiction,
    contract_type: parsed.contract_type,
    version: parsed.version,
    rule_count: parsed.rules.length,
    rules: parsed.rules,
  };
}

export async function createPlaybook(
  yamlSource: string,
  options: ApiOptions = {},
): Promise<PlaybookDetail> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const parsed = _parsePlaybookYaml(yamlSource);
  if (!parsed) {
    throw new ApiError(
      400,
      "Demo validator: YAML must define `name:` and at least one `- id:` rule.",
    );
  }
  const now = new Date().toISOString();
  const id = `demo-playbook-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const detail: PlaybookDetail = {
    id,
    name: parsed.name,
    description: parsed.description,
    jurisdiction: parsed.jurisdiction,
    contract_type: parsed.contract_type,
    version: parsed.version,
    is_active: true,
    rule_count: parsed.rules.length,
    created_at: now,
    updated_at: now,
    yaml_source: yamlSource,
    parsed_rules: { rules: parsed.rules },
    rules: parsed.rules,
  };
  sessionPlaybookDetailById[id] = detail;
  sessionPlaybookList.unshift({
    id: detail.id,
    name: detail.name,
    description: detail.description,
    jurisdiction: detail.jurisdiction,
    contract_type: detail.contract_type,
    version: detail.version,
    is_active: detail.is_active,
    rule_count: detail.rule_count,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  });
  return detail;
}

// Tracks deactivations layered over the canned MOCK_PLAYBOOK_LIST so
// the demo can flip an active sample playbook to "deactivated" the same
// way a real backend would.
const cannedDeactivations = new Set<string>();

export async function deactivatePlaybook(
  id: string,
  options: ApiOptions = {},
): Promise<PlaybookSummary> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const sessionDetail = sessionPlaybookDetailById[id];
  if (sessionDetail) {
    sessionDetail.is_active = false;
    sessionDetail.updated_at = new Date().toISOString();
    const idx = sessionPlaybookList.findIndex((p) => p.id === id);
    if (idx >= 0) {
      sessionPlaybookList[idx] = {
        ...sessionPlaybookList[idx],
        is_active: false,
        updated_at: sessionDetail.updated_at,
      };
    }
    return { ...sessionPlaybookList[idx] };
  }
  const canned = MOCK_PLAYBOOK_LIST.find((p) => p.id === id);
  if (!canned) {
    throw new ApiError(404, "Playbook not found.");
  }
  cannedDeactivations.add(id);
  return {
    ...canned,
    is_active: false,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Contract requests + inbox items (PR #47)
//
// Session-scoped mock state. Refresh wipes it. The seeded MOCK_REQUESTS
// and MOCK_INBOX_ITEMS provide a few items so empty/filter behavior can
// be exercised; user-created rows are pushed onto the front of the
// session arrays.
// ---------------------------------------------------------------------------

const sessionRequests: ContractRequest[] = [];
const sessionInboxItems: InboxItem[] = [];

function combinedRequests(): ContractRequest[] {
  return [...sessionRequests, ...MOCK_REQUESTS];
}

function combinedInboxItems(): InboxItem[] {
  return [...sessionInboxItems, ...MOCK_INBOX_ITEMS];
}

function nextId(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function applyRequestFilters(
  rows: ContractRequest[],
  filters: ListContractRequestFilters,
): ContractRequest[] {
  return rows.filter((row) => {
    if (!filters.include_cancelled && row.status === "cancelled") return false;
    if (filters.status && row.status !== filters.status) return false;
    if (filters.request_type && row.request_type !== filters.request_type)
      return false;
    if (filters.contract_type && row.contract_type !== filters.contract_type)
      return false;
    if (filters.priority && row.priority !== filters.priority) return false;
    if (filters.assigned_to && row.assigned_to !== filters.assigned_to)
      return false;
    if (filters.due_before && (!row.due_date || row.due_date > filters.due_before))
      return false;
    if (filters.due_after && (!row.due_date || row.due_date < filters.due_after))
      return false;
    return true;
  });
}

function applyInboxFilters(
  rows: InboxItem[],
  filters: ListInboxItemFilters,
): InboxItem[] {
  return rows.filter((row) => {
    if (!filters.include_dismissed && row.status === "dismissed") return false;
    if (filters.status && row.status !== filters.status) return false;
    if (filters.item_type && row.item_type !== filters.item_type) return false;
    if (filters.priority && row.priority !== filters.priority) return false;
    if (filters.assigned_to && row.assigned_to !== filters.assigned_to)
      return false;
    if (filters.due_before && (!row.due_date || row.due_date > filters.due_before))
      return false;
    if (filters.due_after && (!row.due_date || row.due_date < filters.due_after))
      return false;
    return true;
  });
}

export async function listRequests(
  filters: ListContractRequestFilters = {},
  options: ApiOptions = {},
): Promise<ContractRequest[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  return applyRequestFilters(combinedRequests(), filters);
}

export async function getRequest(
  id: string,
  options: ApiOptions = {},
): Promise<ContractRequest> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = combinedRequests().find((r) => r.id === id);
  if (!row) throw new ApiError(404, "Contract request not found.");
  return row;
}

export async function createRequest(
  payload: ContractRequestCreateRequest,
  options: ApiOptions = {},
): Promise<ContractRequest> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const now = isoNow();
  const row: ContractRequest = {
    id: nextId("req"),
    organization_id: MOCK_DEMO_ORG_ID,
    title: payload.title,
    description: payload.description ?? null,
    request_type: payload.request_type ?? null,
    contract_type: payload.contract_type ?? null,
    status: "open",
    priority: payload.priority ?? null,
    requester_name: payload.requester_name ?? null,
    requester_email: payload.requester_email ?? null,
    counterparty_name: payload.counterparty_name ?? null,
    due_date: payload.due_date ?? null,
    assigned_to: payload.assigned_to ?? null,
    linked_contract_id: payload.linked_contract_id ?? null,
    linked_template_id: payload.linked_template_id ?? null,
    created_at: now,
    updated_at: now,
    created_by: null,
    metadata_json: payload.metadata_json ?? null,
  };
  sessionRequests.unshift(row);

  // Mirror the backend transactional behavior: every new request gets
  // a request_review inbox item.
  const inbox: InboxItem = {
    id: nextId("inbox"),
    organization_id: MOCK_DEMO_ORG_ID,
    title: `Review request: ${row.title}`,
    description: null,
    item_type: "request_review",
    status: "open",
    priority: row.priority,
    assigned_to: row.assigned_to,
    due_date: row.due_date,
    request_id: row.id,
    contract_id: null,
    template_id: null,
    created_at: now,
    updated_at: now,
    created_by: null,
    metadata_json: null,
  };
  sessionInboxItems.unshift(inbox);

  return row;
}

function findSessionRequest(id: string): ContractRequest | undefined {
  return sessionRequests.find((r) => r.id === id);
}

function resolveSessionInboxItemsForRequest(
  requestId: string,
  newStatus: "completed" | "dismissed",
): void {
  for (const item of sessionInboxItems) {
    if (
      item.request_id === requestId &&
      item.item_type === "request_review" &&
      item.status === "open"
    ) {
      item.status = newStatus;
      item.updated_at = isoNow();
    }
  }
}

export async function updateRequest(
  id: string,
  payload: ContractRequestUpdateRequest,
  options: ApiOptions = {},
): Promise<ContractRequest> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = findSessionRequest(id);
  if (!row) throw new ApiError(404, "Contract request not found.");
  Object.assign(row, payload, { updated_at: isoNow() });
  if (payload.status === "completed") {
    resolveSessionInboxItemsForRequest(id, "completed");
  } else if (payload.status === "cancelled") {
    resolveSessionInboxItemsForRequest(id, "dismissed");
  }
  return row;
}

export async function cancelRequest(
  id: string,
  options: ApiOptions = {},
): Promise<void> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = findSessionRequest(id);
  if (!row) throw new ApiError(404, "Contract request not found.");
  row.status = "cancelled";
  row.updated_at = isoNow();
  resolveSessionInboxItemsForRequest(id, "dismissed");
}

export async function convertRequestToContract(
  id: string,
  payload: ConvertRequestToContractRequest,
  options: ApiOptions = {},
): Promise<ConvertRequestToContractResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = findSessionRequest(id) ??
    MOCK_REQUESTS.find((r) => r.id === id);
  if (!row) throw new ApiError(404, "Contract request not found.");
  if (row.status === "cancelled") {
    throw new ApiError(
      409,
      "Cancelled requests cannot be converted to a contract.",
    );
  }
  if (row.linked_contract_id) {
    throw new ApiError(409, "This request is already linked to a contract.");
  }
  if (!row.linked_template_id) {
    throw new ApiError(
      409,
      "Link an agreement template to this request before converting.",
    );
  }

  // Reuse the existing generation mock so variable validation / 409
  // for missing original / etc. all surface here too. Defensive:
  // reach for the writable session row first so subsequent listRequests
  // calls see the new state.
  const generation = await generateAgreementFromTemplate(
    row.linked_template_id,
    {
      title: payload.title,
      variable_values: payload.variable_values,
    },
    options,
  );
  const writable =
    findSessionRequest(id) ??
    (() => {
      // Promote the canned MOCK_REQUESTS row into session memory so the
      // mutation is picked up by combinedRequests() / future calls.
      const cloned = { ...row };
      sessionRequests.unshift(cloned);
      return cloned;
    })();
  writable.linked_contract_id = generation.contract.id;
  writable.linked_template_id = row.linked_template_id;
  writable.status = "completed";
  writable.updated_at = isoNow();
  resolveSessionInboxItemsForRequest(id, "completed");

  return {
    request: { ...writable },
    contract: generation.contract,
    artifact: generation.artifact,
    markdown_snapshot: generation.markdown_snapshot,
    variables_used: generation.variables_used,
  };
}

/**
 * Demo-mode counterpart for ``POST /api/requests/{id}/convert-upload``
 * (PR #65). Creates a fake Repository contract row + ``original_upload``
 * artifact, links the request, and resolves the inbox item — the same
 * state transitions the backend route does, minus actual storage.
 *
 * The fake artifact's ``metadata_json`` matches the real backend
 * shape so frontend tests can assert on ``request_id`` /
 * ``upload_source`` without diverging from production. No storage
 * internals (``storage_key`` / ``wrapped_dek``) appear anywhere on
 * the response.
 */
export async function convertRequestWithUpload(
  id: string,
  input: ConvertRequestUploadInput,
): Promise<ConvertRequestUploadResponse> {
  await delay(MOCK_LATENCY_MS, input.signal);
  const row = findSessionRequest(id) ??
    MOCK_REQUESTS.find((r) => r.id === id);
  if (!row) throw new ApiError(404, "Contract request not found.");
  if (row.status === "cancelled") {
    throw new ApiError(
      409,
      "Cancelled requests cannot be converted to a contract.",
    );
  }
  if (row.linked_contract_id) {
    throw new ApiError(409, "This request is already linked to a contract.");
  }
  if (!input.file || input.file.size === 0) {
    throw new ApiError(400, "Uploaded file is empty.");
  }

  const now = isoNow();
  const contractId = `req-upload-contract-${id}-${Date.now()}`;
  const artifactId = `req-upload-artifact-${id}-${Date.now()}`;
  const trimmedTitle = (input.title ?? "").trim();
  const trimmedCounterparty = (input.counterparty_name ?? "").trim();
  const trimmedType = (input.contract_type ?? "").trim();
  const trimmedNotes = (input.notes ?? "").trim();
  const filename = input.file.name || "uploaded.pdf";
  const mimeType = input.file.type || "application/pdf";
  const sizeBytes = input.file.size;

  const metadata: Record<string, unknown> = {
    request_id: id,
    upload_source: "request_conversion",
  };
  if (trimmedCounterparty) metadata.counterparty_name = trimmedCounterparty;
  if (trimmedType) metadata.contract_type = trimmedType;
  if (trimmedNotes) metadata.notes = trimmedNotes;

  // PR #66 — demo upload-intake feedback for the convert-upload mock.
  const intake = buildDemoIntake(filename, trimmedTitle, sessionList);
  const finalTitle =
    trimmedTitle ||
    intake.extracted_metadata.suggested_title ||
    filename.replace(/\.[^.]+$/, "") ||
    "Untitled contract";
  const response: ConvertRequestUploadResponse = {
    request: { ...row },
    contract: {
      id: contractId,
      title: finalTitle,
      status: "ready",
      mime_type: mimeType,
      file_hash_sha256: "0".repeat(64),
      page_count: null,
      created_at: now,
      updated_at: now,
    },
    artifact: {
      id: artifactId,
      contract_id: contractId,
      artifact_type: "original_upload",
      storage_backend: "s3",
      filename,
      mime_type: mimeType,
      file_hash_sha256: "0".repeat(64),
      size_bytes: sizeBytes,
      source: "request_upload",
      is_official: true,
      created_at: now,
      metadata_json: metadata,
    },
    markdown_snapshot: null,
    extracted_metadata: intake.extracted_metadata,
    duplicate_candidates: intake.duplicate_candidates,
  };

  // Mutate session state the same way the template-conversion mock
  // does so subsequent listRequests() calls reflect the new linked
  // contract and the request_review inbox item is resolved.
  const writable =
    findSessionRequest(id) ??
    (() => {
      const cloned = { ...row };
      sessionRequests.unshift(cloned);
      return cloned;
    })();
  writable.linked_contract_id = contractId;
  writable.status = "completed";
  writable.updated_at = now;
  sessionList.unshift(response.contract);
  resolveSessionInboxItemsForRequest(id, "completed");

  response.request = { ...writable };
  return response;
}

/**
 * Demo-mode counterpart for ``GET /api/requests/{id}/approval-status``.
 *
 * Mirrors the backend visibility surface: stitch matching policies,
 * attached workflow runs, and a gate-aligned summary. Reuses
 * ``sessionApprovalRuns`` and ``sessionApprovalPolicies`` so the UI sees
 * the same state the rest of the demo just mutated (creating/approving/
 * cancelling workflows, archiving policies). When no contract is linked,
 * ``ready_for_signature`` is null because the gate doesn't run.
 */
export async function getRequestApprovalStatus(
  id: string,
  options: ApiOptions = {},
): Promise<RequestApprovalStatus> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const request =
    findSessionRequest(id) ?? MOCK_REQUESTS.find((r) => r.id === id);
  if (!request) throw new ApiError(404, "Contract request not found.");

  const matchingPolicies = sessionApprovalPolicies
    .filter((p) => p.status === "active")
    .filter(
      (p) =>
        (p.request_type == null || p.request_type === request.request_type) &&
        (p.contract_type == null || p.contract_type === request.contract_type) &&
        (p.priority == null || p.priority === request.priority) &&
        (p.agreement_template_id == null ||
          p.agreement_template_id === request.linked_template_id),
    );

  const workflowRuns = sessionApprovalRuns.filter(
    (run) =>
      run.request_id === request.id ||
      (request.linked_contract_id != null &&
        run.contract_id === request.linked_contract_id),
  );

  const policySummaries: RequestApprovalPolicySummary[] = matchingPolicies.map(
    (p) => ({
      id: p.id,
      name: p.name,
      workflow_template_id: p.workflow_template_id,
      auto_attach: p.auto_attach,
      applies_to_generated_contracts: p.applies_to_generated_contracts,
      request_type: p.request_type,
      contract_type: p.contract_type,
      priority: p.priority,
      agreement_template_id: p.agreement_template_id,
    }),
  );

  const workflowSummaries: RequestApprovalWorkflowSummary[] = workflowRuns.map(
    (run) => {
      const meta = (run.metadata_json ?? {}) as Record<string, unknown>;
      const sourceId = typeof meta.source_approval_policy_id === "string"
        ? (meta.source_approval_policy_id as string)
        : null;
      const sourceName = typeof meta.source_approval_policy_name === "string"
        ? (meta.source_approval_policy_name as string)
        : null;
      return {
        id: run.id,
        name: run.name,
        status: run.status,
        current_step_order: run.current_step_order,
        started_at: run.started_at,
        completed_at: run.completed_at,
        source_approval_policy_id: sourceId,
        source_approval_policy_name: sourceName,
        steps: run.steps.map((s) => ({
          id: s.id,
          step_order: s.step_order,
          title: s.title,
          status: s.status,
          assigned_to: s.assigned_to,
          approver_name: s.approver_name,
          approver_email: s.approver_email,
          due_date: s.due_date,
          decided_at: s.decided_at,
        })),
      };
    },
  );

  const hasRequiredPolicies = matchingPolicies.some(
    (p) => p.applies_to_generated_contracts,
  );
  const statuses = workflowRuns.map((w) => w.status);
  const hasActive = statuses.includes("active");
  const hasRejected = statuses.includes("rejected");
  const hasCompleted = statuses.includes("completed");

  const completedPolicyIds = new Set(
    workflowRuns
      .filter((w) => w.status === "completed")
      .map((w) => {
        const meta = (w.metadata_json ?? {}) as Record<string, unknown>;
        return typeof meta.source_approval_policy_id === "string"
          ? (meta.source_approval_policy_id as string)
          : null;
      })
      .filter((x): x is string => x != null),
  );
  const requiredPolicyIds = matchingPolicies
    .filter((p) => p.applies_to_generated_contracts)
    .map((p) => p.id);
  const allRequiredCompleted = requiredPolicyIds.every((pid) =>
    completedPolicyIds.has(pid),
  );

  let readyForSignature: boolean | null = null;
  let blockingReason: string | null = null;
  if (request.linked_contract_id != null) {
    if (hasActive) {
      readyForSignature = false;
      blockingReason = "active_approval_workflows";
    } else if (hasRejected) {
      readyForSignature = false;
      blockingReason = "rejected_approval_workflows";
    } else if (requiredPolicyIds.length && !allRequiredCompleted) {
      readyForSignature = false;
      blockingReason = "required_approval_policy_unmet";
    } else if (hasCompleted) {
      readyForSignature = true;
    } else if (workflowRuns.length === 0 && requiredPolicyIds.length === 0) {
      readyForSignature = true;
    } else {
      // Cancelled-only or other terminal-without-completed states map
      // back to the gate's cancelled_without_completed_approval code.
      readyForSignature = false;
      blockingReason = "cancelled_without_completed_approval";
    }
  } else {
    if (hasActive) blockingReason = "active_approval_workflows";
    else if (hasRejected) blockingReason = "rejected_approval_workflows";
    else if (requiredPolicyIds.length && !allRequiredCompleted) {
      blockingReason = "required_approval_policy_unmet";
    }
  }

  const reasonText = blockingReason
    ? GATE_REASON_TEXT[blockingReason] ?? null
    : null;

  return {
    request_id: request.id,
    linked_contract_id: request.linked_contract_id,
    matching_policy_ids: matchingPolicies.map((p) => p.id),
    matching_policies: policySummaries,
    workflow_runs: workflowSummaries,
    summary: {
      has_required_policies: hasRequiredPolicies,
      has_active_workflows: hasActive,
      has_rejected_workflows: hasRejected,
      has_completed_workflows: hasCompleted,
      all_required_policy_workflows_completed: allRequiredCompleted,
      ready_for_signature: readyForSignature,
      blocking_reason: blockingReason,
      blocking_reason_text: reasonText,
    },
  };
}

const GATE_REASON_TEXT: Record<string, string> = {
  active_approval_workflows:
    "An approval workflow is still active and waiting on a decision.",
  rejected_approval_workflows:
    "An approval workflow was rejected; resolve or restart before sending.",
  required_approval_policy_unmet:
    "A required approval policy has not been satisfied.",
  cancelled_without_completed_approval:
    "All attached approval workflows were cancelled without a completed approval.",
};

// ---------------------------------------------------------------------------
// Activity timeline (PR #58 — demo mode)
//
// Mirrors the backend projection: derives chronological items from
// ``sessionApprovalRuns`` (workflow_created, step_activated,
// step_approved/rejected, workflow_completed/rejected/cancelled) plus
// canned DocuSeal events for the demo NDA contract. No storage
// internals are ever materialized; the projection only emits scalar
// identifier fields and a server-shape title/description.
// ---------------------------------------------------------------------------

function _activityTitle(event_type: string, ctx: {
  workflowName?: string | null;
  stepTitle?: string | null;
  source?: string | null;
  policyName?: string | null;
}): string {
  const wf = ctx.workflowName ?? "workflow";
  const step = ctx.stepTitle ?? "step";
  switch (event_type) {
    case "approval.workflow.created": {
      let suffix = "";
      if (ctx.source === "policy") {
        suffix = ctx.policyName ? ` from policy ${ctx.policyName}` : " from policy";
      } else if (ctx.source === "template") {
        suffix = " from template";
      }
      return `Approval workflow created${suffix}: ${wf}`;
    }
    case "approval.step.activated":
      return `Step activated: ${step}`;
    case "approval.step.approved":
      return `Step approved: ${step}`;
    case "approval.step.rejected":
      return `Step rejected: ${step}`;
    case "approval.workflow.completed":
      return `Approval workflow completed: ${wf}`;
    case "approval.workflow.rejected":
      return `Approval workflow rejected: ${wf}`;
    case "approval.workflow.cancelled":
      return `Approval workflow cancelled: ${wf}`;
    case "contract.sent_for_signature":
      return "Sent to DocuSeal for signature";
    case "contract.executed":
      return "Signed contract received from DocuSeal";
    default:
      return event_type;
  }
}

function _stepDescription(event_type: string, step_order: number | null): string | null {
  if (
    step_order != null &&
    (event_type === "approval.step.activated" ||
      event_type === "approval.step.approved" ||
      event_type === "approval.step.rejected")
  ) {
    return `Step ${step_order}`;
  }
  return null;
}

function _eventsForRun(run: ApprovalWorkflowRun): {
  event_type: string;
  occurred_at: string;
  step_order: number | null;
  step_id: string | null;
  step_title: string | null;
}[] {
  // Synthesize the ordered timeline a real backend would have written.
  // Only deterministic state is consulted: run.created_at for "created"
  // and step.decided_at / step.created_at for the per-step events.
  const out: {
    event_type: string;
    occurred_at: string;
    step_order: number | null;
    step_id: string | null;
    step_title: string | null;
  }[] = [];
  out.push({
    event_type: "approval.workflow.created",
    occurred_at: run.created_at,
    step_order: null,
    step_id: null,
    step_title: null,
  });
  // First step always activates at create time; later steps activate
  // as the prior step's decided_at fires.
  const sortedSteps = [...run.steps].sort((a, b) => a.step_order - b.step_order);
  for (const step of sortedSteps) {
    if (step.step_order === 1) {
      out.push({
        event_type: "approval.step.activated",
        occurred_at: run.created_at,
        step_order: step.step_order,
        step_id: step.id,
        step_title: step.title,
      });
    } else {
      const prev = sortedSteps.find((s) => s.step_order === step.step_order - 1);
      if (prev?.decided_at && prev.status === "approved") {
        out.push({
          event_type: "approval.step.activated",
          occurred_at: prev.decided_at,
          step_order: step.step_order,
          step_id: step.id,
          step_title: step.title,
        });
      }
    }
    if (step.status === "approved" && step.decided_at) {
      out.push({
        event_type: "approval.step.approved",
        occurred_at: step.decided_at,
        step_order: step.step_order,
        step_id: step.id,
        step_title: step.title,
      });
    }
    if (step.status === "rejected" && step.decided_at) {
      out.push({
        event_type: "approval.step.rejected",
        occurred_at: step.decided_at,
        step_order: step.step_order,
        step_id: step.id,
        step_title: step.title,
      });
    }
  }
  if (run.status === "completed" && run.completed_at) {
    out.push({
      event_type: "approval.workflow.completed",
      occurred_at: run.completed_at,
      step_order: null,
      step_id: null,
      step_title: null,
    });
  } else if (run.status === "rejected" && run.completed_at) {
    out.push({
      event_type: "approval.workflow.rejected",
      occurred_at: run.completed_at,
      step_order: null,
      step_id: null,
      step_title: null,
    });
  } else if (run.status === "cancelled" && run.completed_at) {
    out.push({
      event_type: "approval.workflow.cancelled",
      occurred_at: run.completed_at,
      step_order: null,
      step_id: null,
      step_title: null,
    });
  }
  return out;
}

function _projectRunEvents(run: ApprovalWorkflowRun): import("../types/activity").ActivityTimelineItem[] {
  const meta = (run.metadata_json ?? {}) as Record<string, unknown>;
  const source =
    typeof meta.source_approval_policy_id === "string"
      ? "policy"
      : typeof meta.source_workflow_template_id === "string"
        ? "template"
        : "ad_hoc";
  const policyName =
    typeof meta.source_approval_policy_name === "string"
      ? (meta.source_approval_policy_name as string)
      : null;
  return _eventsForRun(run).map((ev, idx) => ({
    id: `${run.id}-act-${idx}`,
    event_type: ev.event_type,
    occurred_at: ev.occurred_at,
    actor_user_id: null,
    title: _activityTitle(ev.event_type, {
      workflowName: run.name,
      stepTitle: ev.step_title,
      source,
      policyName,
    }),
    description: _stepDescription(ev.event_type, ev.step_order),
    request_id: run.request_id,
    contract_id: run.contract_id,
    workflow_run_id: run.id,
    approval_step_id: ev.step_id,
    step_order: ev.step_order,
    source,
  }));
}

function _docusealEventsForContract(
  contractId: string,
): import("../types/activity").ActivityTimelineItem[] {
  // Only the seeded NDA contract has a canned signature timeline in the
  // demo. Real uploaded contracts have no DocuSeal events until the
  // user actually sends/receives them.
  if (contractId !== "11111111-1111-4111-8111-111111111111") return [];
  return [
    {
      id: "docuseal-sent-1",
      event_type: "contract.sent_for_signature",
      occurred_at: "2026-05-08T16:30:00Z",
      actor_user_id: null,
      title: "Sent to DocuSeal for signature",
      description: null,
      request_id: null,
      contract_id: contractId,
      workflow_run_id: null,
      approval_step_id: null,
      step_order: null,
      source: null,
    },
  ];
}

export async function getRequestActivity(
  id: string,
  options: ApiOptions & { limit?: number } = {},
): Promise<import("../types/activity").ActivityTimelineResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const request =
    findSessionRequest(id) ?? MOCK_REQUESTS.find((r) => r.id === id);
  if (!request) throw new ApiError(404, "Contract request not found.");

  const linkedContractId = request.linked_contract_id;
  const runs = sessionApprovalRuns.filter(
    (r) =>
      r.request_id === request.id ||
      (linkedContractId != null && r.contract_id === linkedContractId),
  );
  let items = runs.flatMap(_projectRunEvents);
  if (linkedContractId) {
    items = items.concat(_docusealEventsForContract(linkedContractId));
  }
  items.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  return { items: items.slice(0, limit) };
}

export async function getContractActivity(
  id: string,
  options: ApiOptions & { limit?: number } = {},
): Promise<import("../types/activity").ActivityTimelineResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const runs = sessionApprovalRuns.filter((r) => r.contract_id === id);
  let items = runs.flatMap(_projectRunEvents);
  items = items.concat(_docusealEventsForContract(id));
  items.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  return { items: items.slice(0, limit) };
}

/**
 * PR #75 — demo-mode CSV/JSON activity export.
 *
 * Mirrors the real client's surface but never calls the network.
 * Builds a sanitized blob from the same in-memory timeline used by
 * the live demo UI, so the only fields surfaced are the timeline
 * projection's allowlisted keys. No storage internals, no raw
 * audit details, no DocuSeal payloads, no document bytes.
 */
export async function exportContractActivity(
  contractId: string,
  format: "csv" | "json",
  options: ApiOptions = {},
): Promise<DownloadResult> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const { items } = await getContractActivity(contractId, {
    ...options,
    limit: 1000,
  });
  return _buildExportBlob({
    subject_type: "contract",
    subject_id: contractId,
    items,
    format,
  });
}

export async function exportRequestActivity(
  requestId: string,
  format: "csv" | "json",
  options: ApiOptions = {},
): Promise<DownloadResult> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const { items } = await getRequestActivity(requestId, {
    ...options,
    limit: 1000,
  });
  return _buildExportBlob({
    subject_type: "request",
    subject_id: requestId,
    items,
    format,
  });
}

// ---------------------------------------------------------------------------
// PR #76 — duplicate-merge demo behavior
//
// The mock holds a set of merged source ids so a refreshed list /
// detail mirrors the post-merge state. We also remember which
// source merged into which target so the merged-detail surface
// can render the canonical pointer. Bytes / storage internals are
// not represented at all in demo mode — there is nothing to leak.
// ---------------------------------------------------------------------------

const sessionMergedSources = new Map<
  string,
  { target_contract_id: string; merged_at: string }
>();

export async function getContractDuplicateCandidates(
  contractId: string,
  options: ApiOptions = {},
): Promise<import("../types/duplicateMerge").DuplicateCandidatesResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const list = combinedList();
  const target = list.find((c) => c.id === contractId);
  if (!target) throw new ApiError(404, "Contract not found.");
  const candidates: import("../types/contractIntake").DuplicateContractCandidate[] =
    list
      .filter(
        (c) =>
          c.id !== contractId &&
          !sessionMergedSources.has(c.id) &&
          c.file_hash_sha256 === target.file_hash_sha256,
      )
      .slice(0, 5)
      .map((c) => ({
        contract_id: c.id,
        title: c.title,
        reason: "exact_file_hash",
        confidence: "exact",
        created_at: c.created_at,
        status: c.status,
      }));
  return { candidates };
}

export async function mergeDuplicateContract(
  targetContractId: string,
  sourceContractId: string,
  mergeNote: string | null,
  options: ApiOptions = {},
): Promise<import("../types/duplicateMerge").DuplicateMergeResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  if (sourceContractId === targetContractId) {
    throw new ApiError(
      400,
      "Source and target Repository records must differ.",
    );
  }
  if (sessionMergedSources.has(sourceContractId)) {
    throw new ApiError(
      409,
      "This Repository record has already been merged.",
    );
  }
  if (sessionMergedSources.has(targetContractId)) {
    throw new ApiError(
      409,
      "The target Repository record was itself merged into another record.",
    );
  }
  const list = combinedList();
  const target = list.find((c) => c.id === targetContractId);
  const source = list.find((c) => c.id === sourceContractId);
  if (!target || !source) {
    throw new ApiError(404, "Contract not found.");
  }
  const mergedAt = isoNow();
  sessionMergedSources.set(sourceContractId, {
    target_contract_id: targetContractId,
    merged_at: mergedAt,
  });
  // Mark the source contract as merged on the in-memory list, so a
  // subsequent ``getContracts()`` filter (when callers do that) and
  // ``getContract()`` detail call both reflect it.
  for (const row of [...sessionList, ...MOCK_LIST]) {
    if (row.id === sourceContractId) {
      row.merged_into_contract_id = targetContractId;
      row.merged_at = mergedAt;
    }
  }
  const sourceDetail = sessionDetailById[sourceContractId] ?? MOCK_DETAIL_BY_ID[sourceContractId];
  if (sourceDetail) {
    sourceDetail.merged_into_contract_id = targetContractId;
    sourceDetail.merged_at = mergedAt;
  }
  // The note text is intentionally ignored — demo mode mirrors the
  // backend's "presence boolean only" posture.
  void mergeNote;
  void options;
  return {
    target_contract_id: targetContractId,
    source_contract_id: sourceContractId,
    artifacts_moved: 1,
    merged_at: mergedAt,
    merged_by_user_id: "00000000-0000-0000-0000-000000000000",
    workflow_runs_attached_to_source: 0,
    requests_attached_to_source: 0,
  };
}

function _buildExportBlob(args: {
  subject_type: "contract" | "request";
  subject_id: string;
  items: import("../types/activity").ActivityTimelineItem[];
  format: "csv" | "json";
}): DownloadResult {
  const safeId = args.subject_id.replace(/[^A-Za-z0-9._-]+/g, "_");
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "Z");
  const filename = `whereas-${args.subject_type}-${safeId}-activity-${stamp}.${args.format}`;

  if (args.format === "csv") {
    const header = [
      "occurred_at",
      "event_type",
      "event_id",
      "actor_user_id",
      "title",
      "description",
      "contract_id",
      "request_id",
      "workflow_run_id",
      "approval_step_id",
      "step_order",
      "source",
    ];
    const rows = args.items.map((it) => [
      it.occurred_at,
      it.event_type,
      it.id,
      it.actor_user_id ?? "",
      it.title,
      it.description ?? "",
      it.contract_id ?? "",
      it.request_id ?? "",
      it.workflow_run_id ?? "",
      it.approval_step_id ?? "",
      it.step_order == null ? "" : String(it.step_order),
      it.source ?? "",
    ]);
    const body = [header, ...rows].map(_csvLine).join("\n");
    return {
      blob: new Blob([body], { type: "text/csv;charset=utf-8" }),
      filename,
      mimeType: "text/csv; charset=utf-8",
    };
  }

  const envelope = {
    export_type: "activity_timeline",
    generated_at: new Date().toISOString(),
    subject_type: args.subject_type,
    subject_id: args.subject_id,
    events: args.items,
  };
  return {
    blob: new Blob([JSON.stringify(envelope, null, 2)], {
      type: "application/json",
    }),
    filename,
    mimeType: "application/json",
  };
}

function _csvLine(cells: string[]): string {
  return cells
    .map((cell) => {
      const needsQuote = /[",\n\r]/.test(cell);
      const escaped = cell.replace(/"/g, '""');
      return needsQuote ? `"${escaped}"` : escaped;
    })
    .join(",");
}

export async function listInboxItems(
  filters: ListInboxItemFilters = {},
  options: ApiOptions = {},
): Promise<InboxItem[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  return applyInboxFilters(combinedInboxItems(), filters);
}

export async function getInboxItem(
  id: string,
  options: ApiOptions = {},
): Promise<InboxItem> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = combinedInboxItems().find((r) => r.id === id);
  if (!row) throw new ApiError(404, "Inbox item not found.");
  return row;
}

export async function createInboxItem(
  payload: InboxItemCreateRequest,
  options: ApiOptions = {},
): Promise<InboxItem> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const now = isoNow();
  const row: InboxItem = {
    id: nextId("inbox"),
    organization_id: MOCK_DEMO_ORG_ID,
    title: payload.title,
    description: payload.description ?? null,
    item_type: payload.item_type,
    status: "open",
    priority: payload.priority ?? null,
    assigned_to: payload.assigned_to ?? null,
    due_date: payload.due_date ?? null,
    request_id: payload.request_id ?? null,
    contract_id: payload.contract_id ?? null,
    template_id: payload.template_id ?? null,
    created_at: now,
    updated_at: now,
    created_by: null,
    metadata_json: payload.metadata_json ?? null,
  };
  sessionInboxItems.unshift(row);
  return row;
}

function findSessionInbox(id: string): InboxItem | undefined {
  return sessionInboxItems.find((r) => r.id === id);
}

export async function updateInboxItem(
  id: string,
  payload: InboxItemUpdateRequest,
  options: ApiOptions = {},
): Promise<InboxItem> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = findSessionInbox(id);
  if (!row) throw new ApiError(404, "Inbox item not found.");
  Object.assign(row, payload, { updated_at: isoNow() });
  return row;
}

export async function dismissInboxItem(
  id: string,
  options: ApiOptions = {},
): Promise<void> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = findSessionInbox(id);
  if (!row) throw new ApiError(404, "Inbox item not found.");
  row.status = "dismissed";
  row.updated_at = isoNow();
}

// ---------------------------------------------------------------------------
// Approval workflows (PR #50 — narrow approval foundation, demo mode)
//
// Mirrors the backend behavior closely enough for UI tests:
//  * creating a workflow seeds an approval inbox item for step 1 only
//  * approving the current step closes its inbox item and either opens
//    the next step's inbox item or completes the workflow
//  * rejecting the current step rejects the workflow and skips the rest
//  * cancelling dismisses any open approval inbox items and skips
//    pending steps
// No storage internals are ever materialized here.
// ---------------------------------------------------------------------------

const sessionApprovalRuns: ApprovalWorkflowRun[] = [];

/**
 * Hard-coded demo approval workflow fixtures so the dashboard's
 * approval analytics block has something to render in demo mode
 * without the user creating workflows by hand. Mirrors the shape the
 * real backend would emit; carries no storage internals.
 *
 * Seeded states cover:
 *   * one active workflow with two pending steps (one overdue, one
 *     not), assigned to two different demo users,
 *   * one completed workflow inside the 30-day window,
 *   * one rejected workflow inside the 30-day window,
 *   * one cancelled workflow.
 */
function _buildDemoApprovalRuns(): ApprovalWorkflowRun[] {
  const today = DEMO_TODAY;
  const minus = (days: number): string =>
    _addDays(today, days).toISOString().slice(0, 10);
  const minusTs = (days: number): string =>
    `${minus(days)}T12:00:00Z`;
  const orgId = MOCK_DEMO_ORG_ID;

  const runActive: ApprovalWorkflowRun = {
    id: "demo-run-active",
    organization_id: orgId,
    name: "NDA legal review",
    status: "active",
    request_id: "demo-request-1",
    contract_id: null,
    template_id: null,
    current_step_order: 1,
    started_at: minusTs(-3),
    completed_at: null,
    created_at: minusTs(-3),
    updated_at: minusTs(-3),
    created_by: null,
    metadata_json: null,
    steps: [
      {
        id: "demo-step-active-1",
        organization_id: orgId,
        workflow_run_id: "demo-run-active",
        step_order: 1,
        title: "Legal review",
        description: null,
        approver_name: "Alice Counsel",
        approver_email: null,
        assigned_to: "demo-user-alice",
        status: "pending",
        decision_note: null,
        decided_at: null,
        due_date: minus(-2),
        inbox_item_id: null,
        created_at: minusTs(-3),
        updated_at: minusTs(-3),
        metadata_json: null,
      },
      {
        id: "demo-step-active-2",
        organization_id: orgId,
        workflow_run_id: "demo-run-active",
        step_order: 2,
        title: "Finance approval",
        description: null,
        approver_name: "Bob Finance",
        approver_email: null,
        assigned_to: "demo-user-bob",
        status: "pending",
        decision_note: null,
        decided_at: null,
        due_date: minus(3),
        inbox_item_id: null,
        created_at: minusTs(-3),
        updated_at: minusTs(-3),
        metadata_json: null,
      },
    ],
  };

  const runCompleted: ApprovalWorkflowRun = {
    id: "demo-run-completed",
    organization_id: orgId,
    name: "MSA renewal",
    status: "completed",
    request_id: "demo-request-2",
    contract_id: null,
    template_id: null,
    current_step_order: null,
    started_at: minusTs(-10),
    completed_at: minusTs(-5),
    created_at: minusTs(-10),
    updated_at: minusTs(-5),
    created_by: null,
    metadata_json: null,
    steps: [],
  };

  const runRejected: ApprovalWorkflowRun = {
    id: "demo-run-rejected",
    organization_id: orgId,
    name: "Vendor SOW review",
    status: "rejected",
    request_id: "demo-request-3",
    contract_id: null,
    template_id: null,
    current_step_order: null,
    started_at: minusTs(-12),
    completed_at: minusTs(-7),
    created_at: minusTs(-12),
    updated_at: minusTs(-7),
    created_by: null,
    metadata_json: null,
    steps: [],
  };

  const runCancelled: ApprovalWorkflowRun = {
    id: "demo-run-cancelled",
    organization_id: orgId,
    name: "Internal pilot — cancelled",
    status: "cancelled",
    request_id: null,
    contract_id: null,
    template_id: null,
    current_step_order: null,
    started_at: minusTs(-20),
    completed_at: minusTs(-15),
    created_at: minusTs(-20),
    updated_at: minusTs(-15),
    created_by: null,
    metadata_json: null,
    steps: [],
  };

  return [runActive, runCompleted, runRejected, runCancelled];
}

function _toRunListItem(
  run: ApprovalWorkflowRun,
): ApprovalWorkflowRunListItem {
  return {
    id: run.id,
    organization_id: run.organization_id,
    name: run.name,
    status: run.status,
    request_id: run.request_id,
    contract_id: run.contract_id,
    template_id: run.template_id,
    current_step_order: run.current_step_order,
    started_at: run.started_at,
    completed_at: run.completed_at,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };
}

function _findRun(id: string): ApprovalWorkflowRun | undefined {
  return sessionApprovalRuns.find((r) => r.id === id);
}

function _emitApprovalInbox(run: ApprovalWorkflowRun, step: ApprovalStep): InboxItem {
  const now = isoNow();
  const item: InboxItem = {
    id: nextId("inbox"),
    organization_id: MOCK_DEMO_ORG_ID,
    title: `Approval needed: ${step.title}`,
    description: `Workflow: ${run.name}`,
    item_type: "approval",
    status: "open",
    priority: null,
    assigned_to: step.assigned_to,
    due_date: step.due_date,
    request_id: run.request_id,
    contract_id: run.contract_id,
    template_id: run.template_id,
    created_at: now,
    updated_at: now,
    created_by: null,
    metadata_json: {
      workflow_run_id: run.id,
      approval_step_id: step.id,
    },
  };
  sessionInboxItems.unshift(item);
  return item;
}

function _resolveApprovalInbox(
  inboxItemId: string | null,
  newStatus: "completed" | "dismissed",
): void {
  if (!inboxItemId) return;
  const item = sessionInboxItems.find((i) => i.id === inboxItemId);
  if (item && item.status === "open") {
    item.status = newStatus;
    item.updated_at = isoNow();
  }
}

export async function listApprovalWorkflows(
  filters: ListApprovalWorkflowFilters = {},
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRunListItem[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  return sessionApprovalRuns
    .filter((run) => {
      if (filters.status && run.status !== filters.status) return false;
      if (filters.include_terminal === false && run.status !== "active") {
        return false;
      }
      if (filters.request_id && run.request_id !== filters.request_id) {
        return false;
      }
      if (filters.contract_id && run.contract_id !== filters.contract_id) {
        return false;
      }
      return true;
    })
    .map(_toRunListItem);
}

export async function getApprovalWorkflow(
  id: string,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRun> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const run = _findRun(id);
  if (!run) throw new ApiError(404, "Approval workflow not found.");
  return run;
}

export async function createApprovalWorkflow(
  payload: ApprovalWorkflowRunCreateRequest,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRun> {
  await delay(MOCK_LATENCY_MS, options.signal);
  if (!payload.request_id && !payload.contract_id) {
    throw new ApiError(
      422,
      "At least one of request_id or contract_id is required.",
    );
  }
  if (!payload.steps || payload.steps.length === 0) {
    throw new ApiError(422, "At least one step is required.");
  }
  const now = isoNow();
  const runId = nextId("wf");
  const steps: ApprovalStep[] = payload.steps.map((step, index) => ({
    id: nextId("step"),
    organization_id: MOCK_DEMO_ORG_ID,
    workflow_run_id: runId,
    step_order: index + 1,
    title: step.title,
    description: step.description ?? null,
    approver_name: step.approver_name ?? null,
    approver_email: step.approver_email ?? null,
    assigned_to: step.assigned_to ?? null,
    status: "pending",
    decision_note: null,
    decided_at: null,
    due_date: step.due_date ?? null,
    inbox_item_id: null,
    created_at: now,
    updated_at: now,
    metadata_json: step.metadata_json ?? null,
  }));
  const run: ApprovalWorkflowRun = {
    id: runId,
    organization_id: MOCK_DEMO_ORG_ID,
    name: payload.name,
    status: "active",
    request_id: payload.request_id ?? null,
    contract_id: payload.contract_id ?? null,
    template_id: payload.template_id ?? null,
    current_step_order: 1,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
    created_by: null,
    metadata_json: payload.metadata_json ?? null,
    steps,
  };
  // Inbox item only for the first step.
  const inbox = _emitApprovalInbox(run, steps[0]);
  steps[0].inbox_item_id = inbox.id;
  sessionApprovalRuns.unshift(run);
  return run;
}

function _ensureDecidable(
  run: ApprovalWorkflowRun,
  step: ApprovalStep,
): void {
  if (run.status !== "active") {
    throw new ApiError(
      409,
      `Workflow is ${run.status}; no further decisions allowed.`,
    );
  }
  if (step.status !== "pending") {
    throw new ApiError(409, `Step is already ${step.status}.`);
  }
  if (
    run.current_step_order !== null &&
    step.step_order !== run.current_step_order
  ) {
    throw new ApiError(
      409,
      "Only the current pending step can be decided.",
    );
  }
}

export async function approveApprovalStep(
  workflowId: string,
  stepId: string,
  payload: ApprovalStepDecisionRequest = {},
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRun> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const run = _findRun(workflowId);
  if (!run) throw new ApiError(404, "Approval workflow not found.");
  const step = run.steps.find((s) => s.id === stepId);
  if (!step) throw new ApiError(404, "Approval step not found.");
  _ensureDecidable(run, step);

  const now = isoNow();
  step.status = "approved";
  step.decided_at = now;
  if (payload.decision_note != null) step.decision_note = payload.decision_note;
  step.updated_at = now;
  _resolveApprovalInbox(step.inbox_item_id, "completed");

  const next = run.steps.find(
    (s) => s.step_order > step.step_order && s.status === "pending",
  );
  if (next) {
    run.current_step_order = next.step_order;
    const inbox = _emitApprovalInbox(run, next);
    next.inbox_item_id = inbox.id;
  } else {
    run.status = "completed";
    run.completed_at = now;
    run.current_step_order = step.step_order;
  }
  run.updated_at = now;
  return run;
}

export async function rejectApprovalStep(
  workflowId: string,
  stepId: string,
  payload: ApprovalStepDecisionRequest = {},
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRun> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const run = _findRun(workflowId);
  if (!run) throw new ApiError(404, "Approval workflow not found.");
  const step = run.steps.find((s) => s.id === stepId);
  if (!step) throw new ApiError(404, "Approval step not found.");
  _ensureDecidable(run, step);

  const now = isoNow();
  step.status = "rejected";
  step.decided_at = now;
  if (payload.decision_note != null) step.decision_note = payload.decision_note;
  step.updated_at = now;
  _resolveApprovalInbox(step.inbox_item_id, "completed");

  for (const later of run.steps) {
    if (later.step_order > step.step_order && later.status === "pending") {
      later.status = "skipped";
      later.decided_at = now;
      later.updated_at = now;
      _resolveApprovalInbox(later.inbox_item_id, "dismissed");
    }
  }
  run.status = "rejected";
  run.completed_at = now;
  run.current_step_order = step.step_order;
  run.updated_at = now;
  return run;
}

export async function cancelApprovalWorkflow(
  workflowId: string,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowRun> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const run = _findRun(workflowId);
  if (!run) throw new ApiError(404, "Approval workflow not found.");
  if (run.status !== "active") {
    throw new ApiError(
      409,
      `Workflow is already ${run.status}; cannot cancel a terminal workflow.`,
    );
  }
  const now = isoNow();
  run.status = "cancelled";
  run.completed_at = now;
  run.updated_at = now;
  for (const step of run.steps) {
    if (step.status === "pending") {
      step.status = "skipped";
      step.decided_at = now;
      step.updated_at = now;
      _resolveApprovalInbox(step.inbox_item_id, "dismissed");
    }
  }
  return run;
}

// ---------------------------------------------------------------------------
// Dashboard summary (demo mode)
//
// Derives counts and lists from the in-process mock state — same demo
// requests, inbox items, contracts, and templates the rest of the app
// already shows. Kept simple on purpose: this is a preview surface, not
// a reporting layer, and the demo is allowed to undercount/overcount
// quietly when the underlying mock fixtures change. The fixed "today"
// is set to the demo workspace's frozen date so the upcoming/overdue
// windows behave deterministically across vitest runs.
// ---------------------------------------------------------------------------

const DEMO_TODAY = "2026-05-09";

function _isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function _addDays(iso: string, days: number): Date {
  const d = _isoToDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function _toDashboardRequest(row: ContractRequest): DashboardRequestSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    request_type: row.request_type,
    contract_type: row.contract_type,
    counterparty_name: row.counterparty_name,
    due_date: row.due_date,
    linked_contract_id: row.linked_contract_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function _toDashboardInbox(row: InboxItem): DashboardInboxSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    item_type: row.item_type,
    due_date: row.due_date,
    request_id: row.request_id,
    contract_id: row.contract_id,
    template_id: row.template_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function _toDashboardContract(
  row: ContractListItem,
): DashboardContractSummary {
  // Demo mock contracts don't carry artifact lists or DocuSeal ids;
  // show the truthful answer rather than faking it.
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    docuseal_submission_id: null,
    has_generated_docx: false,
    has_signed_pdf: false,
  };
}

function _buildDashboardCounts(): DashboardCounts {
  const reqs = combinedRequests();
  const inbox = combinedInboxItems();
  const contracts = combinedList();
  const todayDate = _isoToDate(DEMO_TODAY);

  const open_requests = reqs.filter((r) => r.status === "open").length;
  const in_progress_requests = reqs.filter(
    (r) => r.status === "in_progress",
  ).length;
  const urgent_or_high_priority_requests = reqs.filter(
    (r) =>
      (r.status === "open" || r.status === "in_progress") &&
      (r.priority === "urgent" || r.priority === "high"),
  ).length;

  const open_inbox_items = inbox.filter((i) => i.status === "open").length;
  const overdue_inbox_items = inbox.filter(
    (i) =>
      i.status === "open" &&
      i.due_date !== null &&
      _isoToDate(i.due_date) < todayDate,
  ).length;

  const contracts_total = contracts.length;
  const contracts_sent_for_signature = contracts.filter(
    (c) => c.status === "sent_for_signature",
  ).length;
  const contracts_executed = contracts.filter(
    (c) => c.status === "executed",
  ).length;

  // Demo agreement templates live in `demoAgreementTemplates`; treat
  // active ones as "active" here.
  const templates_active = demoAgreementTemplates.filter(
    (t) => t.status === "active",
  ).length;

  // PR #50 — narrow approval workflow counts. The session-scoped
  // ``sessionApprovalRuns`` array is the only state we mutate at
  // demo runtime; cancelled / completed / rejected runs drop out of
  // the active count, and pending/overdue counts only consider runs
  // that are still active.
  const active_approval_workflows = sessionApprovalRuns.filter(
    (r) => r.status === "active",
  ).length;
  const pending_approval_steps = sessionApprovalRuns
    .filter((r) => r.status === "active")
    .reduce(
      (acc, r) =>
        acc + r.steps.filter((s) => s.status === "pending").length,
      0,
    );
  const overdue_approval_steps = sessionApprovalRuns
    .filter((r) => r.status === "active")
    .reduce(
      (acc, r) =>
        acc +
        r.steps.filter(
          (s) =>
            s.status === "pending" &&
            s.due_date !== null &&
            _isoToDate(s.due_date) < todayDate,
        ).length,
      0,
    );

  const active_approval_workflow_templates = sessionApprovalTemplates.filter(
    (t) => t.status === "active",
  ).length;

  return {
    open_requests,
    in_progress_requests,
    urgent_or_high_priority_requests,
    open_inbox_items,
    overdue_inbox_items,
    contracts_total,
    contracts_sent_for_signature,
    contracts_executed,
    templates_active,
    active_approval_workflows,
    pending_approval_steps,
    overdue_approval_steps,
    active_approval_workflow_templates,
  };
}

export async function getDashboardSummary(
  options: ApiOptions & { limit?: number } = {},
): Promise<DashboardSummary> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const limit = Math.max(1, Math.min(20, options.limit ?? 5));

  const reqs = combinedRequests();
  const inbox = combinedInboxItems();
  const contracts = combinedList();
  const todayDate = _isoToDate(DEMO_TODAY);
  const windowEnd = _addDays(DEMO_TODAY, 14);

  const requests_due_soon = reqs
    .filter(
      (r) =>
        (r.status === "open" || r.status === "in_progress") &&
        r.due_date !== null &&
        _isoToDate(r.due_date) >= todayDate &&
        _isoToDate(r.due_date) <= windowEnd,
    )
    .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))
    .slice(0, limit)
    .map(_toDashboardRequest);

  const inbox_items_due_soon = inbox
    .filter(
      (i) =>
        i.status === "open" &&
        i.due_date !== null &&
        _isoToDate(i.due_date) >= todayDate &&
        _isoToDate(i.due_date) <= windowEnd,
    )
    .sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""))
    .slice(0, limit)
    .map(_toDashboardInbox);

  const recent_contracts = [...contracts]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(_toDashboardContract);

  const recent_requests = reqs
    .filter((r) => r.status !== "cancelled")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(_toDashboardRequest);

  const recent_signed_contracts = contracts
    .filter((c) => c.status === "executed")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, limit)
    .map(_toDashboardContract);

  return {
    counts: _buildDashboardCounts(),
    upcoming: { requests_due_soon, inbox_items_due_soon },
    recent_activity: {
      recent_contracts,
      recent_requests,
      recent_signed_contracts,
    },
    approval_analytics: _buildApprovalAnalytics(),
  };
}

// PR #62 — approval analytics block. Mirrors the backend definitions
// in ``app/api/dashboard.py``: only pending steps on active runs count
// toward the pending / overdue / by-assignee / oldest lists, and the
// 30-day windows look at completed_at on completed/rejected runs.
function _buildApprovalAnalytics(): DashboardApprovalAnalytics {
  const todayDate = _isoToDate(DEMO_TODAY);
  const cutoff = _addDays(DEMO_TODAY, -30);

  const activeRuns = sessionApprovalRuns.filter((r) => r.status === "active");
  const pendingSteps = activeRuns.flatMap((r) =>
    r.steps
      .filter((s) => s.status === "pending")
      .map((s) => ({ step: s, run: r })),
  );

  const overdueSteps = pendingSteps.filter(
    ({ step }) =>
      step.due_date !== null && _isoToDate(step.due_date) < todayDate,
  );

  const completedRuns = sessionApprovalRuns.filter(
    (r) => r.status === "completed",
  );
  const rejectedRuns = sessionApprovalRuns.filter(
    (r) => r.status === "rejected",
  );
  const cancelledRuns = sessionApprovalRuns.filter(
    (r) => r.status === "cancelled",
  );

  const completedRecent = completedRuns.filter(
    (r) =>
      r.completed_at !== null &&
      r.completed_at.slice(0, 10) >= cutoff.toISOString().slice(0, 10),
  );
  const rejectedRecent = rejectedRuns.filter(
    (r) =>
      r.completed_at !== null &&
      r.completed_at.slice(0, 10) >= cutoff.toISOString().slice(0, 10),
  );

  const buckets = new Map<
    string | null,
    { count: number; overdue_count: number }
  >();
  for (const { step } of pendingSteps) {
    const key = step.assigned_to;
    const cur = buckets.get(key) ?? { count: 0, overdue_count: 0 };
    cur.count += 1;
    if (step.due_date !== null && _isoToDate(step.due_date) < todayDate) {
      cur.overdue_count += 1;
    }
    buckets.set(key, cur);
  }
  const pending_by_assignee: DashboardApprovalAssigneeBucket[] = Array.from(
    buckets.entries(),
  )
    .map(([assigned_to, v]) => ({
      assigned_to,
      count: v.count,
      overdue_count: v.overdue_count,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const aKey = a.assigned_to ?? "￿";
      const bKey = b.assigned_to ?? "￿";
      return aKey.localeCompare(bKey);
    })
    .slice(0, 10);

  const oldest_pending_steps: DashboardOldestPendingStep[] = pendingSteps
    .slice()
    .sort((a, b) => {
      const aDue = a.step.due_date;
      const bDue = b.step.due_date;
      if (aDue !== null && bDue !== null) {
        if (aDue !== bDue) return aDue.localeCompare(bDue);
      } else if (aDue === null && bDue !== null) {
        return 1;
      } else if (aDue !== null && bDue === null) {
        return -1;
      }
      if (a.step.created_at !== b.step.created_at) {
        return a.step.created_at.localeCompare(b.step.created_at);
      }
      return a.step.id.localeCompare(b.step.id);
    })
    .slice(0, 5)
    .map(({ step, run }) => ({
      id: step.id,
      workflow_run_id: step.workflow_run_id,
      title: step.title,
      step_order: step.step_order,
      assigned_to: step.assigned_to,
      approver_name: step.approver_name,
      due_date: step.due_date,
      created_at: step.created_at,
      request_id: run.request_id,
      contract_id: run.contract_id,
    }));

  return {
    pending_steps: pendingSteps.length,
    overdue_steps: overdueSteps.length,
    active_workflows: activeRuns.length,
    completed_workflows: completedRuns.length,
    rejected_workflows: rejectedRuns.length,
    cancelled_workflows: cancelledRuns.length,
    workflows_completed_last_30_days: completedRecent.length,
    workflows_rejected_last_30_days: rejectedRecent.length,
    pending_by_assignee,
    oldest_pending_steps,
  };
}

// ---------------------------------------------------------------------------
// Approval workflow templates (PR #51 — reusable approval blueprints, demo mode)
//
// Mirrors the backend behavior closely enough for UI tests:
//  * creating a template stores its steps,
//  * archiving hides the template from the default list,
//  * instantiating creates a concrete workflow run + steps + a single
//    inbox item for the first step only,
//  * editing the template after instantiation does NOT mutate the run.
// No storage internals are ever materialized here.
// ---------------------------------------------------------------------------

const sessionApprovalTemplates: ApprovalWorkflowTemplate[] = [];

function _findApprovalTemplate(
  id: string,
): ApprovalWorkflowTemplate | undefined {
  return sessionApprovalTemplates.find((t) => t.id === id);
}

function _normalizeTemplateStepOrders(
  template: ApprovalWorkflowTemplate,
): void {
  template.steps.sort((a, b) => a.step_order - b.step_order);
  template.steps.forEach((step, index) => {
    step.step_order = index + 1;
  });
}

export async function listApprovalWorkflowTemplates(
  filters: ListApprovalWorkflowTemplateFilters = {},
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  return sessionApprovalTemplates
    .filter((tmpl) => {
      if (filters.status && tmpl.status !== filters.status) return false;
      if (
        !filters.status &&
        !filters.include_archived &&
        tmpl.status !== "active"
      ) {
        return false;
      }
      if (
        filters.template_type &&
        tmpl.template_type !== filters.template_type
      ) {
        return false;
      }
      if (
        filters.query &&
        !tmpl.name.toLowerCase().includes(filters.query.toLowerCase())
      ) {
        return false;
      }
      return true;
    })
    .map((t) => _cloneTemplate(t));
}

export async function getApprovalWorkflowTemplate(
  id: string,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const tmpl = _findApprovalTemplate(id);
  if (!tmpl) throw new ApiError(404, "Approval workflow template not found.");
  return _cloneTemplate(tmpl);
}

export async function createApprovalWorkflowTemplate(
  payload: ApprovalWorkflowTemplateCreateRequest,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  if (!payload.steps || payload.steps.length === 0) {
    throw new ApiError(422, "At least one step is required.");
  }
  if (
    sessionApprovalTemplates.some(
      (t) => t.name.toLowerCase() === payload.name.toLowerCase(),
    )
  ) {
    throw new ApiError(
      409,
      "A workflow template with that name already exists.",
    );
  }
  const now = isoNow();
  const templateId = nextId("wftpl");
  const steps: ApprovalWorkflowTemplateStep[] = payload.steps.map(
    (step, index) => ({
      id: nextId("wftpl-step"),
      organization_id: MOCK_DEMO_ORG_ID,
      workflow_template_id: templateId,
      step_order: step.step_order ?? index + 1,
      title: step.title,
      description: step.description ?? null,
      approver_name: step.approver_name ?? null,
      approver_email: step.approver_email ?? null,
      assigned_to: step.assigned_to ?? null,
      due_in_days: step.due_in_days ?? null,
      metadata_json: step.metadata_json ?? null,
      created_at: now,
      updated_at: now,
    }),
  );
  const template: ApprovalWorkflowTemplate = {
    id: templateId,
    organization_id: MOCK_DEMO_ORG_ID,
    name: payload.name,
    description: payload.description ?? null,
    template_type: payload.template_type ?? null,
    status: "active",
    created_at: now,
    updated_at: now,
    created_by: null,
    metadata_json: payload.metadata_json ?? null,
    steps,
  };
  sessionApprovalTemplates.unshift(template);
  return _cloneTemplate(template);
}

export async function updateApprovalWorkflowTemplate(
  id: string,
  payload: ApprovalWorkflowTemplatePatch,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const template = _findApprovalTemplate(id);
  if (!template) {
    throw new ApiError(404, "Approval workflow template not found.");
  }
  if (
    payload.name !== undefined &&
    payload.name !== null &&
    payload.name !== template.name &&
    sessionApprovalTemplates.some(
      (t) =>
        t.id !== template.id &&
        t.name.toLowerCase() === payload.name!.toLowerCase(),
    )
  ) {
    throw new ApiError(
      409,
      "A workflow template with that name already exists.",
    );
  }
  if (payload.name !== undefined && payload.name !== null) {
    template.name = payload.name;
  }
  if (payload.description !== undefined) {
    template.description = payload.description;
  }
  if (payload.template_type !== undefined) {
    template.template_type = payload.template_type;
  }
  if (payload.status !== undefined && payload.status !== null) {
    template.status = payload.status;
  }
  if (payload.metadata_json !== undefined) {
    template.metadata_json = payload.metadata_json;
  }
  template.updated_at = isoNow();
  return _cloneTemplate(template);
}

export async function archiveApprovalWorkflowTemplate(
  id: string,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const template = _findApprovalTemplate(id);
  if (!template) {
    throw new ApiError(404, "Approval workflow template not found.");
  }
  template.status = "archived";
  template.updated_at = isoNow();
  return _cloneTemplate(template);
}

export async function addApprovalWorkflowTemplateStep(
  templateId: string,
  payload: ApprovalWorkflowTemplateStepCreate,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplateStep> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const template = _findApprovalTemplate(templateId);
  if (!template) {
    throw new ApiError(404, "Approval workflow template not found.");
  }
  const order =
    payload.step_order ??
    (template.steps.length === 0
      ? 1
      : template.steps[template.steps.length - 1].step_order + 1);
  if (template.steps.some((s) => s.step_order === order)) {
    throw new ApiError(409, "step_order is already in use by another step.");
  }
  const now = isoNow();
  const step: ApprovalWorkflowTemplateStep = {
    id: nextId("wftpl-step"),
    organization_id: MOCK_DEMO_ORG_ID,
    workflow_template_id: template.id,
    step_order: order,
    title: payload.title,
    description: payload.description ?? null,
    approver_name: payload.approver_name ?? null,
    approver_email: payload.approver_email ?? null,
    assigned_to: payload.assigned_to ?? null,
    due_in_days: payload.due_in_days ?? null,
    metadata_json: payload.metadata_json ?? null,
    created_at: now,
    updated_at: now,
  };
  template.steps.push(step);
  template.steps.sort((a, b) => a.step_order - b.step_order);
  template.updated_at = now;
  return { ...step };
}

export async function updateApprovalWorkflowTemplateStep(
  templateId: string,
  stepId: string,
  payload: ApprovalWorkflowTemplateStepPatch,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplateStep> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const template = _findApprovalTemplate(templateId);
  if (!template) {
    throw new ApiError(404, "Approval workflow template not found.");
  }
  const step = template.steps.find((s) => s.id === stepId);
  if (!step) {
    throw new ApiError(404, "Approval workflow template step not found.");
  }
  if (
    payload.step_order !== undefined &&
    payload.step_order !== null &&
    payload.step_order !== step.step_order &&
    template.steps.some(
      (s) => s.id !== step.id && s.step_order === payload.step_order,
    )
  ) {
    throw new ApiError(409, "step_order is already in use by another step.");
  }
  if (payload.step_order !== undefined && payload.step_order !== null) {
    step.step_order = payload.step_order;
  }
  if (payload.title !== undefined && payload.title !== null) {
    step.title = payload.title;
  }
  if (payload.description !== undefined) step.description = payload.description;
  if (payload.approver_name !== undefined) {
    step.approver_name = payload.approver_name;
  }
  if (payload.approver_email !== undefined) {
    step.approver_email = payload.approver_email;
  }
  if (payload.assigned_to !== undefined) step.assigned_to = payload.assigned_to;
  if (payload.due_in_days !== undefined) step.due_in_days = payload.due_in_days;
  if (payload.metadata_json !== undefined) {
    step.metadata_json = payload.metadata_json;
  }
  step.updated_at = isoNow();
  template.steps.sort((a, b) => a.step_order - b.step_order);
  template.updated_at = step.updated_at;
  return { ...step };
}

export async function deleteApprovalWorkflowTemplateStep(
  templateId: string,
  stepId: string,
  options: ApiOptions = {},
): Promise<ApprovalWorkflowTemplate> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const template = _findApprovalTemplate(templateId);
  if (!template) {
    throw new ApiError(404, "Approval workflow template not found.");
  }
  const idx = template.steps.findIndex((s) => s.id === stepId);
  if (idx === -1) {
    throw new ApiError(404, "Approval workflow template step not found.");
  }
  template.steps.splice(idx, 1);
  _normalizeTemplateStepOrders(template);
  template.updated_at = isoNow();
  return _cloneTemplate(template);
}

export async function instantiateApprovalWorkflowTemplate(
  templateId: string,
  payload: CreateApprovalWorkflowFromTemplateRequest,
  options: ApiOptions = {},
): Promise<CreateApprovalWorkflowFromTemplateResponse> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const template = _findApprovalTemplate(templateId);
  if (!template) {
    throw new ApiError(404, "Approval workflow template not found.");
  }
  if (template.status !== "active") {
    throw new ApiError(
      409,
      "Archived workflow templates cannot be instantiated.",
    );
  }
  if (template.steps.length === 0) {
    throw new ApiError(
      409,
      "Workflow template has no steps; add at least one step before instantiating.",
    );
  }
  if (!payload.request_id && !payload.contract_id) {
    throw new ApiError(
      422,
      "At least one of request_id or contract_id is required.",
    );
  }

  const now = isoNow();
  const today = now.slice(0, 10);
  const runId = nextId("wf");
  const orderedTemplateSteps = [...template.steps].sort(
    (a, b) => a.step_order - b.step_order,
  );
  const steps: ApprovalStep[] = orderedTemplateSteps.map((tmplStep) => ({
    id: nextId("step"),
    organization_id: MOCK_DEMO_ORG_ID,
    workflow_run_id: runId,
    step_order: tmplStep.step_order,
    title: tmplStep.title,
    description: tmplStep.description,
    approver_name: tmplStep.approver_name,
    approver_email: tmplStep.approver_email,
    assigned_to: tmplStep.assigned_to,
    status: "pending",
    decision_note: null,
    decided_at: null,
    due_date:
      tmplStep.due_in_days !== null && tmplStep.due_in_days !== undefined
        ? _addDays(today, tmplStep.due_in_days)
            .toISOString()
            .slice(0, 10)
        : null,
    inbox_item_id: null,
    created_at: now,
    updated_at: now,
    metadata_json: tmplStep.metadata_json,
  }));
  const run: ApprovalWorkflowRun = {
    id: runId,
    organization_id: MOCK_DEMO_ORG_ID,
    name: payload.name,
    status: "active",
    request_id: payload.request_id ?? null,
    contract_id: payload.contract_id ?? null,
    template_id: payload.agreement_template_id ?? null,
    current_step_order: steps[0].step_order,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
    created_by: null,
    metadata_json: {
      ...(payload.metadata_json ?? {}),
      source_workflow_template_id: template.id,
      source_workflow_template_name: template.name,
    },
    steps,
  };
  // Inbox item for the first step only.
  const inbox = _emitApprovalInbox(run, steps[0]);
  steps[0].inbox_item_id = inbox.id;
  sessionApprovalRuns.unshift(run);
  return run;
}

function _cloneTemplate(
  template: ApprovalWorkflowTemplate,
): ApprovalWorkflowTemplate {
  return {
    ...template,
    steps: template.steps.map((s) => ({ ...s })),
  };
}


const sessionApprovalPolicies: ApprovalPolicy[] = (MOCK_APPROVAL_POLICIES as ApprovalPolicy[]).map((p) => ({ ...p }));

export async function listApprovalPolicies(filters: ListApprovalPolicyFilters = {}, options: ApiOptions = {}): Promise<ApprovalPolicy[]> {
  await delay(MOCK_LATENCY_MS, options.signal);
  return sessionApprovalPolicies.filter((p) => {
    if (!filters.include_archived && p.status === "archived") return false;
    if (filters.status && p.status !== filters.status) return false;
    if (filters.request_type && p.request_type !== filters.request_type) return false;
    if (filters.contract_type && p.contract_type !== filters.contract_type) return false;
    if (filters.priority && p.priority !== filters.priority) return false;
    if (filters.workflow_template_id && p.workflow_template_id !== filters.workflow_template_id) return false;
    return true;
  }).map((p) => ({ ...p }));
}

export async function getApprovalPolicy(id: string, options: ApiOptions = {}): Promise<ApprovalPolicy> {
  await delay(MOCK_LATENCY_MS, options.signal);
  const row = sessionApprovalPolicies.find((p) => p.id === id);
  if (!row) throw new ApiError(404, "Approval policy not found.");
  return { ...row };
}

export async function createApprovalPolicy(payload: ApprovalPolicyCreateRequest, options: ApiOptions = {}): Promise<ApprovalPolicy> {
  await delay(MOCK_LATENCY_MS, options.signal);
  if (!payload.name?.trim()) throw new ApiError(422, "name is required.");
  if (!payload.workflow_template_id?.trim()) throw new ApiError(422, "workflow_template_id is required.");
  if (sessionApprovalPolicies.some((p) => p.status === "active" && p.name.toLowerCase() === payload.name.trim().toLowerCase())) throw new ApiError(409, "An active approval policy with that name already exists.");
  const now = isoNow();
  const row: ApprovalPolicy = { id: nextId('apol'), organization_id: MOCK_DEMO_ORG_ID, name: payload.name.trim(), description: payload.description ?? null, status: 'active', workflow_template_id: payload.workflow_template_id, request_type: payload.request_type?.trim() ? payload.request_type : null, contract_type: payload.contract_type?.trim() ? payload.contract_type : null, priority: payload.priority?.trim() ? payload.priority : null, agreement_template_id: payload.agreement_template_id?.trim() ? payload.agreement_template_id : null, auto_attach: payload.auto_attach ?? true, applies_to_generated_contracts: payload.applies_to_generated_contracts ?? true, created_at: now, updated_at: now, metadata_json: payload.metadata_json ?? null };
  sessionApprovalPolicies.unshift(row);
  return { ...row };
}
export async function updateApprovalPolicy(id: string, payload: ApprovalPolicyPatchRequest, options: ApiOptions = {}): Promise<ApprovalPolicy> { await delay(MOCK_LATENCY_MS, options.signal); const row = sessionApprovalPolicies.find((p) => p.id === id); if (!row) throw new ApiError(404, 'Approval policy not found.'); Object.assign(row, payload, { updated_at: isoNow() }); return { ...row }; }
export async function archiveApprovalPolicy(id: string, options: ApiOptions = {}): Promise<ApprovalPolicy> { return updateApprovalPolicy(id, { status: 'archived' }, options); }

// PR #62 — seed the approval workflow demo fixtures at module load so
// the dashboard's Approval Analytics block has something to render
// before the user creates anything by hand. Lives at the bottom of
// the file so all referenced helpers (DEMO_TODAY, _addDays,
// MOCK_DEMO_ORG_ID, _buildDemoApprovalRuns) are already initialized.
sessionApprovalRuns.push(..._buildDemoApprovalRuns());
