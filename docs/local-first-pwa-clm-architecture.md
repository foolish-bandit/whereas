# Whereas Local-First PWA CLM Architecture Handoff

This document is the catch-up read for any developer (or new Claude Code session) joining Whereas. It explains where the product is going, the architecture decisions we have already locked in, what shipped in each recent PR, the current domain model and end-to-end CLM loop, the live security and privacy rules, the known gaps, and the recommended next steps.

It is intentionally long. Skim section 1 for product framing, section 2 for the load-bearing decisions, section 4 for what landed through PR #47, section 5 for the live domain model, section 6 for the PRs #42–#45 CLM loop, section 7 for the Requests + Inbox layer (PR #47) plus the subsequent intake / dashboard / approvals work, **section 14 for the consolidated approval/policy/gate/visibility/timeline/analytics checkpoint as of PR #62** (the place to read first if you only have time for one), the navigation-consolidation pass for PR #63 and the per-feature sections below it through PR #73 (preview), the *Compare UI, audit export, duplicate merge, test harness* section for **PRs #74–#77**, and the **UI polish pass for PRs #78–#88** at the end of the document.

---

## 1. Product Vision

Whereas is an open-source CLM (contract lifecycle management) for small and mid-sized legal teams that don't want their contracts on someone else's server. The repo is pre-v0.1 and not production-ready. The license is AGPL-3.0-or-later.

The product is being built to support **two deployment modes that share one domain model**.

### A. Local-first sync PWA mode

- Browser/PWA frontend installed by the user.
- Local working state (Markdown previews, drafts) eventually synced through a sync engine — the current target is PowerSync, not implemented yet.
- Sensitive contract workflows should remain local/private where feasible.
- **Clerk** may be used initially for hosted/local-first identity and team controls. Optional.
- **Nango** may be used for optional third-party integrations (Salesforce, Drive, Slack, Notion, etc.). Optional.
- **DocuSeal** remains the preferred signing integration. It runs alongside Whereas.

### B. Self-hosted server mode

- Deploy on your own infrastructure with `docker compose up`.
- FastAPI + Postgres + S3-compatible object storage (MinIO is the default) + DocuSeal as a peer service.
- **No hard requirement on Clerk or Nango.** Self-hosted mode must keep working without them.
- Suitable for companies and law firms that want full infrastructure control.

Both modes share the same SQLAlchemy models, the same FastAPI surface, and the same React/Vite/Tailwind frontend. **Do not build two apps.** When a feature is added, it must work in self-hosted mode first; managed/cloud-only flavor comes later as an additive layer.

---

## 2. Major Architectural Decisions

Decisions in this section are load-bearing. Reverse them only with maintainer sign-off and a tracked migration plan.

### 2.1 PWA-first, but not filesystem-dependent

The frontend ships as an installable PWA. Browser file access (the File System Access API) is **only** used for explicit, intentional actions:

- Import file.
- Export original.
- Save generated DOCX.
- Open original in Word or Google Docs (not implemented yet).
- Choose a local vault/folder as an optional advanced mode (not implemented).

**Normal contract or template viewing must not trigger filesystem permission prompts.** Repeated permission prompts during day-to-day reading is a non-starter. Reading flows go through app/backend storage.

### 2.2 Markdown working representation

A lightweight Markdown snapshot is stored alongside every uploaded contract/template. It is the working representation used for:

- Fast preview.
- Search.
- Clause/playbook analysis.
- Future local-first sync.
- Future offline/local cache behavior.

Markdown is **not** the official legal artifact. Markdown can be regenerated, re-converted, or replaced; the user's original DOCX/PDF and any signed PDF stay the source of truth.

### 2.3 Official legal artifacts

DOCX/PDF/signed PDFs remain official legal artifacts. They are tracked in dedicated artifact tables (`ContractArtifact`, `AgreementTemplateArtifact`) so the system can distinguish:

- `original_upload`
- `generated_docx`
- `signed_pdf`
- `redline`
- `exhibit`
- `attachment`

`is_official` flips per row. Append/versioned, not mutated. Original artifacts are never overwritten in place. **Original uploaded templates are never mutated by generation.**

### 2.4 MarkItDown via the conversion abstraction

Microsoft MarkItDown is used through a conversion abstraction (`backend/app/services/document_markdown.py`) when it is importable. Order of attempts is MarkItDown → fallback plain text from the existing parser → failed. Conversion failure is non-fatal and **must never block upload or generation**. The abstraction is the seam — do not pin Whereas to MarkItDown specifically.

**Docling** is a planned later fallback for complex PDFs, tables, and scanned documents. Not implemented yet.

### 2.5 PowerSync later, not now

PowerSync is the preferred future sync engine. Reasons it was chosen over Syncthing/IPFS:

- It fits Postgres-backed local-first sync naturally.
- It can sync structured app state into local SQLite on the client.
- It is better suited to CLM workflow/database state than peer-to-peer file sync.

Syncthing/IPFS are explicitly **not** the core app sync layer. They could be optional adapters someday, not foundations.

PowerSync sync rules will not be written until the domain model is stable across contracts, templates, artifacts, snapshots, and request/workflow objects (the request/workflow object family does not exist yet — see section 10).

### 2.6 ContractPlaybookBuilder is inspiration, not foundation

ContractPlaybookBuilder is **not** imported as the app foundation. It may inspire a future Whereas Playbook Builder module that can:

- Upload a standard template.
- Upload negotiated examples of the same template.
- Parse and cluster clause variants.
- Generate fallback positions / playbook guidance.

Not implemented. Out of scope for the next several PRs.

### 2.7 docxtpl for template fill

DOCX placeholder rendering uses `docxtpl` (Jinja-on-DOCX) rather than naive string replacement on `python-docx`. The reason is concrete: Word can split a placeholder like `{{counterparty_name}}` across multiple `<w:r>` runs in the underlying XML, so a string-replace pass over the XML misses placeholders that look intact in Word. `docxtpl` walks the document tree and stitches runs as needed, which is the only way to reliably support an `{{variable_key}}` syntax across templates produced by real users.

The render layer lives behind a seam (`backend/app/services/template_generation.py`) so a richer engine can replace it later without touching the API.

---

## 3. Current Architecture After PR #47

### Backend

- FastAPI (`backend/app`).
- SQLAlchemy 2.0 async, Alembic migrations under `backend/alembic/versions/` (latest: `0013_approval_workflows.py`).
- Postgres 16 with pgvector.
- MinIO / S3-compatible object storage via `app.services.storage.DocumentStorage`.
- Per-org wrapped DEK encryption for documents (`app.security.encryption`); per-artifact DEKs for `signed_pdf` rows from PR #45 onward.
- Existing routers: contracts, playbooks, clause templates, QA, DocuSeal bridge, setup, agreement templates, **requests, inbox-items, approval-workflows**.
- DocuSeal bridge router (`app/api/docuseal_bridge.py`) exposes a verified `POST /webhook` endpoint that materializes `signed_pdf` artifacts and flips contract status to `EXECUTED`.
- PR #47 added the CLM intake / work-queue layer: `ContractRequest` and `InboxItem` tables with full CRUD endpoints, plus an automatic `request_review` inbox item created in the same transaction as every new request. See section 7.
- PR #48 closed the loop between intake and template generation: a request carrying a `linked_template_id` can now be converted to a draft `Contract` via `POST /api/requests/{request_id}/convert-to-contract`. The endpoint reuses the same `generate_docx_from_template()` service the agreement-templates surface uses, links the new contract back onto the request, marks the request `completed`, and resolves the open `request_review` inbox item — all in one transaction. Approval workflows, upload-file conversion, and a one-click convert-and-send remain future work.
- PR #49 added a **dashboard analytics foundation**: a single read-only endpoint `GET /api/dashboard/summary` plus a Dashboard page. It returns counts (open / in-progress / urgent-or-high-priority requests; open / overdue inbox items; total / sent-for-signature / executed contracts; active templates), small lists of requests and inbox items due in the next 14 days, and the most recent contracts / requests / signed contracts. Org-scoped. No new tables, no caching layer, no charts — every query is a `COUNT(*)` or `ORDER BY ... LIMIT 5` over existing indexes. Compact projections (`Dashboard*Summary`) are explicit allowlists so storage internals can't accidentally end up on the surface.
- PR #50 added a **narrow approval workflow foundation**: `ApprovalWorkflowRun` + `ApprovalStep` tables, a router at `/api/approval-workflows`, and a frontend page. Workflows attach to a request and/or contract; steps are sequential; the active step's assignee finds it via an `approval`-typed `InboxItem`. Approving advances to the next step (or completes the workflow); rejecting ends the workflow and skips remaining steps; cancelling dismisses open approval inbox items and skips pending steps. The dashboard now also reports `active_approval_workflows`, `pending_approval_steps`, and `overdue_approval_steps`. See section 7.z. No parallel approvals, no conditional logic, no auto-send to DocuSeal — those are explicitly out of scope.
- PR #51 added **approval workflow templates**: `ApprovalWorkflowTemplate` + `ApprovalWorkflowTemplateStep` tables, a router at `/api/approval-workflow-templates`, and an `Approval Templates` page. Templates are reusable blueprints; instantiation copies their step definitions into concrete `ApprovalStep` rows on a new run, computes `due_date = today + due_in_days`, opens an `InboxItem` for the first step only, and reuses the same private helpers as the ad-hoc workflow create path. Editing a template after instantiation does not mutate in-flight runs. The dashboard reports `active_approval_workflow_templates`. See section 7.z.
- Existing background concerns: extraction, clause segmentation, deviation findings, playbook review runs, audit log.

### Frontend

