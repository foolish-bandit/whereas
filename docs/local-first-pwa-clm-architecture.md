# Whereas Local-First PWA CLM Architecture Handoff

This document is the catch-up read for any developer (or new Claude Code session) joining Whereas after PRs #32–#37. It explains where the product is going, the architecture decisions we have already locked in, what shipped in each recent PR, and the recommended next step.

It is intentionally long. Skim section 1 for product framing, section 2 for the load-bearing decisions, section 4 for what landed, section 5 for the live domain model, and section 9 for the next PR.

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
- Open original in Word or Google Docs.
- Choose a local vault/folder as an optional advanced mode (not implemented).

**Normal contract or template viewing must not trigger filesystem permission prompts.** Repeated permission prompts during day-to-day reading is a non-starter. Reading flows go through app/backend storage.

### 2.2 Markdown working representation

A lightweight Markdown snapshot is stored alongside every uploaded contract/template. It is the working representation used for:

- Fast preview.
- Search.
- Clause/playbook analysis.
- Future local-first sync.
- Future offline/local cache behavior.

Markdown is **not** the official legal artifact. Markdown can be regenerated, re-converted, or replaced; the user's original DOCX/PDF stays the source of truth.

### 2.3 Official legal artifacts

DOCX/PDF/signed PDFs remain official legal artifacts. They are tracked in dedicated artifact tables (`ContractArtifact`, `AgreementTemplateArtifact`) so the system can distinguish:

- `original_upload`
- `generated_docx`
- `signed_pdf`
- `redline`
- `exhibit`
- `attachment`

`is_official` flips per row. Append/versioned, not mutated. Original artifacts are never overwritten in place.

### 2.4 MarkItDown via the conversion abstraction

Microsoft MarkItDown is used through a conversion abstraction (`backend/app/services/document_markdown.py`) when it is importable. Order of attempts is MarkItDown → fallback plain text from the existing parser → failed. Conversion failure is non-fatal and **must never block upload**. The abstraction is the seam — do not pin Whereas to MarkItDown specifically.

**Docling** is a planned later fallback for complex PDFs, tables, and scanned documents. Not implemented yet.

### 2.5 PowerSync later, not now

PowerSync is the preferred future sync engine. Reasons it was chosen over Syncthing/IPFS:

- It fits Postgres-backed local-first sync naturally.
- It can sync structured app state into local SQLite on the client.
- It is better suited to CLM workflow/database state than peer-to-peer file sync.

Syncthing/IPFS are explicitly **not** the core app sync layer. They could be optional adapters someday, not foundations.

PowerSync sync rules will not be written until the domain model is stable across contracts, templates, artifacts, snapshots, and request/workflow objects (the request/workflow object family does not exist yet).

### 2.6 ContractPlaybookBuilder is inspiration, not foundation

ContractPlaybookBuilder is **not** imported as the app foundation. It may inspire a future Whereas Playbook Builder module that can:

- Upload a standard template.
- Upload negotiated examples of the same template.
- Parse and cluster clause variants.
- Generate fallback positions / playbook guidance.

Not implemented. Out of scope for the next several PRs.

---

## 3. Current Architecture After PR #37

### Backend

- FastAPI (`backend/app`).
- SQLAlchemy 2.0 async, Alembic migrations under `backend/alembic/versions/`.
- Postgres 16 with pgvector.
- MinIO / S3-compatible object storage via `app.services.storage.DocumentStorage`.
- Per-org wrapped DEK encryption for documents (`app.security.encryption`).
- Existing routers: contracts, playbooks, clause templates, QA, DocuSeal bridge, setup, agreement templates.
- Existing background concerns: extraction, clause segmentation, deviation findings, playbook review runs, audit log.

### Frontend

- React 18 + Vite + Tailwind.
- PWA app shell with service worker / manifest. **No** API or sensitive-route runtime caching.
- Markdown preview UI for contracts.
- Agreement Templates list + detail pages.
- Demo/mock mode (`isDemoMode()` + `mockApi.ts`).
- Defensive scrub of `storage_key`/`s3_key`/`wrapped_dek`/etc. on every API response.

---

