# Whereas Local-First PWA CLM Architecture Handoff

This document is the catch-up read for any developer (or new Claude Code session) joining Whereas after PRs #32–#47. It explains where the product is going, the architecture decisions we have already locked in, what shipped in each recent PR, the current domain model and end-to-end CLM loop, the live security and privacy rules, the known gaps, and the recommended next step.

It is intentionally long. Skim section 1 for product framing, section 2 for the load-bearing decisions, section 4 for what landed, section 5 for the live domain model, section 6 for the end-to-end CLM loop wired up by PRs #42–#45, section 7 for the Requests + Inbox layer added in PR #47, section 7.x for the request → contract conversion route added in PR #48, section 7.y for the dashboard summary added in PR #49, section 7.z for the approval workflow foundation added in PR #50, the approval workflow templates added in PR #51, **section 14 for the consolidated approval/policy/gate/visibility/timeline checkpoint as of PR #59** (the place to read first if you only have time for one), and section 11 for the next PR.

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

- **Approval system gaps** — see section 14.8 for the full list (richer gate remediation links, request approval timeline backfill, approval analytics, SLA / calendar reminders, RBAC for policy management and overrides, policy precedence/conflicts, policy reconciliation/removal, conditional/parallel approvals).
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

**Goal:** PR #59 lets the gate name the missing policy ("Standard Legal Review") but doesn't deep-link the user to the screens where they would either start or override the workflow. A small follow-up could add per-summary `remediation` hints (e.g. an `approval_workflow_template_url` and an `approval_policy_url`) so the panel can surface a "Start Legal Review" action without inventing routes in the frontend.

Suggested minimum scope:

- Extend `ApprovalGatePolicySummary` with two optional URL strings (or relative paths) that the backend renders deterministically from the existing `workflow_template_id` / `policy.id`.
- Frontend renders them as inline links from the missing-policy list. No new backend models; no new state.

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

- **Richer gate remediation links.** PR #59 lets the gate name the missing policy in `missing_policies[*].name`, but the UI still doesn't deep-link to the workflow-template or policy screens where the user would actually act on the block. Optional `approval_workflow_template_url` / `approval_policy_url` fields on the summary are tracked as future work.
- **Approval timeline backfill.** PR #58 starts recording approval audit events going forward. Workflow runs that existed before PR #58 do not have audit rows and will not appear on the timeline; a backfill pass is tracked as future work.
- **Richer timeline filters / export.** Today the timeline is a flat list with a server-side cap (default 25, max 100). Filters by event type, actor, date range, plus an exportable audit trail are tracked as future work.
- **Actor display names.** Audit rows carry `actor_user_id`; the timeline renders the id but not the human name. Joining users in the timeline projection is future work.
- **Signer-event mirror table.** Per-signer DocuSeal events (viewed / signed / declined) are not surfaced on the timeline today — only the contract-level `sent_for_signature` and `executed` events are. A `signer_events` table mirrored from DocuSeal webhooks is the right shape, future work.
- **Approval analytics.** Cycle time per template, average days-pending, top blocked approvers — once enough audit rows exist to be meaningful.
- **SLA / calendar reminders.** Pending-step due dates exist but nothing notifies anyone; calendar / Nango integration is the eventual home.
- **RBAC for policy management and gate overrides.** Today any caller in the org can create / archive policies or use `approval_override`. Override usage is audit-logged but not gated.
- **Policy precedence / conflicts.** Two matching policies that point at different workflow templates both auto-attach today; first-match precedence or explicit ordering is future work.
- **Policy reconciliation / removal.** If a request's fields change so that a previously-matching policy no longer matches, the policy-derived workflow is **not** removed. Reconciliation logic is future work.
- **Conditional / parallel approvals.** The model is strictly linear. Conditional skip predicates ("skip CFO if amount < $X") and N-of-M parallel groups are deliberate future work.
- **PowerSync sync rules.** The local-first sync layer hasn't been written; sync rules can lock in once parallel/conditional approval shapes settle.

These follow-ups are referenced from sections 9 and 11 too; this list is the canonical one for the approval stack.