- React 18 + Vite + Tailwind.
- PWA app shell with service worker / manifest. **No** API or sensitive-route runtime caching.
- Markdown preview UI for contracts and templates.
- Agreement Templates list + detail page with **Generate Agreement** and **Send to DocuSeal** controls.
- **Requests**, **Inbox**, **Approvals** (PR #50), and **Approval Templates** (PR #51) pages, with sidebar entries for each.
- Demo/mock mode (`isDemoMode()` + `mockApi.ts`) covers generation, send, signed-state surfaces, seed Requests + Inbox items, the approval workflow flows (create, approve, reject, cancel), and the approval-template flows (create, archive, instantiate) — so UI tests can run end-to-end without a backend.
- Defensive scrub of `storage_key`/`s3_key`/`wrapped_dek`/etc. on every API response.

---

## 4. PR-by-PR Implementation Summary (PRs #32 – #47)

### PR #32 — PWA + Contract Markdown Snapshot Foundation

Implemented:

- PWA app shell, service worker, manifest.
- No API/runtime caching of sensitive routes.
- Browser capability detection helper.
- `ContractMarkdownSnapshot` model and table.
- `document_markdown` conversion abstraction.
- Optional MarkItDown support with fallback to existing parsed plain text.
- Upload pipeline now creates a Markdown snapshot when conversion succeeds.
- `GET /api/contracts/{id}/markdown` returns the latest ready snapshot.
- Markdown conversion failure is non-fatal — upload still succeeds.

Constraints preserved: no PowerSync, no Clerk, no Nango, no Docling, no local vault mode, no DocuSeal changes.

### PR #33 — Markdown Preview UI

Implemented:

- Safe Markdown-to-React renderer (`renderMarkdown`) — never uses `dangerouslySetInnerHTML`.
- `MarkdownPreview` component.
- Contract workspace defaults to the Markdown preview when one is available.
- Markdown / View Original toggle in the document header.
- Conversion metadata + warning display.
- 404/no-snapshot becomes a calm empty state, not a scary error.
- Sidebar clause/field/finding selections auto-switch back to original source-span view (so span citations still work).
- Demo mode markdown snapshots wired up.

Known follow-up: GFM table rendering not yet supported.

### PR #34 — Contract Artifact Model Foundation

Implemented:

- `ContractArtifact` model and table.
- New uploads create one `original_upload` artifact row (`is_official=true`, `source='user_upload'`).
- `GET /api/contracts/{id}/artifacts` metadata-only endpoint.
- Frontend artifact types and API client.
- Small original-artifact metadata UI strip on the contract page.
- `storage_key` omitted from public responses; client-side scrub stays in place.

Important: existing `Contract.s3_key` / `mime_type` / `file_hash_sha256` columns preserved. No destructive migration.

### PR #35 — Artifact-Backed Original Download Hardening

Implemented:

- `contract_artifacts` service helpers.
- Download endpoint resolves through artifact priority with legacy fallback.
- No `storage_key` exposure.
- Audit log records artifact ID and filename, not raw storage internals.
- Frontend artifact strip shows official / legacy / hidden-on-error states.
- Existing download button behavior preserved end-to-end.

### PR #36 — Backfill Existing Contracts into Artifacts

Implemented:

- Idempotent backfill service (`backend/app/services/contract_artifacts.py`).
- CLI script: `python -m backend.scripts.backfill_contract_artifacts` with `--dry-run` and `--organization-id`.
- Creates `original_upload` artifacts for legacy contracts that have `s3_key` but no existing `original_upload` artifact.
- Skips contracts with no storage and contracts that already have an artifact.
- README operator note.

Important: backfill is **not** invoked from the migration. Operators run it explicitly. Legacy `Contract` columns remain as a fallback.

### PR #37 — Agreement Template Manager Foundation

Implemented:

Backend:

- `agreement_templates`, `agreement_template_artifacts`, `agreement_template_markdown_snapshots`, `agreement_template_variables` tables.
- Alembic 0009.
- Full CRUD for agreement templates, with soft-archive on DELETE.
- Upload endpoint stores the original DOCX/PDF as an `original_upload` `AgreementTemplateArtifact` and creates a Markdown snapshot when conversion succeeds.
- Variable CRUD with `(template_id, key)` uniqueness.
- Same org/user scoping pattern as contracts.
- Artifact responses do not expose `storage_key`.

Frontend:

- Agreement Templates route + sidebar entry.
- Templates list with archived toggle and empty state.
- Template detail page: metadata, upload, Markdown preview, variables list/create/delete.
- Demo/mock mode includes one template with Markdown + variables and one without.

Important: variables were metadata only in this PR. No DOCX generation, no template filling, no DocuSeal send.

### PR #38 — Architecture Handoff Doc

Earlier revision of this document. Code-only PRs resumed at #39.

### PRs #39 – #41 — Responsive Design, Demo Mode Surfaces, Marketing Site

Frontend polish only. Made the app responsive on mobile/tablet, surfaced every real-app feature in demo mode, and wrapped the demo in a marketing site shell. No backend or domain-model changes. Not load-bearing for the architecture below; mentioned for completeness.

### PR #42 — DOCX Generation from Template Variables

Implemented:

Backend:

- New endpoint `POST /api/agreement-templates/{template_id}/generate` (`backend/app/api/agreement_templates.py`).
- Generation service `backend/app/services/template_generation.py` with the docxtpl render seam (see section 2.7).
- Variable validation: rejects unknown keys, enforces required values, coerces types (`text`, `boolean`, `number`, `money`, `select` with options, `date` as YYYY-MM-DD).
- Resolves the latest official `original_upload` `AgreementTemplateArtifact` for the template — original is read, never mutated.
- Stores the generated DOCX through `DocumentStorage` with the same per-org wrapped DEK encryption as contract uploads.
- Creates a new `Contract` row plus a `ContractArtifact` row with `artifact_type="generated_docx"`, `source="template_generation"`, `is_official=true`.
- `metadata_json` stores only safe fields: `template_id`, `template_name`, `variable_keys` (sorted list of keys actually substituted), `variable_keys_blank` (sorted list of declared keys with empty values), `generated_at`. **Plaintext `variable_values` are deliberately never persisted in artifact metadata** — that hardening landed in the same PR.
- Generated DOCX is encrypted at rest exactly like an uploaded original.
- Markdown conversion runs on the generated DOCX and persists a `ContractMarkdownSnapshot` when it succeeds.
- Download endpoint extended to prefer `generated_docx` over `original_upload` (see section 6.2).

Frontend:

- "Generate Agreement" form on the template detail page; on success, deep-links into the new contract workspace.
- Demo mode wired up.

Out of scope at this stage: DocuSeal send, signed PDFs.

### PR #44 — Send Generated Agreement to DocuSeal

Implemented:

Backend:

- New endpoint `POST /api/contracts/{contract_id}/send-to-docuseal` (`backend/app/api/contracts.py`).
- Resolves the signable artifact via `get_latest_official_signable_artifact()` with priority `generated_docx > original_upload`, falling back to legacy `Contract.s3_key`.
- Decrypts the artifact via `DocumentStorage.retrieve_decrypted()` and posts it to DocuSeal through `app.services.docuseal_bridge.send_document_to_docuseal()`.
- Hardened error split: transport errors (`httpx.HTTPError`) and 5xx responses raise `RetryableDocuSealError` and are retried with `tenacity` (3 attempts, exponential backoff). 4xx responses and non-JSON responses raise terminal `DocuSealError` and surface as a clean 502 to the caller without retrying.
- On success: stores `Contract.docuseal_submission_id`, sets `Contract.status = SENT_FOR_SIGNATURE`, writes a safe audit event of type `CONTRACT_SENT_FOR_SIGNATURE`.
- Audit details record only `contract_id`, `artifact_id`, `artifact_type`, `filename`, `signer_count`, `submission_id`. **Signer PII (emails, names) is deliberately not written to audit details.**
- Repeated sends are allowed for typo-recovery: a new submission overwrites `docuseal_submission_id`, but every send is recorded as its own audit event so the history is preserved.

Frontend:

- "Send to DocuSeal" button on the contract page, with a small signer form that does not persist signer PII.

### PR #45 — Verify DocuSeal Webhooks; Materialize Signed PDF; Flip to Executed

Implemented:

Backend:

- New `POST /api/docuseal-bridge/webhook` endpoint (`backend/app/api/docuseal_bridge.py`).
- HMAC verification helper `verify_docuseal_webhook()` in `app/services/docuseal_bridge.py`:
  - Header: `X-Docuseal-Signature: {timestamp}.{hex_hmac}`.
  - HMAC-SHA256 over the literal string `"{timestamp}.{raw_body}"` keyed on `DOCUSEAL_WEBHOOK_SECRET`.
  - ±5 minute timestamp tolerance to reject stale/replayed deliveries.
  - Constant-time comparison via `hmac.compare_digest()`.
  - Interim shared-secret header `X-Whereas-Docuseal-Webhook-Secret` exists only as a fallback when the documented `X-Docuseal-Signature` header is absent. A bad documented signature does **not** fall back to the shared secret.
- Production rejects unsigned webhooks; development with `DOCUSEAL_WEBHOOK_SECRET` unset accepts unsigned webhooks with a warning log.
- Completion handler `app.services.docuseal_completion.apply_completion_event()`:
  - Recognizes event types `submission.completed`, `form.completed`, `completed`. Other events are acknowledged and ignored.
  - Looks up `Contract` by `docuseal_submission_id`. Unknown submission ids return a safe accepted/unknown response (HTTP 202) so DocuSeal does not retry storm.
  - Idempotent on (contract_id, docuseal_submission_id): if a `signed_pdf` artifact already exists for the pair, returns `duplicate` without rewriting state.
  - Fetches the signed PDF via `get_signed_document_from_docuseal()` (also under retry classification).
  - Encrypts the signed PDF under a **fresh per-artifact DEK** (Alembic 0011 added a nullable `wrapped_dek` column on `contract_artifacts`).
  - Creates a `signed_pdf` `ContractArtifact` whose `metadata_json` contains only `docuseal_submission_id`, `signed_at`, and (when present) `docuseal_event_id` — no signer PII.
  - Sets `Contract.status = EXECUTED` and writes a `CONTRACT_EXECUTED` audit event.
  - DocuSeal fetch failure returns 502 to DocuSeal and writes neither the artifact nor a status flip — the webhook is treated as not-yet-applied so DocuSeal can retry.
- Download endpoint extended to prefer `signed_pdf` over `generated_docx` (see section 6.2).

Frontend:

- Contract status surfaces show `SENT_FOR_SIGNATURE` and `EXECUTED` clearly; download button transparently delivers the signed PDF once available.

Out of scope at this stage: rich DocuSeal status dashboard, signer-event mirror table, generated PDF preview.

### PR #46 — Architecture Handoff Refresh

Documentation-only. Captured the post-#45 state of the project, the closed CLM loop, and the security/privacy rules (this document, in its previous revision).

### PR #47 — Requests + Inbox Foundation

Implemented the CLM intake / work-queue layer.

Backend:

- New `ContractRequest` and `InboxItem` SQLAlchemy models (`backend/app/models/__init__.py`).
- Alembic migration `0012_requests_inbox` adds `contract_requests` and `inbox_items`. Non-destructive: nothing in contracts, agreement templates, or artifacts is modified.
- New `POST/GET/PATCH/DELETE /api/requests` and `POST/GET/PATCH/DELETE /api/inbox-items` endpoints with org-scoped queries and the existing `X-Whereas-Dev-User` header pattern.
- DELETE soft-cancels a request (`status = "cancelled"`) and soft-dismisses an inbox item (`status = "dismissed"`); cancelled requests and dismissed items are excluded from list responses by default.
- Filters: `status`, `request_type`, `contract_type`, `priority`, `assigned_to`, `due_before`, `due_after`, `include_cancelled` for requests; `status`, `item_type`, `priority`, `assigned_to`, `due_before`, `due_after`, `include_dismissed` for inbox items.
- Creating a request **also creates a `request_review` inbox item in the same transaction** (`title = "Review request: {request.title}"`, status `open`, priority/assigned_to/due_date copied from the request).
- Updating a request to `completed` resolves the linked open `request_review` item to `completed`; cancelling a request dismisses it. Item-level edits (assignee, due date, priority) are deliberately **not** mirrored — once an inbox item exists it has its own work record.
- Linked contract / template IDs and `assigned_to` are validated to belong to the same organization; cross-org references return 422.
- New backend tests: `backend/tests/test_requests_api.py` (11 tests) and `backend/tests/test_inbox_items_api.py` (8 tests). Coverage: CRUD, filters, soft-cancel/dismiss exclusion, cross-org 404, cross-org link rejection, transactional rollback when the inbox insert fails, request -> inbox auto-creation, request status transitions resolving inbox items.

Frontend:

- New types `frontend/src/types/requests.ts` and `frontend/src/types/inboxItems.ts`.
- New API client functions: `listRequests`, `getRequest`, `createRequest`, `updateRequest`, `cancelRequest`, `listInboxItems`, `getInboxItem`, `createInboxItem`, `updateInboxItem`, `dismissInboxItem`.
- New pages `RequestsPage.tsx` and `InboxPage.tsx` with the same loading/loaded/error state-machine pattern used elsewhere; sidebar entries added (Inbox + Requests, ahead of Contracts so the work queue is the first surface a user sees).
- Demo/mock seed data: open + in-progress + completed sample requests, plus open / in-progress / completed / dismissed sample inbox items so empty / filter / dismissed-state behavior can be exercised without touching the backend.
- 9 new frontend tests covering renders, create flow, status transitions, soft-cancel/dismiss filtering.

Deliberately out of scope for PR #47 (deferred to later PRs):

- Approval workflow engine.
- Request → contract auto-generation (we link, we do not generate).
- Calendar / Nango / reminder integrations.
- PowerSync, Clerk, Nango, Docling, local vault mode, open-in-Word.
- Dashboard analytics beyond the basic page lists.
- Signer-event mirror table.

---

## 5. Current Domain Model

There are now four object families: contracts, agreement templates, the CLM loop wiring them together, and (new in PR #47) the requests + inbox intake/work-queue layer that sits in front of them all.

### 5.1 Contracts

`Contract` is the legal/business record. Associated:

- `ContractArtifact` — official/source/generated/signed files for a contract:
  - `original_upload` — user-uploaded source document.
  - `generated_docx` — DOCX produced by template generation (PR #42).
  - `signed_pdf` — PDF returned by DocuSeal completion (PR #45). Each has its own per-artifact `wrapped_dek`.
  - `redline`, `exhibit`, `attachment` allowed in schema; not produced yet.
- `ContractMarkdownSnapshot` — lightweight working Markdown preview, append-only.
- `Contract.status` — `UPLOADED | EXTRACTING | READY | FAILED | SENT_FOR_SIGNATURE | EXECUTED`.
- `Contract.docuseal_submission_id` — most recent DocuSeal submission (latest send wins).

The `Contract` row also still owns the legacy `s3_key`, `mime_type`, `file_hash_sha256`, `wrapped_dek` columns. Download prefers artifact rows in priority order and falls back to the legacy columns. PR #36 backfills the original-upload artifact row for older contracts. Legacy `Contract.wrapped_dek` is also used to decrypt artifacts created before per-artifact DEKs (those rows have `artifact.wrapped_dek IS NULL`).

### 5.2 Agreement Templates

`AgreementTemplate` is a reusable CLM template (NDA, MSA, SOW, DPA, employment, lease, other). Associated:

- `AgreementTemplateArtifact` — uploaded source template files. The `original_upload` is the file used as the input to `docxtpl` and is never mutated.
- `AgreementTemplateMarkdownSnapshot` — template preview/search text.
- `AgreementTemplateVariable` — variable metadata used to validate and render generation requests. Unique on `(template_id, key)`.

### 5.3 Requests + Inbox (PR #47)

`ContractRequest` is the **intake / business workflow** object: someone in the org asks for a contract (new NDA, MSA, amendment, renewal, ...) and the request is tracked through to `completed` or `cancelled`. `ContractRequest` is **not** the legal record — that stays on `Contract`.

`InboxItem` is the **work-queue / task** object: the per-user surface that says "this needs your attention." Items can point at a request, a contract, or a template (or none for a free-floating "general" task).

Key relationships and rules:

- `ContractRequest.status` — `OPEN | IN_PROGRESS | COMPLETED | CANCELLED`. `cancelled` requests are excluded from list responses by default; `include_cancelled=true` reveals them.
- `ContractRequest` may carry optional `linked_contract_id` and `linked_template_id`. Linking is by FK; **request-to-contract auto-generation is not implemented in this PR** and is deliberately out of scope.
- `InboxItem.status` — `OPEN | COMPLETED | DISMISSED`. `dismissed` items are excluded from list responses by default; `include_dismissed=true` reveals them.
- `InboxItem.item_type` is free-form string. Suggested values: `request_review`, `contract_review`, `signature_followup`, `metadata_cleanup`, `general`.
- **Creating a `ContractRequest` automatically creates an `InboxItem` with `item_type="request_review"` in the same transaction.** If the inbox insert fails, the request insert rolls back too.
- Updating a request to `completed` resolves the linked open `request_review` items to `completed`. Cancelling a request dismisses them. Item-level edits to the inbox row (assignee, due date, priority) are **not** mirrored back to the request — once an item exists, it owns its own state.
- All linked IDs (`linked_contract_id`, `linked_template_id`, `request_id`, `contract_id`, `template_id`, `assigned_to`) are validated to belong to the same organization. Cross-org references return 422.

Approval workflows, calendar/reminder integrations, and a dashboard analytics layer are **not** built and are out of scope for the next several PRs.

### 5.4 Generated agreements live as Contracts

A filled template — i.e., a generated DOCX from an `AgreementTemplate` plus variable values — becomes a **`Contract`** row with a `generated_docx` `ContractArtifact`, **not** another `AgreementTemplateArtifact`. This was the open question heading into PR #42 and is now the wired-up reality.

Why:

- Once a template is filled, it is a draft agreement.
- It belongs in the contracts repository, the dashboard, the future Inbox/workflows, DocuSeal sending, and review/playbook flows.
- Trapping generated agreements under `AgreementTemplate` would split CLM state across two parents and force every downstream feature to support both shapes.

The end-to-end CLM loop now reads:

```
AgreementTemplate
  + AgreementTemplateVariable values
  → POST /api/agreement-templates/{id}/generate
    → new Contract
    → ContractArtifact (artifact_type=generated_docx, encrypted at rest)
    → ContractMarkdownSnapshot (best-effort)
  → POST /api/contracts/{id}/send-to-docuseal
    → DocuSeal submission created
    → Contract.status = SENT_FOR_SIGNATURE
    → Contract.docuseal_submission_id stored
  → DocuSeal webhook (signed)
    → POST /api/docuseal-bridge/webhook
    → ContractArtifact (artifact_type=signed_pdf, fresh per-artifact DEK)
    → Contract.status = EXECUTED
  → GET /api/contracts/{id}/download
    → returns signed_pdf
```

This is the loop that PRs #42–#45 closed.

---

## 6. End-to-End CLM Loop (PRs #42 – #45)

This section is the source of truth for how generation, sending, and signing fit together. All four sub-flows share the same encryption posture, the same artifact model, and the same audit/security rules.

### 6.1 Template Generation Flow

- `AgreementTemplate` is the reusable object. Users upload a DOCX (or PDF) once and define variables on it.
- A generated agreement becomes a **`Contract`**. The artifact for the filled DOCX is a `ContractArtifact` with `artifact_type="generated_docx"`, **not** an `AgreementTemplateArtifact`.
- The original uploaded template artifact is read but **never mutated**. All renders are produced into a fresh storage object.
- Placeholder syntax is `{{variable_key}}`. Keys correspond 1:1 with `AgreementTemplateVariable.key`.
- Rendering uses **`docxtpl`**. The reason is concrete: Word can split a single placeholder across multiple `<w:r>` runs in the underlying XML, and a naive string-replace pass would silently miss those placeholders. `docxtpl` walks the document tree and reassembles runs, so `{{variable_key}}` substitutions are reliable across real-world templates. The render function is hidden behind a service-layer seam (`backend/app/services/template_generation.py`) so a different engine can be swapped in later.
- Variable validation runs before render: required values must be non-empty, unknown keys are rejected with 400, and values are coerced per declared type (`text`, `boolean`, `number`, `money`, `select` with options enforcement, `date` as `YYYY-MM-DD`).
- **Plaintext `variable_values` are deliberately not stored in artifact metadata.** The hardening in PR #42 explicitly redacted them. `ContractArtifact.metadata_json` for a `generated_docx` row contains only:
  - `template_id`
  - `template_name`
  - `variable_keys` — sorted list of variable keys actually substituted
  - `variable_keys_blank` — sorted list of declared keys whose value was empty
  - `generated_at` — ISO-8601 UTC timestamp
- The generated DOCX is **encrypted at rest** via `DocumentStorage`, using the same per-org wrapped DEK encryption path as contract uploads. Pre-PR-#45 generated rows use the contract-level `wrapped_dek`; post-PR-#45 generated rows store their own `wrapped_dek`.
- The endpoint also kicks off the Markdown conversion abstraction on the generated DOCX. Conversion failure is non-fatal.

### 6.2 Contract Download Resolution

The `GET /api/contracts/{id}/download` endpoint resolves the file to return in this order:

1. Latest official `signed_pdf` `ContractArtifact`.
2. Latest official `generated_docx` `ContractArtifact`.
3. Latest official `original_upload` `ContractArtifact`.
4. Legacy `Contract.s3_key` / `mime_type`.

The priority list lives in `backend/app/services/contract_artifacts.py` as `DOWNLOADABLE_ARTIFACT_TYPES_BY_PRIORITY`. The reasoning:

- `signed_pdf` is the **final executed artifact**. Once a contract is signed, that is what the user wants when they click Download.
- `generated_docx` is the **generated draft artifact**. Until a signed PDF exists, the most recent generated draft is the closest thing to "the contract" we have.
- `original_upload` is the **uploaded source artifact**. Used for contracts uploaded directly (without going through generation) and as a backstop for generated contracts whose `generated_docx` row was deleted.
- Legacy `Contract.s3_key` remains a **migration fallback** for contracts created before the artifact model existed. PR #36 backfills `original_upload` artifacts for these, but until every legacy contract has been migrated and verified the fallback stays. No PR has authority to remove it.

The download path also handles per-artifact DEKs: if the artifact has its own `wrapped_dek` (introduced in Alembic 0011), it is used; otherwise the path falls back to `Contract.wrapped_dek`. Artifacts created before PR #45 have a NULL `wrapped_dek` and rely on the legacy contract-level key.

`storage_key` is never exposed in any response, regardless of which row resolved the download.

### 6.3 DocuSeal Send Flow

- `POST /api/contracts/{contract_id}/send-to-docuseal` sends a contract for signature.
- The signable artifact is resolved using `get_latest_official_signable_artifact()` with priority:

  1. `generated_docx`
  2. `original_upload`

  Falling back to legacy `Contract.s3_key` if no artifact exists. Note this is **deliberately a different list** from download priority: `signed_pdf` is excluded because re-signing an already-signed PDF is not a meaningful flow.
- The artifact is decrypted in memory and posted to DocuSeal via `app.services.docuseal_bridge.send_document_to_docuseal()`. Transport errors and 5xx responses are retried (`tenacity`, 3 attempts, exponential backoff); 4xx responses and non-JSON responses are terminal and surface as a 502.
- On success:
  - `Contract.status` is set to `SENT_FOR_SIGNATURE`.
  - `Contract.docuseal_submission_id` is updated to the new submission id.
  - A safe audit event of type `CONTRACT_SENT_FOR_SIGNATURE` is written.
- Repeated sends are deliberately allowed (typo-recovery): the **latest submission id wins** on `Contract.docuseal_submission_id`, but every successful send is recorded as its own audit event so the history is preserved.
- **Signer PII is not written to audit details.** The audit row records only `contract_id`, `artifact_id`, `artifact_type`, `filename`, `signer_count`, `submission_id` — no emails or names.

### 6.4 DocuSeal Webhook Completion Flow

- `DOCUSEAL_WEBHOOK_SECRET` is the configuration knob (`backend/app/core/config.py`).
- **Production deployments require verification.** A request without a valid signature is rejected.
- **Development deployments may accept unsigned webhooks** (with a warning log) only when `ENVIRONMENT="development"` and the secret is unset. This is intended for local DocuSeal-under-Docker testing and is not a production posture.

**Preferred verification path (DocuSeal's documented format):**

- Header: `X-Docuseal-Signature: {timestamp}.{hex_hmac}`.
- `hex_hmac` is HMAC-SHA256 over the literal string `"{timestamp}.{raw_body}"`, keyed on `DOCUSEAL_WEBHOOK_SECRET`.
- `timestamp` is a UTC UNIX epoch (seconds). A ±5 minute tolerance is enforced; older or future-dated requests are rejected to defeat replay.
- Comparison uses `hmac.compare_digest()` (constant-time).

**Interim shared-secret fallback:**

- An older interim header `X-Whereas-Docuseal-Webhook-Secret` exists only as a fallback for environments that have not yet upgraded to signed webhooks.
- It is consulted **only when the documented `X-Docuseal-Signature` header is absent**.
- A bad value in the documented signature header **cannot fall back** to the shared-secret check — that path is explicitly closed off so an attacker who learns the shared secret cannot forge by sending a junk HMAC alongside it.

**Recognized completion events:**

- `submission.completed`
- `form.completed`
- `completed`

Other events are acknowledged with 202 and ignored.

**Completion behavior:**

- Look up `Contract` by `docuseal_submission_id`.
- If the submission id is unknown, return an accepted/unknown response (HTTP 202). DocuSeal will not retry; we will not write state for a submission we never tracked.
- If a `signed_pdf` artifact already exists for `(contract_id, docuseal_submission_id)`, the request is a duplicate replay. Return idempotently without rewriting state.
- Fetch the signed PDF bytes from DocuSeal. If the fetch fails, return 502 — neither the artifact nor the status flip is written. DocuSeal will retry.
- On success:
  - Encrypt the signed PDF under a **fresh per-artifact DEK**.
  - Create a `signed_pdf` `ContractArtifact`. `metadata_json` contains only `docuseal_submission_id`, `signed_at`, and (optionally) `docuseal_event_id`.
  - Set `Contract.status = EXECUTED`.
  - Write a `CONTRACT_EXECUTED` audit event.

### 6.5 Artifact Privacy / Security Rules

These rules apply across all artifact types and are checked on every PR that touches the artifact tables.

- Never expose `storage_key` in any API response.
- Never expose `wrapped_dek` in any API response.
- Never log raw document bytes or base64 payloads. Logging is metadata-only.
- `signed_pdf` `metadata_json` contains only safe fields: `docuseal_submission_id`, `docuseal_event_id`, `signed_at`. Nothing else.
- No signer PII (emails, names, addresses) in artifact metadata or audit events. The audit row for a send records `signer_count`, not the signers.
- Each `signed_pdf` gets a **fresh DEK** (its own `wrapped_dek` row) so that the signed artifact's encryption is independent of the pre-signature artifacts.
- Legacy artifacts (rows created before Alembic 0011) may have a NULL `wrapped_dek`. Decryption falls back to `Contract.wrapped_dek` for compatibility. New `signed_pdf` rows must always have their own `wrapped_dek`.
- The frontend API client must defensively scrub `storage_key`/`s3_key`/`wrapped_dek`/`wrapped_master_key`/`presigned_url`/`presigned_uri` on every response (`scrubSecrets` in `frontend/src/lib/api.ts`).

---

## 7. API Surface Added by PRs #32 – #47

### Contracts

- `GET /api/contracts/{id}/markdown` — latest ready Markdown snapshot.
- `GET /api/contracts/{id}/artifacts` — metadata-only artifact listing.
- `GET /api/contracts/{id}/download` — artifact-backed with `signed_pdf > generated_docx > original_upload > legacy` priority (section 6.2).
- `POST /api/contracts/{id}/send-to-docuseal` — section 6.3.

### Agreement Templates

All routes are org-scoped through the same dev-user header pattern (`X-Whereas-Dev-User`) used by contracts and playbooks today.

- `POST   /api/agreement-templates`
- `GET    /api/agreement-templates`
- `GET    /api/agreement-templates/{id}`
- `PATCH  /api/agreement-templates/{id}`
- `DELETE /api/agreement-templates/{id}` — soft archive.
- `POST   /api/agreement-templates/{id}/upload`
- `GET    /api/agreement-templates/{id}/artifacts` — metadata only, no `storage_key`.
- `GET    /api/agreement-templates/{id}/markdown`
- `POST   /api/agreement-templates/{id}/variables`
- `GET    /api/agreement-templates/{id}/variables`
- `PATCH  /api/agreement-templates/{id}/variables/{variable_id}`
- `DELETE /api/agreement-templates/{id}/variables/{variable_id}` — hard delete (variables are not legal records).
- `POST   /api/agreement-templates/{id}/generate` — section 6.1.

### DocuSeal bridge

- `POST /api/docuseal-bridge/webhook` — section 6.4. Signed; production requires a valid signature.

### Requests (PR #47, extended in PR #48)

- `POST   /api/requests` — creates the request and a `request_review` `InboxItem` in one transaction.
- `GET    /api/requests` — filters: `status`, `request_type`, `contract_type`, `priority`, `assigned_to`, `due_before`, `due_after`, `include_cancelled`. Cancelled requests excluded by default.
- `GET    /api/requests/{request_id}`.
- `PATCH  /api/requests/{request_id}` — updates fields; transitioning to `completed` or `cancelled` resolves linked open `request_review` items.
- `DELETE /api/requests/{request_id}` — soft cancel: `status = "cancelled"` and dismisses linked open `request_review` items.
- `POST   /api/requests/{request_id}/convert-to-contract` (PR #48) — body `{title?, variable_values}`. Reuses the agreement-template generation service to render a DOCX, materializes a draft `Contract` plus a `generated_docx` `ContractArtifact`, sets `linked_contract_id` on the request, transitions the request to `completed`, and resolves the open `request_review` inbox item. Returns the updated request, the new contract, the artifact, and (best-effort) a `generated` Markdown snapshot. Rejects with 409 if the request is cancelled, already converted, or has no `linked_template_id`; propagates the generation service's 400s for unknown / missing-required / malformed variable values; cross-org access returns 404. Storage internals (`storage_key`, `wrapped_dek`) never appear in the response.

### Inbox items (PR #47)

- `POST   /api/inbox-items`.
- `GET    /api/inbox-items` — filters: `status`, `item_type`, `priority`, `assigned_to`, `due_before`, `due_after`, `include_dismissed`. Dismissed items excluded by default.
- `GET    /api/inbox-items/{item_id}`.
- `PATCH  /api/inbox-items/{item_id}`.
- `DELETE /api/inbox-items/{item_id}` — soft dismiss: `status = "dismissed"`.

### Dashboard summary (PR #49)

- `GET /api/dashboard/summary?limit=N` — read-only aggregate of CLM activity for the caller's org. ``limit`` defaults to 5 and is hard-capped at 20 by FastAPI's ``Query(le=20)``.
- Counts: `open_requests`, `in_progress_requests`, `urgent_or_high_priority_requests` (open or in-progress, priority urgent or high), `open_inbox_items`, `overdue_inbox_items` (open + due_date < today), `contracts_total`, `contracts_sent_for_signature`, `contracts_executed`, `templates_active`. PR #50 adds `active_approval_workflows`, `pending_approval_steps` (pending steps on active workflows), and `overdue_approval_steps` (pending steps on active workflows whose `due_date` is in the past). PR #51 adds `active_approval_workflow_templates` (count of `ApprovalWorkflowTemplate` rows with `status == active`).
- Upcoming lists: requests and inbox items with ``due_date`` in `[today, today + 14 days]` (inclusive). Requests filter to open/in_progress; inbox items filter to open. Cancelled requests and dismissed/completed inbox items never appear.
- Recent activity: top-N contracts (by `created_at`), top-N requests (by `created_at`, cancelled excluded), top-N executed contracts (by `updated_at`).
- Compact projections (`DashboardRequestSummary`, `DashboardInboxSummary`, `DashboardContractSummary`) — *not* the full detail responses. Contract summaries carry `has_generated_docx` / `has_signed_pdf` booleans assembled from a single `contract_artifacts` metadata-only lookup; storage / encryption columns and `full_text` are deliberately excluded.
- All queries filter on `organization_id`. There is no cross-org query parameter.

### Approval workflows (PR #50)

A workflow run is a concrete approval process attached to a request and/or contract. Each run has an ordered list of `ApprovalStep` rows, only one of which is "current" at a time. The current step's assignee finds it via a linked `InboxItem` with `item_type='approval'`.

State transitions:

- **Create** (`POST /api/approval-workflows`) creates the run, creates step rows `1..n`, and creates an `approval` inbox item for step 1 only. `current_step_order = 1`.
- **Approve** (`POST /api/approval-workflows/{id}/steps/{step_id}/approve`) marks the step `approved`, completes its inbox item, and either (a) opens an inbox item for the next pending step and updates `current_step_order`, or (b) marks the workflow `completed` if there is no next step. The approval does NOT mutate the linked `ContractRequest` / `Contract` status — those transitions remain manual. The endpoint will not auto-send to DocuSeal.
- **Reject** (`POST /api/approval-workflows/{id}/steps/{step_id}/reject`) marks the step `rejected`, completes its inbox item, marks the workflow `rejected`, sets `completed_at`, and marks all later pending steps `skipped` (their inbox items, if any, are dismissed). Does not mutate the linked request/contract.
- **Cancel** (`PATCH /api/approval-workflows/{id}/cancel`) marks the workflow `cancelled`, sets `completed_at`, dismisses any open approval inbox items linked to the run, and marks remaining pending steps `skipped`. Cancelling a terminal workflow returns 409.
- **Update** (`PATCH /api/approval-workflows/{id}/steps/{step_id}`) edits a small allowlist (title / approver / due date) while the step is still pending. Mirrors title / assignee / due date onto the open inbox item.
- **List + detail** are org-scoped; `?status=`, `?request_id=`, `?contract_id=`, and `?include_terminal=false` filters are supported. Cross-org access returns 404 across every endpoint.

Idempotency / 409 guards: approving or rejecting an already-decided step (or any non-current pending step), or operating on a non-active workflow, returns 409. The frontend page (`ApprovalWorkflowsPage.tsx`) gates buttons accordingly so a single user clicking through the UI doesn't surface 409s — the guards exist for the multi-tab / API-direct case.

Inbox guardrail: the generic `PATCH /api/inbox-items/{id}` (status / linkage edits) and `DELETE /api/inbox-items/{id}` endpoints return 409 when the row is an `item_type='approval'` row. The approval workflow router owns those rows; mutations have to flow through `/api/approval-workflows/.../approve|reject|cancel` so the linked `ApprovalStep` cannot decouple. Cosmetic edits (priority, description, manual due-date / assignee tweaks) on an approval inbox row are still allowed — the guardrail only blocks the transitions that would leave the workflow stuck.

Out of scope by design: parallel approvals, conditional branching, SLA reminders, automatic DocuSeal send on completion, automatic request/contract status mutation. Future PRs land those on top.

### Approval workflow templates (PR #51)

A workflow template is a **reusable blueprint**, distinct from a concrete `ApprovalWorkflowRun`. Two new tables (`approval_workflow_templates`, `approval_workflow_template_steps`) hold the template + its ordered step definitions; a new router at `/api/approval-workflow-templates` exposes them.

Naming caution: `AgreementTemplate` (a document blueprint, used to generate DOCX agreements) is a separate concept from `ApprovalWorkflowTemplate` (an approval blueprint). The instantiate request takes the AgreementTemplate id under `agreement_template_id` to keep the two from colliding on the wire.

Lifecycle:

- **Create** (`POST /api/approval-workflow-templates`) creates the template + its step rows. At least one step is required. Template name is unique per org.
- **List** (`GET /api/approval-workflow-templates`) defaults to active templates; `?include_archived=true`, `?status=`, `?template_type=`, `?query=` are supported filters.
- **Get** (`GET /api/approval-workflow-templates/{id}`) returns the template with its ordered step list.
- **Patch** (`PATCH /api/approval-workflow-templates/{id}`) edits name / description / template_type / status / metadata.
- **Archive** (`DELETE /api/approval-workflow-templates/{id}`) is a soft archive — `status = "archived"`. Existing runs that were instantiated from the template are not touched.
- **Step CRUD** (`POST/PATCH/DELETE /api/approval-workflow-templates/{id}/steps[/{step_id}]`) appends, updates, or deletes step definitions. Delete renormalizes remaining `step_order` values to stay 1..n.
- **Instantiate** (`POST /api/approval-workflow-templates/{id}/instantiate`) creates a concrete `ApprovalWorkflowRun` plus `ApprovalStep` rows from the template. Only the first step gets an `InboxItem` — exactly the same surface as an ad-hoc workflow create. Each concrete step's `due_date` is computed as `today + due_in_days` if the template step has a `due_in_days`, otherwise `null`. The new run carries `metadata_json.source_workflow_template_id` and `source_workflow_template_name` so a viewer can trace it back.

Invariants pinned by tests:

- Editing the template after instantiation does **not** mutate the in-flight run (steps are copies, not references). This is the entire reason templates are a separate type from runs.
- Archived templates cannot be instantiated; the route returns 409.
- Instantiation requires at least one of `request_id` / `contract_id`; `agreement_template_id` is optional.
- All linked entities (`request_id`, `contract_id`, `agreement_template_id`) must belong to the same org as the caller; cross-org returns 422.
- Cross-org template access (GET / PATCH / DELETE / instantiate) returns 404.
- Storage / encryption columns never appear in the response; the standard `scrubSecrets` defense is layered on top.

Reuse: instantiation calls into the same private helpers (`_validate_links`, `_validate_user_in_org`, `_create_inbox_item_for_step`, `_load_run_response`) the ad-hoc create endpoint already uses, so the workflow run and its first inbox item have exactly the same shape regardless of which entry point opened them.

---

## 8. Security / Privacy / Data Handling Rules

These rules are non-negotiable. Reviewers should reject changes that violate them. Many of them are restated in section 6.5 because they apply specifically to the artifact pipeline; the list here is the cross-cutting view.

- Do not expose `storage_key` (or `s3_key`, `wrapped_dek`, `wrapped_master_key`, `presigned_url`, `presigned_uri`) in any public API response.
- The frontend API client must defensively scrub the keys above on every response.
- Markdown conversion failure must not block upload or generation.
- Failed Markdown snapshots must not be returned as ready previews — `/markdown` endpoints filter `conversion_status == "ready"`.
- The service worker must not cache `/api/*` or sensitive contract/template data. Verify with a quick scan of `dist/sw.js` after `npm run build`.
- Cross-org access returns 404 (the existing project convention).
- Original artifacts and original templates are official legal records. Markdown is the working representation. Do not mix them. Original uploaded templates are never mutated.
- Legacy `Contract` storage fields (`s3_key`, `mime_type`, `wrapped_dek`) remain a fallback until a future, safe migration removes them. No PR has authority to remove them.
- Span citations remain mandatory for any extracted/derived information surfaced in the UI (see `docs/design-principles.md`).
- DocuSeal webhooks must verify HMAC in production. Development unsigned acceptance requires both `ENVIRONMENT="development"` and `DOCUSEAL_WEBHOOK_SECRET` unset, and emits a warning.
- Plaintext `variable_values` are not persisted in artifact metadata. Audit events do not contain signer PII. `signed_pdf` metadata is restricted to `docuseal_submission_id`, `docuseal_event_id`, `signed_at`.

---

## 9. Known Gaps / Follow-ups

Tracked, intentionally not implemented. See **section 14.8** for the canonical, scoped list of approval-system gaps; the bullet here is a pointer.

- **Approval system gaps** — see section 14.8 for the full list (full request / workflow / policy detail routes, request approval timeline backfill, deeper approval analytics post-PR #62, SLA / calendar reminders, RBAC for policy management and overrides, policy precedence/conflicts, policy reconciliation/removal, conditional/parallel approvals).
- Upload-file request conversion: the convert endpoint only handles requests linked to an `AgreementTemplate`. A request with a counterparty-supplied DOCX (no template) still has to be converted by uploading the file through the `/api/contracts/upload` flow; merging that into the convert path is future work.
- Convert-then-send shortcut: the convert endpoint deliberately stops at "draft Contract." Sending to DocuSeal is a separate explicit action so legal can review the draft before signature.
- Calendar / integration layer (DocuSign-style reminders, deadline tracking, etc.).
- PowerSync local-first sync rules.
- Clerk integration for local-first hosted mode (optional).
- Nango integration for optional third-party integrations (optional).
- Local vault/folder advanced mode.
- Open-in-Word / Open-in-Google-Docs flows.
- Generated PDF preview (we generate DOCX today; on-demand PDF preview of a generated agreement is not implemented).
- Rich DocuSeal status dashboard (sent submissions, per-signer status, expirations).
- Signer-event mirror table (per-signer signing/declination/viewing events stored locally).
- GFM table support in the Markdown renderer.
- Docling fallback for complex PDFs / tables / scans.
- ContractPlaybookBuilder-inspired Playbook Builder module.
- Dashboard analytics (open requests by counterparty, urgent inbox counts by assignee, etc.).
- Backfill/archive cleanup and eventual removal of legacy `Contract` storage fields, only after a safe migration plan.

---

## 10. PRs #48 through #51 — request → contract conversion, dashboard, approvals + templates

PR #48 closed the loop between intake and template generation: the conversion route reuses the same `generate_docx_from_template()` service as the agreement-templates surface, so there is exactly one code path that turns a template + variable values into a draft `Contract` + `generated_docx` `ContractArtifact`. A request with `linked_template_id` is now a one-click draft, and the request is closed out and the matching `request_review` inbox item is resolved in the same transaction. The route is stricter than necessary on idempotency (already-converted requests 409 rather than silently returning the existing draft) so accidental re-clicks can't quietly produce duplicate contracts.

PR #49 added the **dashboard analytics foundation**: a single read-only `GET /api/dashboard/summary` endpoint plus a Dashboard page that lands on `/demo/dashboard`. It is intentionally narrow — counts, two due-soon lists, three recent-activity lists — and reuses no infrastructure. No materialized views, no caching layer, no charts, no cycle-time math. Compact `Dashboard*Summary` schemas (separate from the existing detail responses) keep storage internals off the surface by construction. The contract summary's `has_generated_docx` / `has_signed_pdf` booleans come from a single bulk artifact-existence query, so the dashboard doesn't fan out into N artifact lookups.

PR #50 added the **narrow approval workflow foundation**: `ApprovalWorkflowRun` + `ApprovalStep` tables, a router at `/api/approval-workflows` (create / list / detail / cancel / approve / reject / step update), and an `Approvals` page in the frontend. The pending step's assignee finds it through an `approval`-typed `InboxItem`; approval / rejection / cancellation drive the inbox state in the same transaction. Three new dashboard counts (`active_approval_workflows`, `pending_approval_steps`, `overdue_approval_steps`) surface workload. The model is deliberately linear: no parallel approvals, no conditional branching, no SLA reminders, no auto-send to DocuSeal, no automatic mutation of the linked request/contract status.

PR #51 added **approval workflow templates** on top of that foundation: `ApprovalWorkflowTemplate` + `ApprovalWorkflowTemplateStep` tables (org-scoped, with name unique per org), a router at `/api/approval-workflow-templates` (create / list / get / patch / archive plus per-step CRUD and an `instantiate` endpoint), and an `Approval Templates` page in the frontend. Instantiation copies template step definitions into concrete `ApprovalStep` rows on a fresh `ApprovalWorkflowRun`, computes each step's `due_date` from `today + due_in_days` when set, opens an `InboxItem` for the first step only, and reuses the same private helpers as the ad-hoc create path so the run shape is identical regardless of entry point. A new dashboard count (`active_approval_workflow_templates`) surfaces blueprint inventory. The path parameter and the `agreement_template_id` body field are deliberately spelled differently so the workflow-template concept does not collide with the existing `AgreementTemplate` (document blueprint).

PR #53 adds a backend-only **approval policies** layer: `ApprovalPolicy` rows at `/api/approval-policies` that match request attributes (`request_type`, `contract_type`, `priority`, optional linked `AgreementTemplate`) and can auto-attach `ApprovalWorkflowTemplate` blueprints to matching requests. Null filters are wildcards; matching is deterministic and org-scoped. Auto-attachment is idempotent via run metadata (`source_approval_policy_id` et al.), and request field changes that stop matching do not remove previously created workflows yet (future reconciliation work). The DocuSeal gate now checks matching active policies (`applies_to_generated_contracts=true`) and blocks with `required_approval_policy_unmet` when required policy-linked approvals are missing. No parallel approvals, conditional builders, auto-send, RBAC expansion, calendar/Nango, or PowerSync were added. Frontend policy management UI remains deferred; policies are currently managed through API.

PR #59 makes the **DocuSeal send-gate response self-describing**. `GET /api/contracts/{id}/approval-gate` and the 409 body of `POST /.../send-to-docuseal` now include `required_policies` and `missing_policies`: compact `ApprovalGatePolicySummary` projections (`id`, `name`, `workflow_template_id`, `auto_attach`, `applies_to_generated_contracts`, `request_type`, `contract_type`, `priority`, `agreement_template_id`) sorted deterministically by name. The legacy `required_policy_ids` / `missing_policy_ids` arrays remain on the response for back-compat and are aligned element-by-element with the named summaries. The frontend `SendToDocusealPanel` renders policy names directly, falling back to ids only if the named summaries are absent (e.g. an older mock). The summary is a strict allowlist with `extra="forbid"` — `description`, `metadata_json`, `created_by`, `created_at`, `status`, and storage / artifact fields cannot leak through. Gate allow/block semantics are unchanged.

PR #60 adds **gate remediation links** on top of PR #59: a frontend-only `ApprovalGateRemediation` component renders a "How to unblock" section beneath the blocked Send-to-DocuSeal panel. It maps each gate `code` to actionable copy and safe links into existing list pages — `active_approval_workflows` / `rejected_approval_workflows` link to the linked request's approval status (`/demo/requests`) and the Approvals page (`/demo/approvals`) and surface `blocking_workflow_ids` inline; `required_approval_policy_unmet` links to the Approval Policies page (`/demo/approval-policies`) and shows missing policy names (falling back to `missing_policy_ids` when names are absent); `cancelled_without_completed_approval` links to the request approvals and the Approvals page so a fresh workflow can be started. There are no new backend fields, no new routes, and no detail-level deep-links — the list pages are the destination for this PR. The gate fetch failure path is unchanged (the safe error state preempts remediation rendering, so users never see remediation copy backed by stale data). UX/explainability only: gate allow/block semantics, approval policy matching, approval state transitions, and DocuSeal send behavior are unchanged.

PR #61 layers **deep-link query strings** on top of PR #60. Each remediation link now carries the relevant id: "View request approvals" becomes `/demo/requests?request_id=<id>`, each blocking workflow becomes `/demo/approvals?workflow_id=<id>`, and each missing policy becomes `/demo/approval-policies?policy_id=<id>`. The destination pages read those query strings via `useSearchParams`: `RequestsPage` auto-expands the matching row's "View approval status" section and scrolls it into view; `ApprovalWorkflowsPage` auto-expands the matching workflow's step detail and scrolls; `ApprovalPoliciesPage` highlights the row, and if the linked policy isn't in the current list it auto-toggles `Include archived` once so an archived policy is reachable without manual fiddling. The shared subtle highlight (`info-soft` background plus `info-ring` border, no animation) and a `data-deep-link-target="true"` attribute mark the linked row for both visual emphasis and tests. Unknown ids render a small `*-deep-link-not-found` notice instead of silently doing nothing. There are still no new detail routes, no new backend fields, and no changes to gate semantics, approval policy matching, approval state transitions, or DocuSeal send behavior. Navigation only.

PR #62 adds an **approval analytics foundation** to the dashboard. `GET /api/dashboard/summary` now carries an `approval_analytics` block — an aggregate over the existing `approval_workflow_runs` and `approval_steps` rows — alongside the existing `counts` / `upcoming` / `recent_activity` blocks. Fields: `pending_steps`, `overdue_steps`, `active_workflows`, `completed_workflows`, `rejected_workflows`, `cancelled_workflows`, `workflows_completed_last_30_days`, `workflows_rejected_last_30_days`, plus two compact lists — `pending_by_assignee` (capped at 10, grouped on `ApprovalStep.assigned_to`, with an Unassigned bucket when the column is null and an `overdue_count` subset) and `oldest_pending_steps` (capped at 5, ordered `due_date ASC NULLS LAST, created_at ASC, id ASC`, carrying the workflow run's linked `request_id` / `contract_id` so the frontend can deep-link via PR #61). Counts are computed with the same definitions as the existing top-level dashboard counters (a step is "pending" only on an `active` workflow run; "overdue" requires a `due_date < today`) so the analytics block and the headline counter never disagree. PII posture: `approver_email` is intentionally omitted from `oldest_pending_steps`; `approver_name` and `assigned_to` (the existing `users.id` UUID) are the only identifying fields. The frontend `DashboardPage` renders five lightweight cards and the two side-by-side lists; rows deep-link to `/demo/approvals?workflow_id=<id>` and (when set) `/demo/requests?request_id=<id>`. Reporting / explainability only — no new backend tables, no state transitions, no charts, and no changes to the DocuSeal gate or approval-policy matching.

---

## 11. Recommended Next PR: Signer-event mirror, or richer gate remediation links

The activity timeline shipped in PR #58 and policy names in the gate response shipped in PR #59, so users can now answer both **"how did we get here?"** and **"what's the name of the policy blocking this send?"**. The remaining loose threads on the approval / signature stack are below.

### 11a. Signer-event mirror table

**Goal:** today, the contract-level timeline only shows `contract.sent_for_signature` and `contract.executed` — it can't show "Counterparty A viewed", "Counterparty B signed", "Counterparty C declined" because Whereas doesn't persist per-signer events from DocuSeal. A small `signer_events` table mirrored from the verified DocuSeal webhook would close that loop.

Suggested minimum scope:

- New `signer_events` table: `id`, `contract_id`, `submission_id`, `event_type` (allowlist: `viewed`/`signed`/`declined`/`completed`), `occurred_at`, `signer_email_hash` (NOT raw email — hash with the per-org master key so the audit value can't be enumerated by an attacker).
- The DocuSeal webhook handler (`docuseal_completion.py`) already verifies HMAC and parses the payload; extend it to insert one `signer_event` per signer transition.
- Project signer events into the contract activity timeline through a new `signer.viewed` / `signer.signed` / etc. label set in `activity_timeline._title_for`.
- Frontend gets richer rows for free.

### 11b. Richer gate remediation links

**Goal (mostly done in PR #60–PR #61):** PR #60 mapped each gate `code` to actionable copy and links into the Requests, Approvals, and Approval Policies list pages, surfacing missing policy names and blocking workflow ids inline. PR #61 added query-string deep-links (`?request_id=`, `?workflow_id=`, `?policy_id=`) so the destination page scrolls and auto-expands the matching row, with auto-toggle of `Include archived` on the policies page and a not-found notice when the id is missing. The remaining loose threads are *full detail routes* and richer per-summary URL hints from the backend.

Suggested follow-up scope (post-PR #61):

- Extend `ApprovalGatePolicySummary` with two optional URL strings (or relative paths) that the backend renders deterministically from the existing `workflow_template_id` / `policy.id` so the frontend can deep-link without inventing routes.
- Add real detail routing on the Requests / Approvals / Approval Policies pages (today the deep-link query string targets a row inside the list) so deep-links can land on a dedicated detail page.
- Promote the inline copy into a remediation checklist UI as the surface grows.
- Track override usage with RBAC-aware controls when RBAC lands.

### 11c. Out of scope for whichever PR is picked

- No new approval state transitions.
- No DocuSeal gate rule changes (gate output shape can grow but allow/block logic stays).
- No PowerSync, RBAC, Nango, calendar, Docling, local vault.
- No richer analytics / cycle-time math.

---

## 12. Testing Expectations

### Backend

```
cd backend
ruff check .
python -m pytest tests/<file>
```

The full suite may require heavy dependencies (`litellm`, `tesseract`, `tenacity`, `python-docx`, `docxtpl`, etc.) depending on the environment. In sandboxes that lack them, run only the test files relevant to the change. **Pre-existing import or fixture failures (e.g., `tests/test_contracts_api.py` missing `litellm`) are not introduced by template/artifact/DocuSeal PRs — confirm and call out in the PR description.**

### Frontend

```
cd frontend
npx tsc --noEmit
npx eslint src
npx vitest run
npm run build
```

### PWA

After `npm run build`, sanity-check the generated service worker:

```
grep -E "/api|api/contracts|api/agreement-templates|api/docuseal-bridge|api/requests|api/inbox-items|api/approval-workflows" frontend/dist/sw.js || echo "no API routes precached"
```

The service worker must not include API routes in its precache or runtime cache rules.

---

## 13. Developer Notes / Guardrails

Read these before starting any new feature work.

- Keep PRs narrow. One product-visible behavior change per PR is the target.
- Do not jump to PowerSync until the domain model is stable across contracts, templates, artifacts, snapshots, and request/workflow objects (the latter does not exist yet — see section 10).
- Do not make browser filesystem access part of ordinary viewing flows.
- Do not mutate original uploaded templates or original uploaded contracts. They are official artifacts.
- Do not overwrite official artifacts. Append/version instead.
- Keep the self-hosted Docker behavior working at all times. `docker compose up` must remain a valid first run.
- Avoid adding cloud-only dependencies to core self-hosted mode. Cloud-only features should be additive, optional, and clearly disclosed.
- Clerk and Nango should be optional adapters introduced later. Do not bake either into core code.
- No service-worker caching of sensitive API responses.
- Span citations are mandatory for any surfaced extracted information. See `docs/design-principles.md`.
- LiteLLM is the only LLM seam — no provider-specific imports in feature code.
- Do not duplicate DocuSeal functionality (template fields, signature collection, audit trails). DocuSeal is a peer service. Integrate; don't reimplement.
- AGPL posture: no per-file headers, no proprietary loadable modules, no vendor-privileged hooks.
- Telemetry stays off by default. No phone-home, no anonymous stats, no "just a heartbeat."

When in doubt about an architectural choice, ask before coding. A short clarifying question is always cheaper than ripping out a wrong design.


## 14. Approval system checkpoint (after PR #59)

This is the single canonical description of the approval / policy / gate / visibility stack as it stands on `main` today. Read it first if you're new to the codebase or returning to it. Sections 7.z (PR #50) and 7.aa (PR #51), and the PR-by-PR notes in section 10, remain useful for archaeology, but **this section is the load-bearing one** — if any of them disagrees with this checkpoint, this checkpoint wins.

The pieces, in dependency order:

1. `ApprovalWorkflowRun` + `ApprovalStep` — the concrete in-flight process.
2. `ApprovalWorkflowTemplate` + `ApprovalWorkflowTemplateStep` — reusable blueprints.
3. `ApprovalPolicy` — match-and-auto-attach rules between requests and workflow templates.
4. DocuSeal send gate — what blocks `POST /api/contracts/{id}/send-to-docuseal`.
5. Request approval visibility — explainability surface that stitches the above together.

The whole thing is intentionally linear and explicit: **no parallel approvals, no conditional branching, no auto-send, no automatic mutation of request/contract status, no RBAC, no calendar, no PowerSync.** Those are tracked in section 14.8.

### 14.1 Approval Workflow Runs

A `ApprovalWorkflowRun` is a concrete approval process attached to a `ContractRequest` and/or a `Contract`. It carries an ordered list of `ApprovalStep` rows — only one of which is "current" at a time — and a status (`active`, `completed`, `rejected`, `cancelled`).

- The current pending step opens an `InboxItem` with `item_type='approval'`. That row is the assignee's work signal.
- Approving the current step (`POST /api/approval-workflows/{id}/steps/{step_id}/approve`) closes its inbox item and either opens the next pending step's inbox item or marks the workflow `completed`.
- Rejecting (`/reject`) marks the workflow `rejected`, marks remaining pending steps `skipped`, and dismisses any pending inbox items on those steps.
- Cancelling the workflow (`PATCH /api/approval-workflows/{id}/cancel`) marks it `cancelled`, dismisses open approval inbox items, and skips remaining pending steps. Cancelling a terminal workflow returns 409.
- Pending-step PATCH allows a small allowlist of edits (title / approver / due date) and mirrors them onto the open inbox item so the work-queue surface stays in sync.
- Approval workflow completion does **not** mutate the linked request/contract status. Those transitions remain manual.

**Inbox guardrail.** The generic `PATCH /api/inbox-items/{id}` (status / linkage edits) and `DELETE /api/inbox-items/{id}` return 409 when the row has `item_type='approval'`. The approval workflow router owns those rows; mutations have to flow through `/approve|reject|cancel` so an `ApprovalStep` cannot decouple from its inbox row. Cosmetic edits (priority, description, manual due-date / assignee tweaks) on an approval inbox row are still allowed.

**Idempotency / 409 guards.** Approving or rejecting an already-decided step, a non-current pending step, or any step on a non-active workflow returns 409. Frontend buttons gate accordingly so a single user clicking through the UI doesn't surface 409s; the guards exist for the multi-tab / API-direct case.

### 14.2 Approval Workflow Templates

An `ApprovalWorkflowTemplate` is a **reusable blueprint**, distinct from a concrete `ApprovalWorkflowRun`. The two-table split (`approval_workflow_templates`, `approval_workflow_template_steps`) is what makes "edit a template without disturbing in-flight runs" possible.

- Instantiation (`POST /api/approval-workflow-templates/{id}/instantiate`) copies template step definitions into fresh `ApprovalStep` rows on a new `ApprovalWorkflowRun`. Steps are copies, not references; **template edits never propagate to existing runs**.
- Each concrete step's `due_date` is computed at instantiation time as `today + due_in_days` if the template step has a `due_in_days`, otherwise `null`.
- Only the first concrete step gets an `InboxItem` — exactly the same surface as an ad-hoc workflow create. The instantiate handler delegates to the same private helpers (`_validate_links`, `_validate_user_in_org`, `_create_inbox_item_for_step`, `_load_run_response`) the ad-hoc create endpoint uses, so the run shape is identical regardless of entry point.
- The new run carries `metadata_json.source_workflow_template_id` and `source_workflow_template_name` so a reader can trace back to the blueprint.
- Archived templates cannot be instantiated; the route returns 409.
- A template must keep at least one step (`DELETE` on the last step returns 409); otherwise it would not be instantiable.

**Naming caution.** `AgreementTemplate` (a document blueprint, used to generate DOCX agreements) is a separate concept from `ApprovalWorkflowTemplate`. The instantiate request takes the AgreementTemplate id under `agreement_template_id` to keep the two from colliding on the wire.

### 14.3 Approval Policies

An `ApprovalPolicy` row matches a `ContractRequest` by `request_type`, `contract_type`, `priority`, and an optional linked `AgreementTemplate`. **Null criteria are wildcards** (a policy with `priority=null` matches every priority). Matching is org-scoped and deterministic — the same request always produces the same matching set.

- Active matching policies with `auto_attach=true` instantiate their `workflow_template_id` against the request on request create or update.
- Auto-attach is **idempotent via run metadata**: a non-cancelled run with `metadata_json.source_approval_policy_id` equal to the policy's id is treated as already-attached, so re-applying the same policy on an update does not duplicate runs.
- A **cancelled** policy-derived run does NOT block reattach: if an admin cancels the auto-attached workflow and the request is then re-saved, the policy will reattach. (Soft skip filters on `status != cancelled`.)
- `auto_attach=false` policies still surface in the matching set and in the visibility surface; they're simply not auto-instantiated. A user can still pick one up manually.
- Archiving a policy (`status='archived'`) immediately drops it from the matching set. Existing policy-derived runs on requests are not retroactively touched — that's tracked as policy reconciliation/removal in 14.8.
- Frontend management UI ships under `Approval Policies` in the demo sidebar (list / create / archive, archived hidden by default with an include-archived toggle). **There is no RBAC** on policy management today — anyone with API access to the org can create / archive policies. Tracked in 14.8.

### 14.4 DocuSeal Approval Gate

`POST /api/contracts/{id}/send-to-docuseal` runs the gate (`can_send_contract_to_docuseal`) before any DocuSeal call. The gate's resolution rules, in order:

| Situation | Result | Code |
| --- | --- | --- |
| Contract has no linked `ContractRequest` | allow | `no_linked_request` |
| Linked request, no workflows + no required policies | allow | `no_workflows_required` |
| Any active workflow on the request/contract | block | `active_approval_workflows` |
| Any rejected workflow | block | `rejected_approval_workflows` |
| Required matching policy with no completed policy-derived workflow | block | `required_approval_policy_unmet` |
| At least one completed workflow + nothing active/rejected/missing | allow | `approvals_completed` |
| Cancelled-only workflows + no completed | block | `cancelled_without_completed_approval` |

"Required" means policies with `applies_to_generated_contracts=true` that match the request. Manual completed workflows do **not** satisfy a required policy — only a completed run carrying `metadata_json.source_approval_policy_id` for that policy does. (Pinned by tests in `test_request_approval_status_api.py` and `test_approval_gating_service.py`.)

**Override.** An escape hatch exists: `approval_override=true` plus a required `approval_override_reason` lets an authorized caller bypass the gate. Override usage is recorded in the audit log with compact metadata (no signer PII, no storage internals). RBAC-limited override permissions are future work.

**Response shape (PR #59).** Both `GET /api/contracts/{id}/approval-gate` and the 409 body of `POST /api/contracts/{id}/send-to-docuseal` carry compact `required_policies` and `missing_policies` summaries (`id`, `name`, `workflow_template_id`, `auto_attach`, `applies_to_generated_contracts`, `request_type`, `contract_type`, `priority`, `agreement_template_id`) sorted deterministically by name. The legacy `required_policy_ids` / `missing_policy_ids` arrays remain on the response for back-compat and are aligned element-by-element with the named summaries. The summary uses `extra="forbid"` plus an explicit allowlist, so a future column on `ApprovalPolicy` cannot accidentally leak through this surface — `description`, `metadata_json`, `created_by`, `status`, and storage / artifact fields are intentionally omitted. The frontend renders policy names directly in the SendToDocuSeal panel, falling back to ids when the named summaries are absent (e.g. an older mock). PR #59 is *response polish only*: the allow/block resolution above did not change, and the same scenarios still allow / block as before.

The gate **does not mutate workflows**, never auto-sends, never auto-creates or removes runs, and never changes the linked request's status.

### 14.5 Request Approval Visibility (PR #56)

`GET /api/requests/{request_id}/approval-status` is a read-only stitch of:

- the matching policies (every match, including non-required ones, so the UI can label internal-only policies separately),
- the workflow runs attached to the request and (when applicable) its linked contract — same predicate the gate uses, so the two cannot disagree on which runs are "relevant",
- a `summary` block that aligns with the gate.

Response shape (compact, per-field allowlist; storage internals excluded by `extra="forbid"` on every nested model):

- `request_id`, `linked_contract_id`
- `matching_policy_ids`, `matching_policies` — `id`, `name`, `workflow_template_id`, `auto_attach`, `applies_to_generated_contracts`, criteria.
- `workflow_runs[]` — each carries `id`, `name`, `status`, `current_step_order`, `started_at`, `completed_at`, `source_approval_policy_id`, `source_approval_policy_name`, plus a step list (`id`, `step_order`, `title`, `status`, `assigned_to`, `approver_name`, `approver_email`, `due_date`, `decided_at`).
- `summary` — `has_required_policies`, `has_active_workflows`, `has_rejected_workflows`, `has_completed_workflows`, `all_required_policy_workflows_completed`, `ready_for_signature` (null when no contract is linked), `blocking_reason` (gate code), `blocking_reason_text` (server-rendered plain English).

Logic reuse:

- `find_matching_approval_policies` is imported directly from the policy service.
- When `linked_contract_id` is non-null, `can_send_contract_to_docuseal` is called directly so `ready_for_signature` and `blocking_reason` come from the live gate.
- When there is no linked contract the gate isn't run; `ready_for_signature` is `null` and a soft `blocking_reason` is derived from active/rejected/required-unmet states so the UI can still render the right badge.

Frontend: the Requests page renders an inline, lazy-loaded approval-status section per row (`RequestApprovalStatusSection`). The fetch only happens when a user toggles "View approval status" — list render does not fan out into N approval-status fetches. Badges (`Approval pending` / `Ready for signature` / `Approval rejected` / `Approval blocked` / `Approval completed` / `No approval required`) and blocking copy come straight from the server's `summary`; there is no client-side derivation. When a contract is linked, the section renders a link into the contract workspace.

Visibility is **explainability only**. It does not change workflow or gate semantics, does not auto-create or remove runs, and never mutates request/contract state.

### 14.6 Activity Timeline (PR #58)

Read-only chronological feed for a request or a contract. Two endpoints, same item shape:

- `GET /api/requests/{request_id}/activity` — approval events on workflow runs attached to the request *or* its linked contract, plus DocuSeal events on the linked contract. Mirrors the visibility surface's "this is the request's set of runs" predicate so the two cannot disagree.
- `GET /api/contracts/{contract_id}/activity` — approval events on workflow runs attached to the contract directly, plus DocuSeal events on the contract.

Both default to `?limit=25` and hard-cap at 100. Items are ordered `occurred_at DESC, id DESC`. Cross-org access returns 404 (via the existing `_get_request_for_org` / `_get_contract_for_org`).

**Audit-backed.** The timeline is a projection over the existing append-only hash-chained `audit_events` table. PR #58 adds seven narrowly-named approval event types to `AuditEventType`:

```
approval.workflow.created
approval.step.activated
approval.step.approved
approval.step.rejected
approval.workflow.completed
approval.workflow.rejected
approval.workflow.cancelled
```

Plus the existing `contract.sent_for_signature` (PR #44) and `contract.executed` (PR #45) events.

These are emitted from the same handlers the API already exposes — `create_workflow`, `approve_step`, `reject_step`, `cancel_workflow`, `instantiate_workflow_template` — via a small wrapper module (`app.services.approval_audit`). Audit writes happen inside the same transaction as the workflow / step writes, so a chain failure rolls everything back.

**Compact, allowlisted detail payloads.** The audit chain is hash-validated, so what goes into `details` becomes part of the persisted record. The `approval_audit` helpers stamp only:

- `workflow_run_id`, `workflow_run_name`
- `request_id`, `contract_id` (whichever the run is attached to)
- `source` — one of `ad_hoc` / `template` / `policy`, derived from `metadata_json`
- `source_workflow_template_id`, `source_approval_policy_id`, `source_approval_policy_name` (when known)
- step-level: `approval_step_id`, `step_order`, `step_title`
- `decision_note_present: bool` — **never** the decision-note text. The `ApprovalStep.decision_note` column already holds the raw text for the few places that need it; the audit chain is not the right place for user-typed content.

**Server-rendered titles.** The projection emits a `title` and optional `description` per item so every client renders the same string and there's no client-side i18n / format drift. Adding a new event type requires extending the title map (`activity_timeline._title_for`); a test pins the existing set.

**Frontend.** A reusable `ActivityTimeline` component (props: `kind: "request" | "contract"` plus the matching id) lazy-loads the feed on mount and renders a simple vertical list with category dots (success / warning / danger / info) — no charts, no filters. `RequestsPage` mounts it inline alongside the approval-status section when a row is expanded; `ContractWorkspacePage` mounts it as a dedicated panel on every contract page.

**Backfill caveat.** The timeline starts recording approval events at PR #58. Workflow runs that existed before PR #58 have no approval audit rows and will not appear in the feed; their existing DocuSeal send / completion audit events from PRs #44 / #45 still surface if they target the request's linked contract.

### 14.7 Security / privacy rules (approval system)

The cross-cutting rules in section 8 still apply; restated for the approval surfaces specifically:

- No `storage_key`, `wrapped_dek`, `s3_key`, raw document bytes, presigned URLs, signer PII, or DocuSeal secrets in any approval / policy / gate / visibility response. Every nested response model uses `extra="forbid"` and a scalar allowlist.
- The frontend `scrubSecrets` defense scrubs the same key set defensively on every response.
- Gate / audit metadata is intentionally compact: `contract_id`, `submission_id`, `event_id`, `signed_at`, override reason. No `variable_values`, no signer PII.
- The service worker does not cache `/api/*` (NavigationRoute denylist `[/^\/api\//]`); approval / policy / gate / visibility responses are never precached.
- Cross-org access on every approval / policy / template / visibility endpoint returns 404; linked entity (`request_id`, `contract_id`, `agreement_template_id`) cross-org references return 422.

### 14.8 Known gaps in the approval system

Tracked, intentionally not implemented after PR #58:

- **Deeper gate remediation links.** PR #60 added the "How to unblock" remediation section to the Send-to-DocuSeal panel; PR #61 added `?request_id=` / `?workflow_id=` / `?policy_id=` deep-link query strings so the destination page scrolls / auto-expands / highlights the matching row and surfaces a not-found notice when the id is unknown. What remains is dedicated *detail routes* (the deep-links land on the existing list pages, not on a dedicated request / workflow / policy detail page), an explicit remediation checklist UI, RBAC-aware override controls, and notifications / calendar reminders. Optional `approval_workflow_template_url` / `approval_policy_url` fields on `ApprovalGatePolicySummary` are still on the table as a backend follow-up.
- **Approval timeline backfill.** PR #58 starts recording approval audit events going forward. Workflow runs that existed before PR #58 do not have audit rows and will not appear on the timeline; a backfill pass is tracked as future work.
- **Richer timeline filters / export.** Today the timeline is a flat list with a server-side cap (default 25, max 100). Filters by event type, actor, date range, plus an exportable audit trail are tracked as future work.
- **Actor display names.** Audit rows carry `actor_user_id`; the timeline renders the id but not the human name. Joining users in the timeline projection is future work.
- **Signer-event mirror table.** Per-signer DocuSeal events (viewed / signed / declined) are not surfaced on the timeline today — only the contract-level `sent_for_signature` and `executed` events are. A `signer_events` table mirrored from DocuSeal webhooks is the right shape, future work.
- **Deeper approval analytics.** PR #62 shipped the **approval analytics foundation** on the dashboard: pending / overdue step totals, workflow status counts (active / completed / rejected / cancelled), 30-day windowed completed/rejected counts, `pending_by_assignee` (capped at 10), and `oldest_pending_steps` (capped at 5, deep-linked via PR #61). What remains: cycle time per template, average days-pending, workload by approver over time, top blocked approvers, exportable approval reports, and per-policy / per-template SLA tracking — all gated on enough audit rows to be meaningful.
- **SLA / calendar reminders.** Pending-step due dates exist but nothing notifies anyone; calendar / Nango integration is the eventual home.
- **RBAC for policy management and gate overrides.** Today any caller in the org can create / archive policies or use `approval_override`. Override usage is audit-logged but not gated.
- **Policy precedence / conflicts.** Two matching policies that point at different workflow templates both auto-attach today; first-match precedence or explicit ordering is future work.
- **Policy reconciliation / removal.** If a request's fields change so that a previously-matching policy no longer matches, the policy-derived workflow is **not** removed. Reconciliation logic is future work.
- **Conditional / parallel approvals.** The model is strictly linear. Conditional skip predicates ("skip CFO if amount < $X") and N-of-M parallel groups are deliberate future work.
- **PowerSync sync rules.** The local-first sync layer hasn't been written; sync rules can lock in once parallel/conditional approval shapes settle.

## Navigation consolidation pass

A UI/UX-only consolidation tightened the sidebar so the app reads as a
CLM workspace rather than a list of database tables. No backend
behavior, approval gate semantics, approval state transitions, or
DocuSeal flow changed.

Top-level navigation is now:

1. Dashboard
2. Repository (visible label for `Contract` records)
3. Requests (workspace landing with cards: New request, Start from
   template, Agreement templates, Request queue)
4. Playbooks (top-level — review standards and fallback positions)
5. Clause Manager (top-level — approved clauses and reusable drafting
   guidance; legacy `/clause-library` still resolves)
6. Approvals (workspace landing with cards for Tasks, Workflows,
   Templates, Policies)
7. Settings

Agreement Templates were removed from the top-level nav and now live
under Requests. The original `/demo/agreement-templates` route is
preserved and `/demo/requests/templates` is a sibling alias used by the
new workspace cards. The Approvals landing page renders at
`/demo/approvals`; `/demo/approvals?workflow_id=<id>` is forwarded to
`/demo/approvals/workflows` so the gate-remediation deep links wired in
PR #60–#61 keep working. `/demo/inbox` / `/demo/approval-workflows` /
`/demo/approval-templates` / `/demo/approval-policies` continue to
resolve. The legacy `/demo/contracts[/:id]` URLs continue to render the
repository workspace.

**Did we adopt shadcn/ui?** No, deferred. The current Tailwind + local
primitives already match the calm, minimal aesthetic this pass wanted,
and shadcn carries a meaningful dependency footprint (Radix UI, CVA,
clsx, tailwind-merge, lucide-react) for a UX-only consolidation PR.
Local primitives plus the existing components keep the dependency
surface flat. A deeper design-system pass that introduces shadcn or a
similar primitive layer is tracked as follow-up work.

User-facing copy was also tightened:

- "Contracts" → "Repository" in headings, breadcrumbs, empty states.
- "Markdown preview" → "Text preview" in the workspace toggle and
  preview surfaces.
- "Original DOCX/PDF artifact" → "Original source file" in surfaces
  visible to legal end-users (developer/debug surfaces still say
  "artifact").

Backend models, APIs, and the on-disk artifact taxonomy
(`original_upload` / `generated_docx` / `signed_pdf`) are unchanged.

## Request → Repository conversion by upload (PR #65)

A request can now become a Repository contract via two intake paths,
not one:

1. **Template generation** (PR #48): the request's linked
   `AgreementTemplate` is rendered against user-supplied variable
   values to produce a `generated_docx` `ContractArtifact`.
2. **Uploaded file** (PR #65): the user uploads a third-party
   agreement file — counterparty paper, signed exhibit, or any
   external draft — and the file becomes the Contract's official
   `original_upload` `ContractArtifact`.

Both paths leave the request `linked_contract_id` set and resolve the
open `request_review` inbox item in the same transaction. The
upload-conversion path is exposed as:

```
POST /api/requests/{request_id}/convert-upload
Content-Type: multipart/form-data

file=<UploadFile>            # required (PDF or DOCX)
title=<str?>                 # optional Contract title override
counterparty_name=<str?>     # optional metadata
contract_type=<str?>         # optional metadata
notes=<str?>                 # optional free-text note (capped at 1000 chars)
```

The route reuses the existing `/api/contracts/upload` validation
(`_validate_upload` for empty / size / extension / magic-byte / MIME
checks; `_parse_or_http` for the parser layer) and the same
`DocumentStorage.store_encrypted` path. The new `ContractArtifact`
carries `source='request_upload'` and `metadata_json` with
`request_id` and `upload_source='request_conversion'`, plus
trimmed/capped copies of `counterparty_name` / `contract_type` /
`notes` for traceability. The same `create_markdown_snapshot_for_contract`
service produces the Text preview snapshot best-effort; conversion
failure is non-fatal and the response carries `markdown_snapshot=null`.

**Validation:**

- Cross-org request → 404.
- Cancelled request → 409.
- Already-converted request (`linked_contract_id` set) → 409.
- Missing / empty / unsupported / oversized file → propagates the
  same 4xx codes the existing `/api/contracts/upload` route returns.

**Transaction safety:** the entire orchestration runs inside the
request-scoped session managed by `get_db`. A failure at any step —
storage put, DB insert, request update — rolls the whole transaction
back: no partial `Contract` or `ContractArtifact` row, no
half-mutated `ContractRequest`, no stranded `InboxItem`. A storage
success without DB commit leaves only an orphan S3 blob, which
matches the existing `/contracts/upload` posture and is preferable to
a committed Contract row whose official artifact never landed.

**Approval gate / policies / DocuSeal:** the linked Contract flows
through the existing `can_send_contract_to_docuseal` gate via the
request's matching policies. PR #65 does **not** auto-create
approval workflows, mutate gate semantics, change state transitions,
or auto-send to DocuSeal. Approval visibility (PR #56) sees the new
contract through the request's `linked_contract_id` exactly the way
it does for template-generated contracts.

**Audit:** the route emits a new `REQUEST_CONVERTED_BY_UPLOAD`
(`request.converted_by_upload`) event into the existing hash-chained
audit log. Payload: `request_id`, `contract_id`, `artifact_id`,
`filename`, `mime_type`, `file_hash_sha256`, `size_bytes`. Storage
internals (`storage_key`, `wrapped_dek`, raw bytes) are intentionally
not recorded.

**Frontend:** the `RequestUploadConvertSection` component renders an
inline collapsible upload form per eligible row in `RequestsPage` —
hidden for cancelled requests and once `linked_contract_id` is set.
The Requests workspace landing adds an "Upload third-party agreement"
card. Demo mode wires the same flow through
`mockApi.convertRequestWithUpload` so the UI works without a backend,
and the `ConvertRequestUploadResponse` projection forbids storage
internals by construction (`extra='forbid'` plus allowlist-only
fields).

**Follow-ups:**

- Duplicate detection on convert-upload (the existing upload route
  refuses duplicate file hashes; PR #65 deliberately skips that so
  the request → repository intake isn't blocked by hash collisions
  with an unrelated counterparty contract). A clean shape would be
  to return 409 with a structured `existing_contract_id` and let the
  UI offer "link to existing".
- OCR / Docling fallback for scanned PDFs uploaded via the request
  intake path.
- Richer metadata extraction on uploaded contracts (the existing
  `/contracts/upload` route runs LLM extraction inline; this route
  lands at `status='ready'` without running extraction to match the
  template-conversion path's posture).
- Local-first PWA file-import polish so a user can drag the
  counterparty paper directly onto the request row.
- PowerSync sync rules covering `original_upload` artifact rows
  created via the request-conversion path.

These follow-ups are referenced from sections 9 and 11 too; this list is the canonical one for the approval stack.

## Upload-intake intelligence (PR #66)

PR #66 adds two cooperating, best-effort surfaces that fire on both
upload routes (`POST /api/contracts/upload` and
`POST /api/requests/{id}/convert-upload`) without changing what
those routes persist or how the rest of the system reads it:

### Deterministic metadata extraction

`app/services/contract_metadata.py` exports a single pure function
`extract_basic_contract_metadata(filename, mime_type, markdown_text,
plain_text)` returning an immutable
`ExtractedContractMetadata(suggested_title, likely_contract_type,
possible_counterparty_name, effective_date, warnings)`. It never
calls an LLM, never reaches the network, and never raises — invalid
input yields the empty result plus a `*_unknown` warning. The
heuristics are documented in the module docstring; in summary:

- **Title**: filename stem with separators normalized; Markdown H1
  fallback when filename is empty.
- **Contract type**: `\b`-anchored regex set, ordered so children
  (Amendment, SOW) win over their parents (MSA) when a body
  mentions both.
- **Counterparty**: "between X and Y" body match (case-sensitive
  party initials so "the parties" / "us" don't slip through) plus
  a filename pattern of `<agreement_token> - <name>`.
- **Effective date**: only trusted when within ~120 chars of a
  literal "effective date" / "effective as of" / "dated this"
  trigger. Standalone dates anywhere else in the body are too
  ambiguous and are ignored.

### Warning-level duplicate detection

`app/services/duplicate_detection.py` exports
`find_possible_duplicate_contracts(...)` returning a sorted, capped
list of `DuplicateCandidate(contract_id, title, reason, confidence,
created_at, status)`. Org-scoped only; the upload-in-progress is
excluded via `exclude_contract_id`. Reasons / confidences are closed
strings:

- `exact_file_hash` → `confidence='exact'`
- `similar_title_and_counterparty` → `confidence='possible'`
- `similar_title` → `confidence='possible'`

The new contract is **never** rejected because a duplicate exists.
PR #66 replaces the pre-existing hard-block 409 on
`/api/contracts/upload` with this warning-only mode. The frontend
renders a "Possible duplicate(s) in Repository" panel with deep
links into the matching rows.

### Integration

Both routes wire the services through small safe wrappers
(`_safe_extract_metadata`, `_safe_find_duplicates`) that swallow any
unexpected exception and return the empty result. The
`ContractUploadResponse` and `ConvertRequestUploadResponse` schemas
now carry `extracted_metadata` (optional) and `duplicate_candidates`
(default empty list). Storage internals never appear — the new
projection schemas use `extra='forbid'` plus allowlist-only
attributes.

Title precedence on both routes is now:
**user-provided > extractor's `suggested_title` > filename stem**.
The convert-upload path additionally honors
**form counterparty > request.counterparty_name > extractor
suggestion** for the artifact metadata, never overwriting the
request row itself.

### What did NOT change

- No new tables. Extracted metadata lives only in the response (and
  the artifact's `metadata_json` for the convert-upload path, which
  already had that field).
- Approval gate semantics and `can_send_contract_to_docuseal` are
  unchanged.
- DocuSeal send path is unchanged.
- No LLM, no OCR, no Docling, no PowerSync.
- Per-file hash uniqueness on the Repository upload route is now
  surfaced rather than enforced; cross-org isolation is preserved.

### Follow-ups

- Body-text shingle / near-duplicate hashing (today we only compare
  on file hash, normalized title, and counterparty).
- Duplicate merge / "link to existing" workflow (today we surface
  the candidate; the user is left to decide).
- OCR + Docling fallback so scanned PDFs feed the same extractor.
- Richer LLM-driven metadata correction with user confirmation.
- Operator-confirmed metadata write-back to `Contract` rows once
  the model carries `counterparty_name` / `contract_type`.
- PowerSync sync rules covering the new `duplicate_candidates`
  surface.

## Upload review + metadata confirmation (PR #67)

PR #67 puts a small confirmation UX on top of PR #66's extracted
metadata + duplicate-warning surfaces. Two new endpoints:

```
GET   /api/contracts/{contract_id}/metadata
PATCH /api/contracts/{contract_id}/metadata
```

The PATCH payload accepts any subset of `title`,
`counterparty_name`, `contract_type`, `effective_date`. Empty
strings clear the three non-title fields (`title` is non-nullable
on the Contract row and falls back to `"Untitled contract"`). The
response always carries the merged saved view plus a
`changed_fields` list so the UI can render a "Saved N fields"
confirmation.

### Storage placement (no schema migration)

- `title` → persisted on the existing `Contract.title` column.
- `counterparty_name` / `contract_type` / `effective_date` →
  persisted on the latest `original_upload`
  `ContractArtifact.metadata_json` dict, alongside the request-
  conversion fields PR #65 already writes there.
- No new tables. No new columns. Other artifact rows
  (`generated_docx`, `signed_pdf`) are not touched. File storage,
  wrapped DEKs, markdown snapshots, DocuSeal submission ids,
  approval workflows, and the gate are untouched.

### Audit

A new `CONTRACT_METADATA_UPDATED` (`contract.metadata.updated`)
event is appended to the org's hash-chained audit log when at
least one field actually changes. The payload carries only
`contract_id` + `changed_fields` (list of field names) — never the
old or new values. A no-op patch (same value as already stored)
emits no audit event.

### Frontend

A new `UploadReviewPanel` component renders on both upload
surfaces:

- `UploadPage` — after a successful Repository upload.
- `RequestsPage` row — after a successful request convert-upload,
  per request id.

The panel composes four sections: confirmation header, editable
metadata form, possible-duplicate warning (or quiet
"No obvious duplicates" line), and an "Open in Repository" deep
link. Duplicate dismissal is client-side only; nothing on the
backend ever auto-merges or deletes candidates.

### What did NOT change

- No LLM, no OCR, no Docling, no PowerSync.
- No approval-gate / DocuSeal behavior changes.
- No backend `Contract` model / API rename.
- No new audit-event old/new value capture.
- No duplicate merge / link-to-existing workflow yet.

### Follow-ups

- Duplicate merge / "link to existing" workflow.
- User-confirmed extraction history (today only the latest patch
  is captured via the audit row; values aren't journalled).
- OCR + Docling fallback for scanned uploads.
- PowerSync sync rules covering the new metadata surface.

## Repository detail polish + document lifecycle view (PR #68)

A UI/UX-only pass on the Repository detail page (`ContractWorkspacePage`).
No backend behavior, artifact semantics, approval gate semantics,
download priority, DocuSeal flow, or storage layout changed. The
goal: when a user opens a Repository record, they should immediately
understand what the agreement is, which document is official right
now, whether it was uploaded / generated / signed, and what the next
action is.

### Layout

The Repository detail page is now organized as stacked sections:

1. **Header** — title (sourced from the merged metadata view added in
   PR #67), status badge, contract type and counterparty when known,
   a one-line "Current document: <label>" hint, and the existing
   Download original primary action.
2. **Document lifecycle strip** — a four-card row showing the four
   slots the workspace cares about:
   - Source file (`original_upload`, with the `request_upload`
     source flavor rendered as "Uploaded agreement")
   - Generated Word document (`generated_docx`)
   - Signed PDF (`signed_pdf`)
   - Text preview (the Markdown working snapshot)
   Each card flips between a "present" / "missing" visual state and
   shows the artifact's added date and MIME label. Raw `artifact_type`
   enum values never appear in user-facing copy.
3. **Send to DocuSeal** — unchanged from PR #45 onwards. Still gated
   by the existing approval-gate response and the override surface
   from PR #54–#61.
4. **Preview** — the existing Markdown ↔ View original toggle plus
   the metadata/clauses/review sidebar tabs from prior PRs.
5. **Details** — read-only field list (Title, Status, Contract type,
   Counterparty, Effective date, Added, Last updated, Source). The
   Source field is filled in from a small whitelist of safe
   `metadata_json` keys via `pickPrimaryOriginCopy`:
   - `original_upload + user_upload` → "Uploaded directly"
   - `original_upload + request_upload` → "Converted from request upload"
   - `generated_docx` with `metadata_json.template_name` →
     "Generated from template “…”"
   - `signed_pdf` → "Signed through DocuSeal"
   An "Edit details" action reuses the existing `UploadReviewPanel`
   to invoke the PR #67 metadata PATCH endpoint; no new API surface.
6. **Activity** — unchanged: existing `ActivityTimeline`.
7. **Files** — listing of every `ContractArtifact` returned by the
   existing `GET /api/contracts/{id}/artifacts` endpoint. Each row
   shows the user-facing label, filename, MIME type, size, added
   date, source chip ("Uploaded" / "From request" / "From template"
   / "From DocuSeal"), and the origin sentence. The list reads only
   the safe fields already exposed by the schema — `storage_key` /
   `wrapped_dek` are not on the wire (see `app/schemas/artifacts.py`)
   and the `scrubSecrets` belt-and-suspenders in `lib/api.ts`
   guarantees the UI cannot render them even if a regression slipped
   them onto the response.

### Current document priority

The "Current document" hint and the lifecycle strip mirror the same
priority the backend download endpoint uses (see §6.2):

1. Signed PDF
2. Generated Word document
3. Source file
4. Legacy fallback (the workspace renders a quiet "Legacy original"
   notice for contracts that predate the artifact model)

`pickCurrentDocumentLabel(artifacts)` in `lib/artifacts.ts` is the
single source of truth on the frontend. Tests pin the priority order
so the UI cannot drift from the backend resolver.

### What did NOT change

- Artifact taxonomy or semantics
  (`original_upload` / `generated_docx` / `signed_pdf`).
- Download endpoint priority.
- Approval gate response shape or DocuSeal flow.
- Upload, request → upload conversion, or template generation paths.
- Markdown snapshot pipeline.
- The legacy `/demo/contracts[/:id]` route alias still resolves
  (and the workspace now also responds at `/demo/repository/:id`,
  matching the Repository navigation introduced in PR #63).

### Follow-ups

- Richer file comparison / redline view (artifact diff).
- Generated PDF preview alongside the DOCX.
- A deeper design-system pass (still tracked from the navigation
  consolidation PR).
- PowerSync sync rules covering the Repository detail surface.

## Artifact version history (PR #69)

PR #68 introduced the document lifecycle strip and the Files list.
PR #69 turns the Files list into a proper **Document history** —
still on the same Repository detail page, still backed by the same
`GET /api/contracts/{id}/artifacts` endpoint, but with explicit
chronological order, a single "Current document" marker, official
badges, allowlisted metadata chips, and a legacy-fallback row for
contracts that pre-date artifact tracking. No backend, schema,
download priority, or approval / DocuSeal semantics changed.

### Layout

The Document history section sits below the Activity timeline and
above no other section. Each row renders only safe fields:

- the user-facing artifact label (never the raw `artifact_type`);
- filename (truncated with a tooltip), MIME label, size, added date;
- source chip from the existing `artifactSourceChip` helper;
- origin sentence from `artifactOriginCopy`;
- metadata chips, restricted to an allowlist (`template_name`,
  `request_id`, `upload_source`, `docuseal_submission_id`,
  `signed_at`); and
- a "Current document" badge on the row representing the priority
  winner, and an "Official" badge on rows with `is_official = true`.

Rows are sorted by `created_at` (newest first) with an `id` tie-break
so the order is stable across renders. The legacy fallback path
renders a single row labelled "Legacy source file" with the same
"Current document" badge, so the section never collapses to an empty
panel.

### Current document marker

`isCurrentArtifact(a, artifacts)` in `lib/artifacts.ts` is the single
source of truth on the client. It mirrors the backend's download
priority exactly:

1. Signed PDF
2. Generated Word document
3. Source file (`original_upload`)
4. Legacy fallback (no `ContractArtifact` rows yet)

Tests pin the order so the marker cannot drift from the resolver in
`backend/app/api/contracts.py` (see §6.2). Per-artifact downloads are
exposed via the dedicated route added in PR #70 (see §6.5 below); the
header's "Download current document" action continues to resolve
through the contract-scoped endpoint and is unchanged.

### Safe metadata rendering

`safeArtifactMetadataChips(artifact)` is the only call site that
reads `metadata_json` values for display. It returns chips only for
allowlisted keys:

- `generated_docx` + `template_name` → "Template: <name>"
- `original_upload + request_upload` + `request_id` → "From request"
- `original_upload` + `upload_source = request_conversion` → "From
  request" (only if a `request_id` chip is not already present)
- `signed_pdf` + `signed_at` → "Signed <iso8601>"
- `signed_pdf` + `docuseal_submission_id` → "DocuSeal submission"
  (the raw submission id is never rendered)

Anything outside the allowlist — `notes`, `variable_keys`,
`variable_keys_blank`, `template_id`, `docuseal_event_id`, plus the
storage internals already stripped at the schema and api-client
layers — is dropped. Tests pin the allowlist and assert that the raw
`metadata_json` cannot reach the DOM.

### What did NOT change

- Backend: no new routes, no schema change, no migration. The
  existing `GET /api/contracts/{id}/artifacts` endpoint is reused
  as-is.
- Artifact semantics or taxonomy.
- Download priority (still resolved server-side; the UI just mirrors
  the order in the badge).
- Approval gate semantics, DocuSeal behavior, signature flow.
- Storage / encryption fields are not exposed in this surface
  (`storage_key` / `wrapped_dek` stripped at schema + `scrubSecrets`
  in `lib/api.ts`).

### Follow-ups

- Redline comparison view across artifact versions.
- Generated PDF preview alongside the DOCX.
- Artifact diff / version compare.
- Audit export covering both `contract.downloaded` and
  `contract.artifact_downloaded` events.
- PowerSync sync rules covering the Document history surface.

## Per-artifact download (PR #70)

`GET /api/contracts/{contract_id}/artifacts/{artifact_id}/download`
returns the bytes of a specific `ContractArtifact` version. The
Document History row's "Download version" button calls this route;
the header's "Download current document" action continues to use the
contract-scoped `GET /api/contracts/{id}/download` (§6.2) so changing
the priority winner does not require a UI update.

### Resolution + scoping

1. Resolve the contract by `(contract_id, organization_id)`. A miss
   returns 404 via the same `_get_contract_for_org` helper used by
   every other contract-scoped route.
2. Resolve the artifact by `(id, contract_id, organization_id)`. A
   miss on any of the three returns 404 — callers cannot distinguish
   "no such artifact" from "artifact belongs to another contract"
   from "artifact belongs to another org".
3. If the artifact has no retrievable storage metadata
   (`storage_key` empty / `"pending"`) or no wrapped DEK (neither on
   the artifact nor on the contract), return 409.

The endpoint does **not** fall back to `Contract.s3_key`. A request
for a specific `artifact_id` that cannot be retrieved is a clean
error, not a silent substitute.

### Decryption + headers

Decryption goes through the same `DocumentStorage.retrieve_decrypted`
path as `/download`. Per-artifact wrapped DEKs (e.g. `signed_pdf`
written by the PR #45 path) are honored; older artifacts decrypt
under `Contract.wrapped_dek`. The AAD is recovered from the artifact
storage key via `_document_id_from_storage_key`, falling back to
`str(contract.id)` for the legacy single-DEK case.

The response carries:

- `Content-Type` from `artifact.mime_type` (falling back to
  `contract.mime_type`).
- `Content-Disposition: attachment; filename="..."` from
  `artifact.filename` via `_download_filename`, which sanitizes the
  base name and caps it at 180 chars.

No presigned or private URLs are issued. `storage_key`,
`wrapped_dek`, and the raw bytes never appear in response headers or
the body's metadata.

### Audit

A successful per-artifact download writes a
`contract.artifact_downloaded` audit event with `contract_id`,
`artifact_id`, `artifact_type`, and `filename`. The contract-level
`/download` endpoint continues to write `contract.downloaded`, so the
two paths are distinguishable in the audit chain. Storage internals
and raw bytes are never persisted to the audit log.

### What did NOT change

- Default contract download priority (still `signed_pdf >
  generated_docx > original_upload > legacy`).
- Approval gate semantics or DocuSeal behavior.
- Artifact taxonomy, schema, or migrations.
- Storage internals exposure — `storage_key` and `wrapped_dek` are
  still stripped at the schema layer and re-scrubbed by the api
  client.

## Redline / version compare foundation (PR #71)

The Document History panel can produce a text-based **comparison**
between any two `ContractArtifact` rows on the same Repository
record. This is the foundation for the long-term redline workflow;
the v1 cut deliberately stays text-only and visibility-only. No
official DOCX redline is generated, no `redline` artifact is
persisted, and the extracted text never leaves the request scope.

### Endpoint + scoping

`POST /api/contracts/{contract_id}/artifacts/compare` takes
`{base_artifact_id, compare_artifact_id}` and returns a structured
diff payload. Resolution mirrors the per-artifact download endpoint
exactly so the same security invariants apply:

1. Resolve the contract by `(contract_id, organization_id)`. A miss
   returns 404 via the existing `_get_contract_for_org` helper.
2. Resolve each artifact by `(id, contract_id, organization_id)`
   through the same `_resolve_downloadable_artifact` helper used by
   `/artifacts/{artifact_id}/download`. Any miss returns 404 so
   callers cannot distinguish "wrong artifact" from "wrong
   contract" from "wrong org."
3. Each side's bytes are decrypted through the shared
   `_decrypt_artifact_bytes` helper (extracted from the download
   path in this PR). If `storage_key` is missing/`"pending"` or the
   wrapped DEK is missing, the route returns 409. No legacy
   `Contract.s3_key` fallback.

### Extraction + diff

Comparable text is produced by `extract_comparable_text` in
`app.services.artifact_compare`. It wraps the existing
`convert_document_to_markdown` (MarkItDown-backed) converter. There
is **no fallback** to `parse_document` / Docling / OCR / a remote
service / an LLM — if MarkItDown is not installed or cannot handle
the input, the route returns 422 with a user-facing message and the
frontend renders the error inline. Inputs are capped at 200,000
characters per side; longer documents are truncated with a
side-tagged warning (`base_text_truncated` /
`compare_text_truncated`).

The diff itself is `difflib.SequenceMatcher.get_opcodes()` walked
twice:

- Once over the full opcode stream to compute the wire summary
  (`added_lines`, `removed_lines`, `changed_blocks`,
  `unchanged_lines`).
- Once to emit `DiffBlock` rows. `equal` → `context`, `insert` →
  `added`, `delete` → `removed`, `replace` → `changed` (with
  alternating `removed` / `added` `DiffLine` children). Emission
  stops at `DEFAULT_MAX_LINES = 1_000`; truncation surfaces via
  the `diff_lines_truncated` warning. Summary counts remain
  accurate against the full diff.

### Response payload

The wire shape lives in `app.schemas.compare`. Each side returns
only safe metadata — `artifact_id`, `artifact_type`, a user-facing
`label` resolved by `artifact_compare_label` (which the frontend's
`compareOptionLabel` mirrors), `filename`, and `created_at`. No
`storage_key`, no `wrapped_dek`, no raw bytes, no `metadata_json`.

### Audit

A successful comparison appends a `contract.artifacts_compared`
event with the two artifact ids, the two artifact types, and the
add/remove/change line counts. The extracted text and storage
internals are never persisted to the audit log.

### Frontend

The `CompareVersionsPanel` lives inside the Document History
section and is only rendered when at least two artifacts exist for
the contract. Two dropdowns select base + compare; the Compare
button is disabled until two distinct artifacts are picked. The
result panel renders summary cards (Added / Removed / Changed
blocks / Unchanged) plus a monospaced unified diff. The panel is
labelled **Text comparison** — not "redline" — and points users at
the per-version download for a full Word redline. Stale results
disappear the moment the user changes a selection.

### What did NOT change

- Artifact taxonomy or schema. No `redline` row is created by this
  flow.
- Markdown snapshot persistence. The compare path does not write
  `ContractMarkdownSnapshot` rows; text extraction is on demand.
- Default download priority, per-artifact download semantics, or
  approval gate / DocuSeal behavior.
- Storage internals exposure — same scrub posture as the rest of
  the artifact surface.

### Follow-ups

- Official DOCX redline generation (true tracked-changes output)
  and a saved `redline` `ContractArtifact` once the operator
  experience is settled.
- Side-by-side viewer alongside the inline unified diff.
- Generated PDF preview alongside DOCX.
- Artifact diff / version compare beyond text (image-only PDFs,
  binary attachments).
- A Docling/OCR fallback for image-only PDFs — opt-in, with the
  same self-host / no-remote-service constraints as the rest of
  the conversion pipeline.
- Audit export covering `contract.downloaded`,
  `contract.artifact_downloaded`, and `contract.artifacts_compared`.
- PowerSync sync rules covering the compare surface.


### Repository document history PDF preview (PR #72 / #73)
- Added per-artifact preview endpoint: `GET /api/contracts/{contract_id}/artifacts/{artifact_id}/preview`.
- PDF artifacts are decrypted server-side and streamed inline as `application/pdf` with `Content-Disposition: inline`.
- DOCX artifacts are converted server-side to a temporary PDF preview via LibreOffice/soffice **when installed**; converted bytes are streamed inline and never persisted as a `ContractArtifact`.
- LibreOffice is optional for deployment overall: PDF previews work without it. Self-hosted operators who want DOCX preview must install LibreOffice/soffice on the backend host. No binaries are bundled or auto-downloaded.
- Conversion failures and missing-converter environments return a safe preview error (`PDF preview could not be generated for this file.`) and do not expose storage internals.
- Download remains available for retrievable artifacts and keeps existing priority/semantics.
- No storage internals (`storage_key`, wrapped keys, private URLs) are exposed.
- Service worker excludes `/api/*` from runtime caching, so authenticated preview responses/blobs are never cached.
- No OCR, Docling, LLM extraction, presigned URLs, or artifact-priority/approval-state-machine changes are introduced by this preview path.

## Compare UI, audit export, duplicate merge, test harness (PRs #74 – #77)

### PR #74 — Side-by-side version compare UI

Frontend-only follow-up to PR #71. The compare-result viewer in the
Document History section now renders the two selected artifact
versions side-by-side with explicit *Left version* / *Right version*
headers and clearer copy framing the output as a "text comparison
preview, not an official Word redline." Comparison response semantics
are unchanged (the existing diff endpoint output is reused).

### PR #75 — Activity timeline CSV / JSON export

- `GET /api/contracts/{id}/activity/export?format=csv|json` and
  `GET /api/requests/{id}/activity/export?format=csv|json`.
- Reuses the existing **sanitized** timeline projection added in
  PR #58 — there is no raw-audit query path. Cross-org IDs return 404.
- CSV output uses the standard library `csv` module with a fixed,
  allowlisted column order. JSON output is
  `{ export_type, generated_at, subject_type, subject_id, events }`.
- Hard cap at 1 000 events per export. Unsupported `format` → 422.
- Each export emits its own safe audit event
  (`contract.activity_exported` / `request.activity_exported`),
  excluded from the timeline being exported so the export action
  doesn't appear inside its own output.
- Frontend `ActivityExport` component renders CSV / JSON buttons in
  the Repository workspace and per-row in the Request activity panel.
  Export bytes go straight from `Blob` → anchor click and are never
  written into the DOM.
- Tests assert no `storage_key`, `wrapped_dek`, `s3_key`,
  `metadata_json`, document bytes, raw webhook payloads, DocuSeal
  secrets, or decision-note text appear in exported output.

### PR #76 — Duplicate-merge workflow foundation

- Migration `backend/alembic/versions/0016_contract_duplicate_merge.py`
  adds `merged_into_contract_id` + `merged_at` columns to `Contract`
  with org-scoped FKs.
- Service / API to mark a duplicate Repository record as merged into a
  canonical one. Artifacts are **reassigned** to the canonical record,
  not deleted; no `storage_key` / `wrapped_dek` is mutated.
- The default Repository list filters merged rows out
  (`?include_merged=true` to see them). The detail page still resolves
  for the merged source record and renders a *Merged into …* notice
  with a link to the canonical record.
- Safe audit event(s) on merge — no storage internals.
- Frontend duplicate-merge panel with a confirmation step. Mock/demo
  parity included so the flow exercises end-to-end against `mockApi`.

### PR #77 — Backend test harness cleanup

- Backend `pip install -e ".[dev]"` failed because `backend/pyproject.toml`
  referenced a missing `README.md`. That cascaded into `pytest-asyncio`
  never landing in the venv, which surfaced as misleading
  `Unknown config option: asyncio_mode` warnings and assorted
  async-fixture flakes in CI and locally.
- Fixes:
  - Added a real `backend/README.md`.
  - `backend/pyproject.toml`: set `asyncio_default_fixture_loop_scope = "function"`.
  - Updated a stale preview-audit test assertion left over from
    PR #73's schema change.
  - Fixed a clause-template fixture re-export and a sqlite-fallback
    table list that omitted `ClauseTemplate`.
  - `docs/local-developer-quickstart.md` got a backend-test section.
- Full backend suite: 694 passed, 3 skipped, 0 errors. **No
  runtime / API behavior changed.**

## UI polish pass (PRs #78 – #88)

A focused, frontend-only pass that brought every top-level surface up
to the same UX bar. Each PR was narrow, merged the same day, and
deployed to the hosted demo at `https://whereas.pages.dev/`. No
backend endpoints, approval state machine, gate semantics, artifact
priority, or DocuSeal behavior changed in this pass.

| PR | Surface | Headline |
|---:|---|---|
| #78 | Request detail | Real `/requests/:id` workspace mounted top-level (previously only at `/demo/requests/:id`). Mount-aware row links from the Request list. |
| #79 | Approvals | Live count cards on the landing page; dedicated `/demo/approvals/tasks` view filtered to `item_type=approval`; workflow rows show status pill, "Step N of M" progress, and source label (manual / from template / from policy). |
| #80 | Clause Manager | Loading / error / empty states, Active / Archived pill, *Add a clause* panel, copy-to-clipboard, metadata chips, two-step Archive confirm. Mock now soft-archives demo rows via a session override set so the flow demos correctly. |
| #81 | Repository list | Filter dropdown gains *Out for signature* and *Executed*; sort dropdown (Newest / Oldest / Title A→Z); *Show merged* toggle wired to PR #76's `?include_merged=true`; *Merged* chip on merged rows. `getContracts()` API client extended to accept the flag. |
| #82 | Dashboard | Conditional *Needs attention* banner for overdue items with a CTA to the right triage surface; grouped clickable count tiles (Request pipeline / Repository / Approvals / Inbox & templates); per-row deep links to the specific Request / Repository pages; loading skeleton. |
| #83 | Repository workspace | Lifecycle status banner above the Document Lifecycle strip — green *Executed* (with the signed-PDF date once artifacts load) when `status=executed`, info-toned *Out for signature* when `status=sent_for_signature`. Banner is informational; the header's *Download current document* button already prefers `signed_pdf` for executed contracts. |
| #84 | Inbox queue | Mount-aware row links to the related Request / Repository / Agreement template; item-type / status / priority chips; *Overdue* badge for open items past their due date; server-side `?item_type=` filter; better empty-state copy when filters yield no rows. |
| #85 | Approval Policies | Rewrote a previously minified one-line JSX page. Proper layout; status pill; criteria chips (Request type / Contract type / Priority / Agreement) with *Any* fallbacks; *Manual attach* chip when `auto_attach=false`; workflow-template name resolved from the templates list; two-step Archive confirm. Existing `?policy_id=` deep link preserved. |
| #86 | Sidebar | Red overdue-count badge next to *Approvals*, visible on every page. Sourced from the existing dashboard summary (`overdue_approval_steps`); best-effort fetch so the sidebar never blocks on it. `aria-label` uses correct singular / plural. |
| #87 | Agreement Templates list | Loading skeleton, Active / Archived pill, template-type chip, mount-aware row link to `/requests/templates/:id`, *Updated* date hint per row. `ErrorState` replaces the inline red text. |
| #88 | URL consistency | All internal `/demo/contracts/:id` link targets renamed to `/demo/repository/:id` across `ContractTable`, the merged-notice link, the post-generate CTA on `AgreementTemplateDetailPage`, duplicate-candidate links in upload feedback / review, and the post-upload CTA on `UploadPage` (also relabelled *Open contract workspace* → *Open in Repository*). Legacy `/contracts/:id` route alias preserved. |

### Cross-cutting hardening applied on every PR in the pass

- **Mount-aware links**: `mountedPath()` (and `demoPath()` for
  demo-only destinations) used consistently so each top-level
  standalone route AND the `/demo/*` workspace resolve the right
  targets without per-component branching.
- **Forbidden-string DOM guards**: every test poisons
  `storage_key`, `wrapped_dek`, `s3_key`, raw `metadata_json`,
  `private_url`, `presigned`, signer PII, and DocuSeal secrets, then
  asserts none appear in the rendered DOM.
- **Service worker `/api/*` denylist** verified in the built
  `dist/sw.js` on every PR.
- **Mock / demo parity** for every new UI capability so the hosted
  demo at `https://whereas.pages.dev/` (Cloudflare Pages auto-deploy
  on merge to `main`) reflects each PR end-to-end.
- **Standardized state components**: `LoadingSkeleton`, `ErrorState`,
  and `EmptyState` from `components/` replace per-page ad-hoc copy.
- **Two-step destructive confirm pattern**: established on Clause
  Manager (PR #80) and reused on Approval Policies (PR #85). No
  native `confirm()` dialogs; reveal *Confirm* + *Cancel* inline on
  click, send the request only on *Confirm*.
- **Status-pill pattern**: Active / Archived for templates / policies
  / clauses, plus workflow-run states (active / completed / rejected
  / cancelled), all using the existing Tailwind tokens with `/10` and
  `/40` opacity modifiers.

### Test harness note from the pass

The `App.test.tsx` `beforeEach` originally used
`fetchMock.mockResolvedValue(jsonResponse(...))`, which returns the
**same** `Response` object on every call. After PR #86 added a second
consumer of `fetch()` (the sidebar's dashboard-summary call), the
sidebar and the page both tried to read that single `Response` body
and only the first read succeeded. The fix was switching to
`mockImplementation(async () => jsonResponse(...))` so each call gets
a fresh `Response`. Apply the same pattern to any new top-level test
that mocks `fetch` globally and renders the full `App`.