## 4. PR-by-PR Implementation Summary (PRs #32 – #37)

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
- Download endpoint resolves in this order:
  1. The latest official `original_upload` `ContractArtifact`.
  2. Legacy `Contract.s3_key` / `mime_type` / title fallback.
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
- Demo/mock mode includes one template with Markdown + variables and one without (exercises empty state).

Important: variables are metadata only in this PR. No DOCX generation, no template filling, no DocuSeal send.

---

## 5. Current Domain Model

There are two object families today, with a likely third (Contract drafts generated from templates) arriving in PR #38.

### 5.1 Contracts

`Contract` is the legal/business record. Associated:

- `ContractArtifact` — official/source/generated files for a contract (original upload today; signed PDF / generated DOCX / redline / exhibit later).
- `ContractMarkdownSnapshot` — lightweight working Markdown preview, append-only.

The `Contract` row also still owns the legacy `s3_key`, `mime_type`, `file_hash_sha256` columns. Download prefers the artifact row and falls back to the legacy columns. PR #36 backfills the artifact row for older contracts.

### 5.2 Agreement Templates

`AgreementTemplate` is a reusable CLM template (NDA, MSA, SOW, DPA, employment, lease, other). Associated:

- `AgreementTemplateArtifact` — uploaded source template files; `generated_docx` / `preview_pdf` / `attachment` rows allowed but not produced yet.
- `AgreementTemplateMarkdownSnapshot` — template preview/search text.
- `AgreementTemplateVariable` — variable metadata for future generation. Unique on `(template_id, key)`.

### 5.3 Important distinction (read this before PR #38)

A **filled** template — i.e., a generated DOCX from an `AgreementTemplate` plus variable values — should become a `Contract` row with a `generated_docx` `ContractArtifact`, **not** another `AgreementTemplateArtifact`.

Why:

- Once a template is filled, it is a draft agreement.
- It belongs in the contracts repository, the dashboard, the future Inbox/workflows, future DocuSeal sending, and future review/playbook flows.
- Trapping generated agreements under `AgreementTemplate` would split CLM state across two parents and force every downstream feature to support both shapes.

This is the recommended direction for PR #38 (see section 9).

---

## 6. API Surface Added by PRs #32 – #37

### Contracts

- `GET /api/contracts/{id}/markdown` — latest ready Markdown snapshot.
- `GET /api/contracts/{id}/artifacts` — metadata-only artifact listing.
- The existing download endpoint is now artifact-backed with the legacy fallback described in PR #35.

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

---

## 7. Security / Privacy / Data Handling Rules

These rules are non-negotiable. Reviewers should reject changes that violate them.

- Do not expose `storage_key` (or `s3_key`, `wrapped_dek`, `wrapped_master_key`, `presigned_url`, `presigned_uri`) in any public API response.
- The frontend API client must defensively scrub the keys above on every response (`scrubSecrets` in `frontend/src/lib/api.ts`).
- Markdown conversion failure must not block upload.
- Failed Markdown snapshots must not be returned as ready previews — `/markdown` endpoints filter `conversion_status == "ready"`.
- The service worker must not cache `/api/*` or sensitive contract/template data. Verify with a quick scan of `dist/sw.js` after `npm run build`.
- Cross-org access returns 404 (the existing project convention).
- Original artifacts are official legal records. Markdown is the working representation. Do not mix them.
- Legacy `Contract` storage fields remain a fallback until a future, safe migration removes them. No PR has authority to remove them.
- Span citations remain mandatory for any extracted/derived information surfaced in the UI (see `docs/design-principles.md`).

---

## 8. Known Gaps / Follow-ups

Tracked, intentionally not implemented:

- DOCX generation from template variables.
- Generated DOCX should likely create `Contract` + `ContractArtifact` (see section 5.3).
- Send generated agreement to DocuSeal.
- Signed PDF artifact creation from DocuSeal callbacks.
- Original-on-demand viewer polish.
- Open-in-Word / Open-in-Google-Docs flows.
- Local vault/folder advanced mode.
- Docling fallback for complex PDFs / tables / scans.
- GFM table support in the Markdown renderer.
- Variable detection from Markdown/DOCX placeholders.
- PowerSync local-first sync rules.
- Clerk integration for local-first hosted mode (optional).
- Nango integration for optional third-party integrations (optional).
- ContractPlaybookBuilder-inspired Playbook Builder module.
- Backfill/archive cleanup and eventual removal of legacy `Contract` storage fields, only after a safe migration plan.

