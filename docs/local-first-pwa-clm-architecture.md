# Whereas Local-First PWA CLM Architecture Handoff

This document is the catch-up read for any developer (or new Claude Code session) joining Whereas after PRs #32–#45. It explains where the product is going, the architecture decisions we have already locked in, what shipped in each recent PR, the current domain model and end-to-end CLM loop, the live security and privacy rules, the known gaps, and the recommended next step.

It is intentionally long. Skim section 1 for product framing, section 2 for the load-bearing decisions, section 4 for what landed, section 5 for the live domain model, section 6 for the end-to-end CLM loop wired up by PRs #42–#45, and section 10 for the next PR.

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

## 3. Current Architecture After PR #45

### Backend

- FastAPI (`backend/app`).
- SQLAlchemy 2.0 async, Alembic migrations under `backend/alembic/versions/` (latest: `0011_contract_artifact_wrapped_dek.py`).
- Postgres 16 with pgvector.
- MinIO / S3-compatible object storage via `app.services.storage.DocumentStorage`.
- Per-org wrapped DEK encryption for documents (`app.security.encryption`); per-artifact DEKs for `signed_pdf` rows from PR #45 onward.
- Existing routers: contracts, playbooks, clause templates, QA, DocuSeal bridge, setup, agreement templates.
- DocuSeal bridge router (`app/api/docuseal_bridge.py`) now exposes a verified `POST /webhook` endpoint that materializes `signed_pdf` artifacts and flips contract status to `EXECUTED`.
- Existing background concerns: extraction, clause segmentation, deviation findings, playbook review runs, audit log.

### Frontend

- React 18 + Vite + Tailwind.
- PWA app shell with service worker / manifest. **No** API or sensitive-route runtime caching.
- Markdown preview UI for contracts and templates.
- Agreement Templates list + detail page with **Generate Agreement** and **Send to DocuSeal** controls.
- Demo/mock mode (`isDemoMode()` + `mockApi.ts`) covers generation, send, and signed-state surfaces.
- Defensive scrub of `storage_key`/`s3_key`/`wrapped_dek`/etc. on every API response.

---

## 4. PR-by-PR Implementation Summary (PRs #32 – #45)

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

---

## 5. Current Domain Model

There are now three object families wired into a single CLM loop.

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

### 5.3 Generated agreements live as Contracts

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

## 7. API Surface Added by PRs #32 – #45

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

Tracked, intentionally not implemented:

- Requests / Inbox / workflow module (CLM intake/work queue layer). See section 10.
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
- Backfill/archive cleanup and eventual removal of legacy `Contract` storage fields, only after a safe migration plan.

---

## 10. Recommended Next PR: PR #46 — Requests + Inbox Foundation

**Goal:** create the CLM intake / work queue layer that the rest of the product is missing. This is the layer that lets a non-lawyer at a company say "I need an NDA with X" and have it land somewhere a lawyer can see, triage, assign, and convert into a contract.

### Recommended scope

- New `Request` records: who asked, for what, when, optional template hint, free-text description, status (`OPEN | IN_PROGRESS | BLOCKED | CONVERTED | CANCELLED`), optional due date, assignee.
- New `InboxItem` records (or a view over `Request` + `Contract` + `signed_pdf` arrivals — TBD; ask before choosing): the per-user work queue surface.
- Assignment / status / due date editing endpoints.
- Basic dashboard counts ("3 open requests assigned to you", "1 awaiting countersignature").
- A path to **convert a request into a contract** later — this can be a stub in PR #46 (e.g., create a contract from a chosen template via the existing generate endpoint, link it back to the request) and grow over time.

### Out of scope for PR #46

- **Do not implement PowerSync yet.** The domain model is still settling; PowerSync sync rules belong to a later PR once Requests/Inbox stabilize.
- Clerk and Nango.
- Calendar/integration layer.
- Rich DocuSeal status dashboard.
- Local vault mode.
- Generated PDF preview.

### Architecture asks (raise these before coding)

- Is `InboxItem` its own table, or is it a derived view over `Request` + `Contract` events? Both are defensible; ask before choosing.
- Should a `Request` carry a foreign key to `AgreementTemplate` (the user's intent at intake) or only to a converted `Contract` (the result)? Likely both, but confirm.
- How does the existing audit log (`backend/app/security/audit_log.py`) fit? A request transitioning state is auditable.

---

## 11. Testing Expectations

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
grep -E "/api|api/contracts|api/agreement-templates|api/docuseal-bridge" frontend/dist/sw.js || echo "no API routes precached"
```

The service worker must not include API routes in its precache or runtime cache rules.

---

## 12. Developer Notes / Guardrails

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