---

## 9. Recommended Next PR: PR #38 — DOCX Generation from Template Variables

**Goal:** allow users to generate a DOCX agreement from an `AgreementTemplate` and a set of `AgreementTemplateVariable` values, and surface the result in the contract repository.

### Recommended architecture

- New endpoint: `POST /api/agreement-templates/{template_id}/generate`.
- Resolve the latest official `original_upload` `AgreementTemplateArtifact` for the template.
- Validate variable values against the template's `AgreementTemplateVariable` rows (required, type, etc.).
- Generate DOCX using a simple placeholder syntax:
  - `{{counterparty_name}}`
  - `{{effective_date}}`
  - `{{governing_law}}`
- Prefer `docxtpl` if it adds cleanly; otherwise straight `python-docx` placeholder replacement. Keep the dependency footprint small and the implementation behind a clear seam (`app.services.template_render` or similar) so a richer engine can replace it later.
- Store the generated DOCX via the existing `DocumentStorage` (encrypted, per-org wrapped DEK, same path as contract upload).
- Create a new `Contract` record for the generated agreement.
- Create a `ContractArtifact` row:
  - `artifact_type = "generated_docx"`
  - `source = "template_generation"`
  - `is_official = true`
  - `metadata_json` includes `template_id`, `template_name`, and a safe (non-sensitive) summary of the variable values used.
- Run the existing Markdown conversion abstraction on the generated DOCX. If conversion produces ready Markdown, persist a `ContractMarkdownSnapshot` (same flow as contract upload).
- Return the generated contract ID and artifact metadata in the response (no `storage_key`).
- Frontend: add a Generate Agreement form on the template detail page, wired to the new endpoint, that on success deep-links into the new contract's workspace.
- **Do not send to DocuSeal yet.** That is PR #39 territory.

### Explicit reminder

Generated agreements should become **Contracts**, not remain trapped under `AgreementTemplate`, unless implementation complexity forces a temporary compromise. If a compromise is needed, it should be called out in the PR description with a tracked follow-up issue.

### Out of scope for PR #38

- DocuSeal send.
- Signed PDF flow.
- PowerSync.
- Clerk.
- Nango.
- Docling.
- Local vault mode.
- Open-in-Word.
- Variable auto-detection from the source document.

---

## 10. Testing Expectations

### Backend

```
cd backend
ruff check .
python -m pytest tests/<file>
```

The full suite may require heavy dependencies (`litellm`, `tesseract`, `tenacity`, `python-docx`, etc.) depending on the environment. In sandboxes that lack them, run only the test files relevant to the change. Pre-existing import failures in `tests/test_contracts_api.py` from missing `litellm` are **not** introduced by template/artifact PRs — confirm and call out in the PR description.

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
grep -E "/api|api/contracts|api/agreement-templates" frontend/dist/sw.js || echo "no API routes precached"
```

The service worker must not include API routes in its precache or runtime cache rules.

---

## 11. Developer Notes / Guardrails

Read these before starting any new feature work.

- Keep PRs narrow. One product-visible behavior change per PR is the target.
- Do not jump to PowerSync until the domain model is stable across contracts, templates, artifacts, snapshots, and request/workflow objects.
- Do not make browser filesystem access part of ordinary viewing flows.
- Do not mutate original uploaded templates. They are official artifacts.
- Do not overwrite official artifacts. Append/version instead.
- Keep the self-hosted Docker behavior working at all times. `docker compose up` must remain a valid first run.
- Avoid adding cloud-only dependencies to core self-hosted mode. Cloud-only features should be additive, optional, and clearly disclosed.
- Clerk and Nango should be optional adapters introduced later. Do not bake either into core code.
- No service-worker caching of sensitive API responses.
- Span citations are mandatory for any surfaced extracted information. See `docs/design-principles.md`.
- LiteLLM is the only LLM seam — no provider-specific imports in feature code.
- AGPL posture: no per-file headers, no proprietary loadable modules, no vendor-privileged hooks.
- Telemetry stays off by default. No phone-home, no anonymous stats, no "just a heartbeat."

When in doubt about an architectural choice, ask before coding. A short clarifying question is always cheaper than ripping out a wrong design.
