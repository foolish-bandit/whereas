# Whereas

**The open-source contract repository.**

Built-in clause extraction, playbook deviation analysis, and embedded e-signature via DocuSeal.

> Note: Whereas is currently pre-v0.1 and not ready for production use. If you want to follow along or contribute, watch this repo and read CONTRIBUTING.md.

---

## What it does 

Whereas is a self-hostable contract management system aimed at small and mid-sized legal teams who don't want their contracts living on someone else's server. It covers the post-execution side of contract lifecycle management:

- **Repository.** Upload contracts (.docx, .pdf, scanned PDFs via OCR). Search across the corpus. Permission-scope by user and team.
- **Metadata extraction.** On upload, an LLM extracts parties, effective date, term, governing law, contract value, renewal terms, and termination provisions — every field accompanied by a span citation back to the source document and a confidence score.
- **Clause segmentation.** Contracts are segmented and tagged against the CUAD taxonomy (41 clause types). You can extend the taxonomy.
- **Playbook deviation.** Define your firm's positions in YAML (e.g., "indemnification cap ≤ 12 months fees"). Whereas flags clauses that deviate, with severity and a suggested redline.
- **Q&A over your corpus.** RAG-based question answering scoped to user permissions.
- **Embedded e-signature.** DocuSeal runs alongside Whereas in the same Docker Compose. Send contracts for signature without leaving the app.

What Whereas is **not** (yet): a drafting tool, a Word/Outlook plugin, a negotiation/redlining workflow, or a SaaS. Those may come in later versions or never.

## Working representation: DOCX/PDF + Markdown snapshots

Whereas is moving toward a **PWA-first, Markdown-as-working-copy** architecture:

- The **DOCX or PDF you upload remains the original legal artifact.** Signed PDFs from DocuSeal are the source of truth for execution.
- On upload, Whereas also stores a lightweight **Markdown working snapshot** (`ContractMarkdownSnapshot`) for fast preview, search, clause analysis, and future local-first sync. Snapshots are append-only; the latest is fetched via `GET /api/contracts/{id}/markdown`.
- The frontend ships as an installable PWA. Browser file access (the File System Access API) is used **only** for explicit import, export, "save generated DOCX," and "open original in Word/Google Docs" workflows. **Normal contract previews never trigger filesystem permission prompts** — they read from app/backend storage.
- Markdown conversion uses Microsoft MarkItDown when installed and falls back to the existing extracted plain text otherwise. Conversion failure is non-fatal: the upload still succeeds and the original remains downloadable.
- **The contract workspace defaults to the Markdown preview** when one is available. It's optimized for skimming, search, and the future local-first sync layer. Use **"View original"** in the document header to switch to the plain-text view used for clause / metadata / finding span citations, or **"Download original"** to retrieve the underlying DOCX/PDF as the official artifact.
- Original legal artifacts are tracked explicitly in a `ContractArtifact` model alongside the Markdown working snapshot. The original upload is recorded with `artifact_type='original_upload'` and `is_official=true`; future PRs add generated DOCX, signed PDFs from DocuSeal, redlines, and exhibits as additional artifact rows. The metadata list is exposed via `GET /api/contracts/{id}/artifacts`. Markdown snapshots remain the lightweight working representation; artifacts remain the official legal record.
- **Backfilling existing contracts:** contracts created before artifact tracking landed only have the legacy `Contract.s3_key` / `mime_type` / `file_hash_sha256` columns. Download falls back to those columns when no `original_upload` artifact exists, but operators should run the backfill once after deploying so the artifact row is the source of truth:

  ```sh
  # Dry run — report what would be created without writing anything.
  python -m backend.scripts.backfill_contract_artifacts --dry-run

  # Real run.
  python -m backend.scripts.backfill_contract_artifacts

  # Optionally scope to a single organization.
  python -m backend.scripts.backfill_contract_artifacts --organization-id <uuid>
  ```

  The script is idempotent: it skips contracts that already have an `original_upload` artifact and contracts with no legacy storage key. The legacy `Contract` columns are retained as a fallback and are not removed by the backfill.
- **Agreement templates are first-class CLM objects.** Operators upload an NDA/MSA/SOW/DPA/etc. as an `AgreementTemplate`; the original DOCX or PDF is stored as an official `AgreementTemplateArtifact` (`is_official=true`, `artifact_type='original_upload'`) and the same Markdown converter that runs on contracts produces a working `AgreementTemplateMarkdownSnapshot` for fast preview and future local-first sync. Conversion failure is non-fatal: the upload still succeeds and the original remains the authoritative file.
- **Templates can generate draft DOCX agreements.** `POST /api/agreement-templates/{id}/generate` takes a title and a `variable_values` map, renders the original template via [docxtpl](https://docxtpl.readthedocs.io/) (Jinja-style `{{counterparty_name}}` placeholders that survive Word's split-run XML), and produces a *new* draft `Contract` row plus a `generated_docx` `ContractArtifact` (`source='template_generation'`, `is_official=true`). The original uploaded template is never mutated. A Markdown working snapshot is generated when the converter succeeds; conversion failure is non-fatal. Sending the agreement out for signature happens later from the Contract workspace, not from the template page.
- **Generated DOCX agreements can now be sent to DocuSeal.** `POST /api/contracts/{id}/send-to-docuseal` accepts a `signers` list and hands the latest official artifact to the DocuSeal peer service for signature collection. Resolution order: latest `generated_docx` (so a draft generated from a template wins), then latest `original_upload`, then the legacy `Contract.s3_key` for unbackfilled contracts. Whereas decrypts the artifact in-process and POSTs the bytes to DocuSeal as base64 — a presigned S3 URL would only ever serve ciphertext, so the trust boundary stays in Whereas. The DocuSeal submission id is recorded on the `Contract` row, the contract status flips to `sent_for_signature`, and an audit event (`contract.sent_for_signature`) is appended with `contract_id`, `artifact_id`, `filename`, and `signer_count` — no `storage_key`, no `wrapped_dek`. Token-shaped fields in the upstream response are scrubbed before being echoed back to the client. Signing is initiated from the Contract workspace, not from the template page; the generated `ContractArtifact` is the document that goes out.
- **DocuSeal completion materializes a `signed_pdf` artifact.** `POST /api/docuseal/webhook` is the public completion endpoint DocuSeal POSTs when a submission finishes. Verification matches DocuSeal's documented format: `X-Docuseal-Signature` is `"{timestamp}.{hex_hmac}"` where the HMAC-SHA256 is taken over `"{timestamp}.{raw_body}"` keyed on `DOCUSEAL_WEBHOOK_SECRET`. Header lookup is case-insensitive. Timestamps older or further-future than 5 minutes are rejected, closing the replay window. As an interim path while operators bring up DocuSeal versions that don't emit signed webhooks, the literal value of the configured secret may be sent in `X-Whereas-Docuseal-Webhook-Secret` — but **only** when no `X-Docuseal-Signature` is present, so a known shared secret cannot bypass an invalid HMAC. Both paths require `DOCUSEAL_WEBHOOK_SECRET`. Production deployments without it reject every webhook; development emits a warning and accepts unsigned bodies, which is the only place that path exists. To configure: set `DOCUSEAL_WEBHOOK_SECRET` on the Whereas backend and configure the same value as DocuSeal's webhook signing secret. On a verified completion event the receiver: looks up the contract by `docuseal_submission_id`, fetches the signed PDF from DocuSeal's `/api/submissions/{id}/documents/combined` endpoint, encrypts and stores the bytes under a fresh per-artifact wrapped DEK (see migration `0011`), creates a `signed_pdf` `ContractArtifact` (`source='docuseal'`, `is_official=true`, `metadata_json` carries `docuseal_submission_id` / `docuseal_event_id` / `signed_at`, no signer PII), flips the contract status to `executed`, and appends a `contract.executed` audit event. **Idempotent**: a duplicate completion event for the same `(contract_id, docuseal_submission_id)` is a no-op. Irrelevant events (`viewed`, `created`, etc.) and unknown submission ids return 202 without mutating state, so DocuSeal will not retry-storm against us.
- **Download resolution prefers the signed PDF.** `GET /api/contracts/{id}/download` resolves the official artifact in this order: latest `signed_pdf`, then latest `generated_docx`, then latest `original_upload`, then the legacy `Contract.s3_key` column. Once a contract has been executed, the signed PDF is the official record. Per-artifact wrapped DEKs (signed PDFs only, in v1) are honored; legacy artifacts continue to decrypt under `Contract.wrapped_dek`. `storage_key` and `wrapped_dek` are never exposed in any response.
- **Variable validation is small and explicit.** The backend rejects unknown keys (HTTP 400), enforces `required` variables, accepts `text` / `boolean` / `number` / `money` / `select` / `date` (`YYYY-MM-DD`) types with light coercion, and validates `select` values against `metadata_json.options` when present.
- **Generated artifact metadata stores variable *keys*, not *values*.** The artifact's `metadata_json` records `template_id`, `template_name`, `variable_keys`, `variable_keys_blank`, and `generated_at`. Plaintext values (counterparty names, dates, dollar amounts) are *not* persisted there — they're already in the rendered DOCX, which is encrypted at rest and only retrievable through the authenticated contract download endpoint. Don't reach into `metadata_json` looking for the values that filled the template; fetch the DOCX.
## Stack

- **Backend:** Python 3.11, FastAPI, SQLAlchemy, Alembic
- **Database:** Postgres 16 with pgvector
- **Storage:** S3-compatible (MinIO by default for self-host)
- **LLM abstraction:** LiteLLM (default target: Ollama running locally; BYOK for any OpenAI-compatible provider)
- **Embeddings:** BGE-M3 via Ollama or a hosted endpoint
- **Frontend:** React + Vite + Tailwind
- **E-signature:** DocuSeal, deployed alongside Whereas, sharing Postgres
- **Auth:** Whereas-native (Argon2id + sessions). SSO is post-v0.1.

## License

Whereas is licensed under **AGPL-3.0-or-later**. See [LICENSE](LICENSE).

If you modify Whereas and run it as a network service, you must make your modifications available under the same license. If you want a commercially-licensed version (no copyleft obligations), get in touch.

The name "Whereas" and any associated logos are not covered by the AGPL — see [TRADEMARK.md](TRADEMARK.md) for the trademark policy. You can fork the code freely; you cannot ship a fork called "Whereas."

## Quickstart (local dev)

Requires Docker and Docker Compose.

    git clone https://github.com/foolish-bandit/whereas.git
    cd whereas
    ./scripts/generate-secrets.sh   # generates .env with random secrets
    # edit .env if you want to change LLM provider; defaults to local Ollama
    docker compose up -d

Whereas will be available at `http://localhost:8080`. DocuSeal at `http://localhost:8081`. The API at `http://localhost:8000`.

For production deployment, read [docs/deployment-guide.md](docs/deployment-guide.md) before exposing this to the internet. There are non-negotiable hardening steps that the local quickstart skips.

For the security architecture and threat model, see [docs/security-model.md](docs/security-model.md).

For frontend-only development (without the full Docker stack), see
[frontend/README.md](frontend/README.md). The frontend dev server runs on
`http://localhost:5173` and expects the backend at `VITE_API_BASE_URL`
(default `http://localhost:8000`).

For an end-to-end local setup (infra + backend + frontend + first-run
workspace), see [docs/local-developer-quickstart.md](docs/local-developer-quickstart.md).

On first run, open the app, go to **Settings**, and click
**Create local development workspace**. That creates an organization, a
wrapped master key, and an active user, and stores the dev user UUID in
your browser. The endpoint backing this (`POST /api/setup/dev`) is
disabled when `ENVIRONMENT=production`.

A hosted UI preview, running in demo mode against fictional sample data,
is at **https://whereas.pages.dev/**. No real contracts; nothing uploaded
there is sent anywhere.

## Project status

- [x] Repo scaffold
- [ ] Document upload + storage
- [ ] Metadata extraction with span citations
- [x] Clause segmentation (v1: heuristic, exact-span grounded — see note below)
- [ ] Playbook YAML schema and deviation engine (schema + loader landed; deviation engine pending)
- [ ] DocuSeal integration (embedded + auth bridge)
- [ ] RAG Q&A
- [ ] Permissioning model
- [ ] First tagged release (v0.1)

## Navigation (UI)

The web UI is organized as a CLM workspace, not a database-table list.
Top-level navigation:

- **Dashboard** — `/demo/dashboard`. At-a-glance counts and recent
  activity. A "Needs attention" banner surfaces overdue approval steps
  / inbox items when present. Count tiles are grouped (Request
  pipeline / Repository / Approvals / Inbox & templates) and each one
  is a link to the matching surface. Recent-activity rows deep-link
  to the specific Request / Repository record.
- **Repository** — `/demo/repository` (legacy `/demo/contracts` still
  resolves). All agreements, drafts, signed documents, and contract
  records, backed by the same backend `Contract` APIs. The list
  supports status (including *Out for signature* and *Executed*),
  type, and sort filters, plus a *Show merged* toggle (`?include_merged=true`)
  with a *Merged* chip on rows that have been merged into another.
  Per-contract workspace at `/demo/repository/:id` shows a status
  banner above the Document Lifecycle strip when the contract is
  executed or out for signature, the document history, per-artifact
  download / preview / compare, the *Send to DocuSeal* panel
  (gated by the approval workflow), and the activity timeline +
  CSV/JSON export.
- **Requests** — `/demo/requests`. The natural place to start work.
  The list surface offers *New request*, *Start from template*,
  *Upload third-party agreement*, *Agreement templates*, and the
  *Request queue*. Each Request has a detail workspace at
  `/demo/requests/:id` with intake metadata, approval status,
  matching Approval Policies, active Approval Workflows, conversion
  actions, linked Repository context, activity timeline, and export
  controls. A request becomes a Repository record by either generating
  from an `AgreementTemplate` (PR #48) or uploading a third-party
  file (PR #65). Both paths set `linked_contract_id` and resolve the
  open `request_review` inbox item in the same transaction.
  Agreement-template management lives under `/demo/requests/templates`
  (legacy `/demo/agreement-templates` still resolves).
- **Playbooks** — `/demo/playbooks`. Review standards, fallback
  positions, and deviation rules for contract review.
- **Clause Manager** — `/demo/clause-manager` (legacy `/demo/clause-library`
  still resolves). Approved clauses, fallback language, and reusable
  drafting guidance. Workspace shows an *Add a clause* panel,
  server-side `clause_type` filter + client-side text search,
  expandable clause text, copy-to-clipboard, an Active / Archived
  pill, metadata chips (clause type, jurisdiction, contract type,
  tags), and a two-step Archive confirm. Archive is still soft-delete
  via the existing endpoint.
- **Approvals** — `/demo/approvals` landing with cards for *Approval
  tasks*, *Approval workflows*, *Approval templates*, and *Approval
  policies*. Cards show live counts pulled from the dashboard summary.
  `/demo/approvals/tasks` is a dedicated, approval-typed inbox with
  Review / Mark complete / Dismiss row actions; `/demo/approvals/workflows`
  renders workflow runs with a status pill, "Step N of M" progress,
  source label (manual / from template / from policy), and
  Request / Repository link buttons. The policies page lays out
  matching criteria as chips ("Any" fallbacks) and gates archive
  behind a two-step confirm. Approval gate, workflow state machine,
  and policy matching semantics are unchanged from PR #50–#62.
  Legacy `/demo/approval-workflows`, `/demo/approval-templates`,
  `/demo/approval-policies`, and `/demo/inbox` routes still resolve;
  the `/demo/approvals?workflow_id=<id>` and `?policy_id=<id>` deep
  links wired in PR #60–#61 are preserved.
- **Settings** — `/demo/settings`. Workspace configuration.

The sidebar surfaces an **overdue-approvals badge** next to the
*Approvals* entry (PR #86), best-effort, so an overdue review is
obvious from anywhere in the app.

Two work-queue surfaces sit under their respective workspaces rather
than the top-level nav:

- `/demo/approvals/tasks` — approval-typed inbox items only, with
  mount-aware links into the related Request / Repository / workflow
  context (PR #79).
- `/demo/inbox` — the generic work-queue across all `item_type`s
  (request_review, signature_followup, metadata_cleanup, general),
  polished in PR #84 with mount-aware deep links, type / status /
  priority chips, an *Overdue* badge, and an item-type filter.

Nothing about the backend `Contract` / `Approval` / `Template` models
or their HTTP endpoints changed in the recent UI polish work; the
legacy aliases above are preserved for stability of external deep
links and bookmarks.

## UI polish pass (PRs #78–#88)

A focused, frontend-only pass that brought every top-level surface
up to the same UX bar: loading skeletons, friendly error / empty
states, status pills, metadata chips, two-step destructive confirms,
mount-aware deep links, and forbidden-string DOM guards. No backend
endpoints, approval state machine, gate semantics, artifact
priority, or DocuSeal behavior changed.

| PR | Surface | Headline |
|---:|---|---|
| #78 | Request detail | Real `/requests/:id` workspace (was demo-mounted only). Mount-aware row links from the Request list. |
| #79 | Approvals | Live count cards on the landing page; dedicated Approval Tasks view; workflow rows show status pill, "Step N of M" progress, and source label. |
| #80 | Clause Manager | Loading / error / empty states, Active / Archived pill, "Add a clause" panel, copy-to-clipboard, metadata chips, two-step Archive confirm. |
| #81 | Repository list | Filter dropdown gains *Out for signature* and *Executed*; sort dropdown; *Show merged* toggle wired to `?include_merged=true`; *Merged* chip. |
| #82 | Dashboard | Conditional "Needs attention" banner for overdue items; grouped clickable count tiles; per-row deep links to specific Request / Repository records; loading skeleton. |
| #83 | Repository workspace | Lifecycle status banner above the Document Lifecycle strip — green *Executed* with the signed-PDF date, info-toned *Out for signature* otherwise. |
| #84 | Inbox queue | Mount-aware row links, item-type / status / priority chips, *Overdue* badge, item-type filter, better empty-state copy. |
| #85 | Approval Policies | Rewrote a previously minified one-liner: proper layout, status pill, criteria chips with "Any" fallbacks, two-step Archive confirm. |
| #86 | Sidebar | Red overdue-count badge next to *Approvals*, visible on every page; best-effort fetch so the sidebar never blocks on it. |
| #87 | Agreement Templates list | Loading skeleton, Active / Archived pill, type chip, mount-aware row link to `/requests/templates/:id`, *Updated* date hint. |
| #88 | URL consistency | All internal `/demo/contracts/:id` link targets renamed to `/demo/repository/:id`. Legacy alias preserved. |

Cross-cutting hardening on every PR in this pass:

- Mount-aware links via `mountedPath()` / `demoPath()` helpers so each
  top-level standalone route AND the `/demo/*` workspace render the
  right targets.
- Tests poison `storage_key`, `wrapped_dek`, `s3_key`, raw
  `metadata_json`, `private_url`, `presigned`, signer PII, and
  DocuSeal secrets, and assert none appear in the rendered DOM.
- Service worker `/api/*` denylist verified in the built `dist/sw.js`
  on every PR.
- Mock / demo parity maintained — every new UI capability also works
  end-to-end against `mockApi` so the hosted demo at
  `https://whereas.pages.dev/` reflects it.
- Loading / error / empty states standardized via `LoadingSkeleton`,
  `ErrorState`, and `EmptyState`.
- A two-step "open confirm → confirm action" pattern for destructive
  row actions, established on Clause Manager (PR #80) and reused on
  Approval Policies (PR #85).

## Approval Task detail page (PR #99)

Approval Tasks now have a dedicated detail / action page at
`/demo/approvals/tasks/:id` so an approver can understand and act on
a single pending approval task without hopping through the workflow
list.

Sections on the page:

- **Header**: breadcrumb (*Approvals → Tasks → title*), task title,
  status pill, *priority* and *overdue* indicators (when applicable),
  created / due dates.
- **What am I approving?**: a one-line explanation of the action
  required (*"You are being asked to approve step N of M: <title>"*),
  plus mount-aware links to the related Request, Repository record,
  and the parent Approval Workflow when present.
- **Context cards**: separate cards for the linked Request, Repository
  record, and Approval Workflow (with *"<name> · <status> · Step N of
  M"*). No document bytes are fetched or rendered here.
- **Action panel**:
  - For approval-type tasks with an actionable current step: Approve /
    Reject buttons that reuse the existing
    `approveApprovalStep` / `rejectApprovalStep` API client. An
    optional decision-note textarea is included; the note is sent
    only when non-empty and matches the existing API contract — the
    approval state machine is unchanged.
  - For non-approval tasks (e.g. `request_review`, `contract_review`):
    *Mark complete* / *Dismiss* buttons reusing the existing inbox
    update / delete clients.
  - Completed or dismissed tasks render a read-only state ("No
    further action is available from this page"). The page never
    shows approve / reject controls on a non-actionable task.
  - After a successful action the page refreshes the task and
    workflow and shows next-step guidance.
- **Defensive rendering**: the parent workflow is loaded
  best-effort. If the workflow fetch fails (404 / 500), the page
  still renders the task header and explains that the workflow
  could not be loaded — the approve / reject buttons are hidden so
  no half-actionable surface appears.

The existing `/demo/approvals/tasks` list page gained a per-row
*Open detail* link to reach the new page; the legacy `/inbox`
alias is unchanged.

Allowlisted `metadata_json` projection: only `workflow_run_id` and
`approval_step_id` are read from the inbox item's metadata; the raw
dict is never rendered. No storage internals, raw `metadata_json`,
document bytes, private URLs, signer PII, or DocuSeal secrets appear
in the DOM — asserted by a forbidden-string scan in the test suite.

Frontend-only — no backend changes. No approval state machine,
gate, policy matching, DocuSeal flow, request workflow, or
artifact-priority changes.

## Approval Workflow detail page (PR #98)

Approval Workflows now have a dedicated detail page at
`/demo/approvals/workflows/:id` so a user can inspect one workflow
in context — its status, attached Request / Repository record,
progress, ordered steps, and related activity timeline — without
expanding-inline-in-the-list.

Sections on the page:

- **Header**: breadcrumb (*Approvals → Workflows → name*), workflow
  name, status pill, *Source* label (*From template* / *From policy:
  <name>* / blank for manual) derived from existing allowlisted
  metadata.
- **Attached to**: mount-aware links to the related Request and/or
  Repository record. Manual workflows render a clear *"Not attached
  to a Request or Repository record"* message.
- **Progress**: *Step N of M* for active runs, *N of M approved*
  otherwise. Current step name + due / *overdue* badge when active.
- **Steps**: ordered timeline. Current step is highlighted with an
  info tone. Each step shows its status pill, approver name + email
  (when set by the variable / template), due date, decided-at, and
  a small *decision note recorded* indicator when one is present —
  the note text itself is NOT rendered on this page (presence-only,
  per PR #98 brief). The existing inline view on the list page
  still renders full note text and is unchanged.
- **Workflow actions**: Approve / Reject buttons appear on the
  current pending step; a *Cancel workflow* button (two-step
  confirm) on active runs. Reuses the existing
  `approve / reject / cancel` API client. Terminal workflows
  (completed / rejected / cancelled) render *"No further action"*.
- **Related activity**: reuses the existing `ActivityTimeline`
  component anchored on the related Request when present, else the
  Repository record. The dedicated approval-detail page never
  queries raw audit rows.

Per-row *Open detail* links were added to the existing
`/demo/approvals/workflows` list page so users can reach the new
detail from the list. Existing *Show steps* inline expand and the
`?workflow_id=` deep-link expansion behavior are preserved.

Frontend-only — no backend changes. No approval state machine,
gate, policy matching, DocuSeal flow, request workflow, or
artifact-priority changes.

## Pre-generation review step (PR #97)

The *Generate agreement* action on a template detail page is now a
two-step flow. Click **Review generation** in the variable form to
open an inline review panel that summarizes what's about to happen:

- *Required filled* / *Required missing* / *Optional blank* counts
- Per-variable rows with status chips (*Filled* / *Blank* /
  *Missing*) and a short preview of the user-entered value (kept
  in-component only — never persisted, never logged)
- A clear *Result:* line ("this will create a Repository record
  with a Generated Word document")
- A privacy note: variable values are sent only to generate the
  agreement and are **not** stored in template metadata

If any required field is missing the panel still opens, but the
panel's final *Generate agreement* button is disabled and a
*"Fill missing required fields before generating."* message
appears. A *Back to edit* button reopens the form. The actual
generation endpoint is only called when the panel's final button
fires, and the success state (link to the new Repository record,
filename hint) renders in place of the panel.

Frontend-only; no backend changes. The existing generation
endpoint, request body shape, generated-artifact priority,
DocuSeal flow, and approval gate are all unchanged.

## Agreement Template variable detection (PR #96)

Uploading a template DOCX is now lower-friction: instead of typing
each variable into the builder by hand, the detail page surfaces
the placeholders it found in the Text preview and lets the user add
them as `AgreementTemplateVariable` rows in one click.

- **Backend** — new service
  `app.services.template_variable_detection.detect_variable_suggestions(text)`
  is a deterministic regex extractor. It matches `{{ identifier }}`
  shape only (`[A-Za-z_][A-Za-z0-9_]*` between Jinja-style braces),
  trims whitespace, lowercases keys, dedupes with an `occurrences`
  count, and rejects expressions / filters / dotted attribute
  access / function calls / subscripts. No LLM, no remote service.
- **Endpoint**: `GET /api/agreement-templates/{id}/variable-suggestions`.
  Org-scoped (cross-org → 404). Reads the latest *ready*
  `AgreementTemplateMarkdownSnapshot` for the template; if there's
  no snapshot, returns an empty list (a "no preview yet" state on
  the same page, not an error). Keys already present as variables
  are filtered server-side so the list only carries *new*
  suggestions. Response is just `{key, label, occurrences}` per
  row — no extracted-text snippets, no storage metadata.
- **Frontend**: a *Detected placeholders* sub-section on the
  template detail page lists each suggestion with its key, label,
  occurrence count, a *Required* toggle, and an *Add as variable*
  button. Adding a suggestion creates the variable via the existing
  `POST .../variables` endpoint and removes that key from the
  suggestions list immediately. Existing variables are never
  overwritten — the backend filter + the client-side state update
  both make sure of that.
- **Empty state**: *"No placeholders detected."* when the
  extractor returns nothing. The section degrades gracefully if
  the suggestions endpoint fails (treated as empty).

## Agreement Template source file history (PR #102)

Agreement Template detail pages
(`/demo/agreement-templates/:id`, `/demo/requests/templates/:id`)
now carry a *Source file history* section that lists every
source-file upload for the template, newest first, with a small
*Current* chip on the version operators distribute.

- The section is view-only. Per-version download and side-by-side
  compare are intentional future work — adding them requires a
  scoped per-artifact-version download endpoint with its own
  audit-log entry.
- The history is derived from the existing
  `GET /api/agreement-templates/{id}/artifacts` response, filtered to
  `artifact_type === "original_upload"`. The raw `artifact_type`
  taxonomy never reaches the DOM — labels go through the
  shared `artifactDisplayLabel()` helper so the UI shows *"Source
  file"* instead of leaking backend tokens like `original_upload` or
  `generated_docx`. Generated artifacts (e.g. `generated_docx`) are
  excluded from this section by construction.
- *Current* is the most recent `is_official=true` row, falling back
  to the most recent row when none is flagged.
- No backend changes. No new exposure of storage internals,
  `metadata_json`, document bytes, private URLs, or DocuSeal
  artifacts — asserted by a forbidden-string DOM scan in the test
  suite.

Existing *Template source file* upload affordance, *Text preview*,
*Variables*, *Generate*, and *Archive* sections behave exactly as
before. Template generation, approval, DocuSeal, and Repository
artifact semantics are unchanged.

## Repository search match hints (PR #101)

Repository search results now carry a small categorical hint so users
know *why* a record matched.

- **Backend**: `ContractListItemResponse` gained an optional
  `search_match_source: "title" | "text_preview" | "title_and_text_preview" | null`.
  When the list endpoint is called with `?q=…` each row's hint is
  computed from two booleans — title ILIKE hit + correlated snapshot
  EXISTS hit — that already drove the PR #100 search predicate. The
  field is `null` when `q` is absent or whitespace-only. The raw
  matched snippet is **not** exposed; the field is a closed enum.
- **Frontend**: `ContractTable` renders a tiny *"Matched title"* /
  *"Matched Text preview"* / *"Matched title + Text preview"* chip
  next to the status badge whenever the field is set; missing /
  null values render no chip at all. URL `?q=`, debounce,
  status/sort/show-merged filters, mount-aware links, and the
  legacy `/contracts` alias are unchanged.
- **Mock parity**: the demo `getContracts({ q })` mock also
  annotates `search_match_source` per row from the same two
  booleans so demo mode behaves consistently.

No artifact-priority / DocuSeal / approval-workflow / approval-gate /
approval-policy / duplicate-merge / request-status semantics changed.
No raw Text preview content, document bytes, `metadata_json`,
private URLs, or storage internals are exposed.

## Repository Text-preview search (PR #100)

The Repository search box (`/demo/repository?q=…`) now matches the
record title **or** any attached Text preview content
(`ContractMarkdownSnapshot.markdown_text`).

- **Backend**: `GET /api/contracts?q=…` now matches `Contract.title`
  OR an org-scoped `ContractMarkdownSnapshot` body. The Text-preview
  match is a correlated `EXISTS` against
  `contract_markdown_snapshots`, filtered by the caller's
  `organization_id`, so cross-org snapshot rows can never widen
  results. Multiple matching snapshots for the same contract collapse
  to a single row. `%` / `_` characters in the user query are escaped
  literally (same as PR #95). The list response shape is **unchanged**
  — only the existing `ContractListItemResponse` fields are returned,
  so a matched record never leaks the body of its Text preview,
  storage internals, document bytes, `metadata_json`, private URLs,
  or any DocuSeal artifacts.
- **Frontend**: placeholder copy and no-matches description now
  mention *"title or Text preview"*. URL `?q=` deep-link seeding,
  debounce, status / sort / *Show merged* filters, and the legacy
  `/contracts` alias all behave exactly as before.
- **Mock parity**: the demo mock `getContracts({ q })` also matches
  against `MOCK_MARKDOWN_BY_CONTRACT_ID[id].markdown_text` so the
  demo behaves consistently. No raw body is returned by the mock
  list either.
- **Future work**: result ranking, server-rendered snippet highlights,
  and Postgres-native FTS indexes are intentionally out of scope.
  External search services, embeddings, OCR / Docling, and LLMs are
  not used by this search path.

No artifact-priority, DocuSeal, approval-workflow/gate/policy, or
duplicate-merge semantics changed.

## Repository search foundation (PR #95)

The Repository list at `/demo/repository` now supports an org-scoped
title search via `?q=…`.

- **Backend**: `GET /api/contracts` gained an optional
  `q: str` query param. Match is a case-insensitive substring against
  `Contract.title` only — no JSON-path queries, no `full_text` scan,
  no storage metadata in the predicate. The merged-record filter is
  unchanged: rows merged into another record stay hidden by default
  unless `include_merged=true`. Cross-org isolation is preserved by
  the same `WHERE organization_id = …` clause that gates every read
  in this module. `%` / `_` characters in the user query are
  escaped so they're matched literally rather than as SQL LIKE
  wildcards.

- **Frontend**: the existing search input on the Repository list is
  now wired to the backend `q` param and to the URL — typing
  debounces 250 ms, then commits to `?q=…` (replace-state, so the
  back button skips keystrokes). A deep link like
  `/demo/repository?q=acme` initializes the box with that query and
  the first fetch already includes it. A small *clear* affordance
  inside the input and a *Clear search* CTA in the empty state both
  reset to the unfiltered list. The page distinguishes two empty
  states: *"The repository is empty"* when no records exist AND
  no filter is active; *"No matches"* (with *Clear search*) when a
  filter is active.

- Status / type / sort / *Show merged* filters keep their existing
  client-side or query-param behavior and stack with `q`.

- **Future work**: extracted Text-preview / full-text search is
  deliberately not wired in this PR — adding it requires either a
  Postgres full-text-search index or careful ILIKE-on-`full_text`
  semantics, and the foundation here is title-only by design.

No backend semantic changes elsewhere — artifact priority, download
preview, DocuSeal flow, approval gate, request/workflow state
machine, and duplicate-merge behavior are untouched.

## Agreement Template builder polish (PR #94)

The Agreement Template detail page (`/demo/requests/templates/:id`,
legacy `/demo/agreement-templates/:id`) is now organized into
discrete sections so a non-engineer can scan and act without reading
the whole page or feeling like they're editing a backend record:

- **Header**: name, *Active / Archived* status pill, template-type
  chip, updated date, breadcrumb (*Requests → Agreement Templates →
  …*) using `mountedPath()` so both the demo and any future
  standalone mount resolve correctly.
- **Template source file**: upload affordance plus a user-friendly
  artifact list — labels go through `artifactDisplayLabel()` so
  uploaded sources read as *"Source file"* rather than the raw
  `original_upload` enum.
- **Text preview**: existing Markdown renderer; empty state now
  uses the shared `EmptyState` component.
- **Variables**: required variables float to the top, each row
  shows a *Required* chip when applicable, and help text + variable
  key + variable type appear inline. No raw JSON.
- **Generate agreement**: variable form groups *Required* fields
  before *Optional* ones; clicking *Generate agreement* with blanks
  surfaces a clear *"Missing required fields: …"* warning instead
  of silently disabling the button. A privacy note next to the form
  documents that the values you enter are only sent to the
  generation endpoint to render the agreement — they are **not**
  stored on the template itself. Success state links to the new
  Repository record (via `/repository/:id`, mount-aware).
- **Archive**: two-step confirm on active templates only; the
  section disappears on already-archived templates.

What's gone: the raw `metadata_json` `<pre>` dump at the bottom of
the page; the *"Generate DOCX"* label that exposed `generated_docx`;
the inline artifact-type enum names in the source-file list.

Backend untouched: template generation semantics, generated-agreement
artifact priority, Repository / Contract naming, DocuSeal flow,
approval gate, request workflow state machine — all preserved.

## Paragraph-aware redline diff (PR #93)

The comparison engine that powers the on-screen compare, the
*Export redline (DOCX)* download, and the *Save to Document History*
artifact now diffs at the **paragraph** level instead of raw lines.

Why: contracts get wrapped differently when they round-trip through
DOCX, PDF, and markdown converters — even when the prose is
identical. A line-based diff treats every wrap-column shift as a
change and produces noisy redlines. The new splitter (in
`app.services.artifact_compare._split_paragraphs`) splits on
blank-line boundaries, collapses internal whitespace runs (including
embedded single newlines) to single spaces, and drops empty
paragraphs. The result is a redline that reads like a legal summary:
unchanged paragraphs collapse to a muted "… N unchanged paragraphs
…" indicator; added / removed paragraphs are clearly marked; and a
changed paragraph renders with explicit *Before:* and *After:*
sub-labels in the DOCX so a reviewer can scan the swap.

Wire shape stays compatible. The existing
`ArtifactCompareResponse.diff_blocks[].lines[].text` field now
carries a whole paragraph; the rest of the schema, the field names
in `DiffSummary`, and the saved-redline `metadata_json` written by
PR #91 are unchanged. The DOCX renderer (`compare_report_docx`)
swapped the user-facing labels from *"Added lines"* to *"Added
paragraphs"*, gained per-block section headings, and uses *Before /
After* for changed paragraphs.

Still:

- No LLM, no OCR / Docling, no remote service. Deterministic diff
  on top of `difflib.SequenceMatcher`.
- Still **not** a Word tracked-changes file. The disclaimer in the
  DOCX and the compare panel still says so.
- No backend semantic changes beyond the diff granularity: the
  artifact-priority chain, DocuSeal flow, approval gate, request
  state machine, and the redline persistence + lineage from
  PRs #91 / #92 are untouched.

## Redline linkage in Document History (PR #92)

When a saved redline (PR #91) appears in Document History, the row
now shows the two source artifacts it was derived from:

```
Redline of: Source file ↔ Signed PDF
```

The linkage is resolved client-side from the redline's allowlisted
`metadata_json` (`base_artifact_id` / `compare_artifact_id` /
`*_artifact_type`), looked up against the contract's current
artifact list. If a source artifact is no longer present in the list
(deleted, archived) the side falls back to its type label and is
marked `(removed)` so the row is still readable. Frontend-only;
no backend or schema changes.

## Persisted redline (PR #91)

PR #90 shipped on-demand redline export — download a comparison
report DOCX and forget. PR #91 adds the opt-in companion: **Save to
Document History** persists the same rendered DOCX as a `redline`
`ContractArtifact` on the contract, so collaborators can find it
later via the existing Document History list and per-artifact
download endpoint (PR #70).

What landed:

- `POST /api/contracts/{contract_id}/artifacts/compare/save` — same
  resolution rules and scoping invariants as the export endpoint.
  Encrypts the rendered DOCX via the existing `DocumentStorage`
  pipeline with a fresh per-artifact wrapped DEK (matching the
  `signed_pdf` pattern from PR #45) and writes a `ContractArtifact`
  row with `artifact_type="redline"`, `is_official=false`,
  `source="comparison_report"`.
- **Download priority unchanged**: the saved redline is deliberately
  not "official" AND its `artifact_type` is not in
  `DOWNLOADABLE_ARTIFACT_TYPES_BY_PRIORITY`. The default *Download
  current document* action keeps preferring
  `signed_pdf` → `generated_docx` → `original_upload`.
- New audit event `contract.artifact_redline_saved` recording the
  contract, the new artifact id, the two source artifact ids/types,
  the diff summary counts, and `format=docx`. Allowlisted only —
  never the extracted text, the diff text, storage internals, or
  signer PII.
- `metadata_json` on the saved row is also allowlisted (same shape
  as the audit details, no text).
- Frontend: new **Save to Document History** button next to *Export
  redline (DOCX)*. After a successful save, the compare panel shows
  a confirmation with the filename, and `getContractArtifacts` is
  re-fetched so the new redline row appears in Document History
  without a full page reload.
- Mock / demo parity: the demo persists the synthetic redline in a
  session-scoped map so the new row shows up on the next list
  fetch, mirroring real-backend behavior.

## Redline export foundation (PR #90)

The Document History compare panel on a Repository workspace now
exposes an **Export redline (DOCX)** action next to the existing
*Compare selected versions* button. Selecting two versions and
clicking export downloads a `.docx` **comparison report** generated
server-side from the same text-extraction + diff pipeline that
powers the on-screen compare (PR #71).

Honest framing: this is **not** a Word tracked-changes
(`w:ins` / `w:del`) file. Generating a faithful tracked-changes DOCX
from arbitrary text input is error-prone — paragraph boundaries,
table cells, and formatting all complicate it — and a half-broken
file is worse than no file. The first paragraph of the rendered DOCX,
and the copy next to the button in the UI, both make that explicit.
Each unchanged line is plain text; each removed line is red +
strikethrough; each added line is green + underlined; long runs of
unchanged text are collapsed to a muted "… N unchanged lines …"
indicator so the report stays focused on actual differences.

What landed:

- `POST /api/contracts/{contract_id}/artifacts/compare/export` —
  same resolution rules and scoping invariants as the existing
  `POST .../compare` endpoint. Cross-org / wrong-contract → 404;
  unretrievable storage metadata → 409; either side
  un-extractable → 422. On success the response is
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  bytes with `Content-Disposition: attachment` and a sanitized
  `<contract-title>-comparison-report.docx` filename.
- New service `app.services.compare_report_docx` renders a
  `DiffResult` to DOCX bytes via `python-docx`. No tracked-changes
  XML manipulation; no LLM; no OCR / Docling; no remote service.
- New audit event `contract.artifacts_compare_exported` recording
  the contract, the two artifact ids / types, the line-count
  summary, `format=docx`, and the byte count. No extracted text,
  no storage internals, no signer PII.
- **No persistence**: the DOCX bytes are returned to the caller and
  forgotten. No new `ContractArtifact` row is written, no download
  priority changes, no DocuSeal / approval-state behavior changes.

Frontend:

- Export button next to *Compare selected versions* in the Document
  History compare panel. Disabled until two distinct versions are
  selected; explicit "Preparing redline…" pending state; safe error
  surface if the export endpoint returns a 4xx / 5xx.
- Mock / demo parity — the hosted demo at `https://whereas.pages.dev/`
  triggers a real download, but the body is a plain-text comparison
  report rather than a real DOCX (the renderer is server-only).

## Upload-intake intelligence (PR #66)

Repository uploads and request-conversion uploads now return two
small blocks of *visibility* alongside the persisted Contract:

- **Extracted metadata** — a deterministic, no-LLM, no-OCR pass over
  the filename + parsed body text. Surfaces a suggested title,
  likely contract type (NDA, MSA, SOW, DPA, Amendment, …), possible
  counterparty (when a "between X and Y" line or a recognizable
  filename pattern matches), and an effective date when one appears
  immediately after the literal phrase "effective date" / "as of".
  Conservative by design: weak input yields ``null`` + a
  ``*_unknown`` warning rather than a guess. Explicit user input
  always wins; suggestions only fill the gaps.
- **Duplicate candidates** — warning-only list of existing
  contracts in the same org that look like the new upload. Exact
  file-hash matches are flagged ``confidence='exact'``; same
  normalized title (optionally plus counterparty) is
  ``confidence='possible'``. Cross-org rows never appear; storage
  internals are never surfaced. Previous releases hard-blocked
  exact-hash matches with a 409; the new policy returns 201 + the
  candidate list so the UI can warn without taking the decision
  away from the user.

Both features are best-effort: extraction or duplicate-lookup
failures are logged and swallowed so the upload itself never
blocks. The approval gate, DocuSeal flow, and existing artifact /
markdown-snapshot semantics are unchanged.

## Upload review + metadata confirmation (PR #67)

After an upload or request-conversion lands, the UI shows a
**Review upload** panel:

- **Confirm details** — editable inputs for title, contract type,
  counterparty, and effective date, pre-filled with the saved
  values when present and otherwise with the PR #66 suggestions.
  Saving via the ``Save details`` button calls
  ``PATCH /api/contracts/{id}/metadata`` and reflects the new
  ``saved`` state in place.
- **Possible duplicates** — when PR #66 surfaced candidate
  duplicates, the panel renders a warning with deep-links to each
  matching record and a ``Keep as new record`` action that just
  dismisses the warning client-side. No automatic merge or delete
  happens at any point.
- **Open in Repository** — a quick deep-link into the new contract's
  workspace.

The new endpoint persists ``title`` on ``Contract.title`` and the
other three fields on the latest ``original_upload`` artifact's
``metadata_json`` — no schema migration. Empty strings clear the
non-title fields; ``title`` always falls back to ``"Untitled
contract"`` if blanked, matching the upload route's posture. Audit
events record only the list of changed field names — never the old
or new values — and storage / encryption fields are not part of
this surface.

## Repository detail polish + document lifecycle (PR #68)

Opening a Repository record now lands on a cleaner workspace
organized around the agreement's document lifecycle:

- **Header** — title, status, contract type, counterparty, a
  "Current document: <label>" hint, and the existing Download
  original action.
- **Document lifecycle strip** — four slots showing whether each
  artifact stage is available: Source file, Generated Word document,
  Signed PDF, and the working Text preview. Each card shows the
  added date and MIME label when present, or a quiet "Not yet
  available" line when not.
- **Send to DocuSeal** — unchanged.
- **Preview** — the existing Markdown / View original toggle and
  metadata / clauses / review tabs.
- **Details** — read-only metadata (title, status, contract type,
  counterparty, effective date, source) with an *Edit details*
  action that reuses the PR #67 upload-review form.
- **Activity** — the existing chronological event timeline.
- **Document history** — every ``ContractArtifact`` recorded against
  the Repository row, newest first. Each row shows the user-facing
  label, filename, MIME, size, the added date, a source chip, and
  the origin sentence. The row representing the priority-winning
  artifact (signed PDF > generated DOCX > original upload) is marked
  *Current document*; official artifacts are marked *Official*. When
  a contract pre-dates artifact tracking, a single legacy fallback
  row stands in for the listing.

User-facing labels never expose raw artifact_type names:

| Artifact                                  | Label                       |
| ----------------------------------------- | --------------------------- |
| ``original_upload`` (user_upload)         | Source file                 |
| ``original_upload`` (request_upload)      | Uploaded agreement          |
| ``generated_docx``                        | Generated Word document     |
| ``signed_pdf``                            | Signed PDF                  |
| ``redline``                               | Redline                     |
| ``attachment``                            | Attachment                  |

The "Current document" label mirrors the existing backend download
priority (``signed_pdf > generated_docx > original_upload > legacy
fallback``); it is computed entirely on the client from the existing
``GET /api/contracts/{id}/artifacts`` response. No backend, schema,
or download priority changed.

## Artifact version history (PR #69)

The **Document history** section on the Repository detail page
surfaces every safe ``ContractArtifact`` row for a contract — source
uploads, generated Word documents, signed PDFs, redlines, and
attachments — in a chronological list (newest first). The row
representing the priority-winning artifact is marked **Current
document**, mirroring the backend download priority exactly; only one
row carries the marker at any time. When the contract has no
artifacts at all, a single **Legacy source file** row stands in for
the listing and explains that the file was stored before artifact
tracking landed.

Each row renders only safe fields:

- user-facing artifact label (never the raw ``artifact_type``);
- filename, MIME label, size, added date;
- a source chip (``From DocuSeal`` / ``From template`` / ``From
  request`` / ``Uploaded``); and
- an allowlisted set of metadata chips: template name, originating
  request, signed-at timestamp, and a short "DocuSeal submission"
  marker. The raw submission id, template id, internal variable
  keys, user-provided notes, ``storage_key``, and ``wrapped_dek``
  are never rendered.

No backend changes were required for this PR: the existing
``GET /api/contracts/{id}/artifacts`` endpoint already returns the
safe field set (``storage_key`` and ``wrapped_dek`` are stripped at
the schema layer and re-scrubbed in the api client). The frontend
allowlists which ``metadata_json`` keys are rendered.

Follow-ups tracked: redline comparison view, generated PDF preview,
artifact diff / version compare, audit export, and PowerSync sync
rules.

## Per-artifact download (PR #70)

The Document History rows added in PR #69 now expose a **Download
version** button that retrieves a specific ``ContractArtifact``
version — the source upload, a generated Word draft, a signed PDF, a
redline, an exhibit, or an attachment. The header's **Download
current document** action is unchanged and continues to resolve the
priority-winning document (``signed_pdf > generated_docx >
original_upload > legacy``); the per-version button is for retrieving
*a specific* artifact rather than whatever currently wins.

Backend:

- ``GET /api/contracts/{contract_id}/artifacts/{artifact_id}/download``
  is org + contract scoped. The artifact must match
  ``artifact_id``, belong to this contract, and belong to the same
  organization — any miss returns 404 (no oracle on "wrong
  contract" vs. "wrong org"). An artifact with no retrievable
  storage metadata returns 409; this endpoint does **not** fall
  back to ``Contract.s3_key``.
- Decryption uses the same storage path as the existing contract
  download endpoint. Per-artifact wrapped DEKs (e.g. ``signed_pdf``)
  are honored; legacy artifacts continue to decrypt under
  ``Contract.wrapped_dek``. The AAD is recovered deterministically
  from the artifact storage key.
- A dedicated ``contract.artifact_downloaded`` audit event is
  written on success — distinct from ``contract.downloaded`` —
  with ``contract_id``, ``artifact_id``, ``artifact_type``, and
  ``filename``. ``storage_key``, ``wrapped_dek``, and raw bytes are
  never recorded.
- No presigned or private URLs are issued, and no storage
  internals are returned in response headers or body.

The current/default download priority and the
``GET /api/contracts/{id}/download`` endpoint are unchanged by this
PR; only the per-version surface is new.

Follow-ups tracked: text-based version comparison (delivered in PR
#71, below), official DOCX redline generation, generated PDF preview,
side-by-side viewer, artifact diff / version compare, audit export,
and PowerSync sync rules.

## Redline / version compare foundation (PR #71)

The Document History panel can now produce a **text comparison**
between any two ``ContractArtifact`` versions on the same Repository
record. The action lives under the version list: pick a *base* and a
*compare* version, click **Compare**, and the panel renders an
added/removed/changed-block summary plus a structured line-by-line
diff. The header's **Download current document** action and the
per-row **Download version** action are unchanged; comparison is
visibility only.

User-facing copy is deliberate:

- The panel header is **Text comparison**, not "redline."
- Comparison results render as a side-by-side preview (left version vs right version) and remain explicitly non-official.
- Official artifact labels in Repository remain **Source file**, **Generated Word document**, and **Signed PDF**.
- A subtitle reads *Preview comparison only — not an official
  redline*, with a follow-up sentence pointing users at the
  per-version download for a Word-style redline.
- Warnings (text truncation, diff truncation) are mapped from opaque
  service-layer tags to human-readable notices before they reach the
  DOM.

Backend:

- ``POST /api/contracts/{contract_id}/artifacts/compare`` takes
  ``{base_artifact_id, compare_artifact_id}`` and returns a structured
  diff with safe metadata on each side (artifact id, type, label,
  filename, created_at).
- Org + contract scoped. Both ids must match an artifact on the
  path contract and on the caller's organization; any miss returns
  404 (no "wrong artifact" vs "wrong contract" oracle). An artifact
  with missing storage metadata returns 409.
- Text extraction reuses the existing MarkItDown-backed converter
  (``app.services.document_markdown``). When either side cannot be
  converted to plain text the route returns 422 with a user-facing
  message — **no** OCR / Docling / LLM / remote-service fallback. No
  redline artifact is created, no markdown snapshot is persisted,
  and the extracted text never leaves the request scope.
- Diff is computed with stdlib ``difflib`` (``SequenceMatcher``).
  Inputs are capped at 200,000 characters per side; the rendered
  diff is capped at 1,000 lines total. The summary counts are
  computed against the full opcode stream so they remain accurate
  even when the preview is truncated; truncation surfaces via the
  ``warnings`` list (``base_text_truncated`` /
  ``compare_text_truncated`` / ``diff_lines_truncated``).
- A dedicated ``contract.artifacts_compared`` audit event is
  written on success with the two artifact ids/types and the line
  counts. Storage internals (``storage_key`` / ``wrapped_dek``),
  raw bytes, extracted text, and signer PII are never recorded.

Frontend:

- ``compareContractArtifacts(contractId, baseArtifactId,
  compareArtifactId)`` in ``lib/api.ts``; demo mode is fully wired
  (``mockApi.compareContractArtifacts``) so the panel renders
  end-to-end on the demo build.
- The Document History panel renders the compare controls only
  when at least two artifacts exist for the contract.
- The compare result panel renders summary cards (Added / Removed /
  Changed blocks / Unchanged) and a monospaced diff with
  add/remove/context line styling. Stale results are dropped the
  moment the user changes a side.

Constraints preserved by this PR:

- No artifact semantics, taxonomy, or schema changes.
- No change to download priority, the per-artifact download
  endpoint, approval gate, or DocuSeal behavior.
- No persisted redline artifact and no markdown-snapshot rows are
  created by the compare flow.
- No OCR, Docling, LLM, remote-service, or PowerSync usage.

Follow-ups tracked: official DOCX redline generation,
side-by-side viewer, generated PDF preview, artifact diff /
version compare beyond text, persisted redline artifacts,
Docling/OCR fallback for image-only PDFs, audit export, and
PowerSync sync rules.

### Clause segmentation (v1)

Uploaded contracts are now segmented into clause-level units via a
deterministic heuristic (numbered sections, `Section N`, `ARTICLE V`,
ALL-CAPS / title-case headings, with a paragraph fallback). Every
persisted clause is grounded in the original contract text by exact
character offsets — `Contract.full_text[span_start:span_end] ==
Clause.text` is enforced at persistence time, and ungrounded
candidates are dropped rather than written. The contract detail
endpoint includes the clauses; a `GET /api/contracts/{id}/clauses`
endpoint is also available.

This is a foundation for downstream features (playbook deviation,
clause library, RAG Q&A); it is **not** a clause manager, **not** an
LLM-driven classifier, and **not** legal advice. Clause types are
labelled conservatively from a CUAD-inspired taxonomy when the
heuristics are confident, and left unclassified otherwise.

### Playbook schema and rule loader

Playbooks are firm-defined YAML documents that capture review
positions on a particular contract type — for example, "for mutual
NDAs in California, governing law should be California; assignment
must require prior written consent." They are validated by
`backend/app/services/playbook_loader.py` and persisted per
organization in the `playbooks` table. The v1 schema supports three
rule types:

- `required_clause` — a clause of the named `clause_type` should be
  present somewhere in the contract.
- `preferred_value` — a specific extracted value is preferred (e.g.
  governing law = California). Carries an `expected_value`.
- `text_contains` — the clause text must contain *all* of the listed
  `required_terms` (case-insensitive). At least one term required.

The API surface (`/api/playbooks`) supports validate, create, list,
detail, and soft-delete (deactivate). An example playbook ships under
`backend/app/services/playbook_examples/mutual_nda.yaml`, and the
read-only **Playbooks** page in the frontend renders them with a
right-hand YAML pane.

### Deterministic playbook review

Whereas can now run a playbook against a contract's segmented
clauses and return pass/fail results per rule. The matching engine
(`backend/app/services/playbook_matcher.py`) is **deterministic** —
no LLM call, no embeddings, no paraphrase inference — and only uses
the data that is already exact-span-grounded by the segmenter. The
transient endpoint is `POST /api/contracts/{contract_id}/playbook-review`;
the contract detail page's **Review** tab also runs the persisted
flow described below and highlights the cited evidence span when an
evidence row is clicked.

### Persisted playbook review findings

A review can now be saved as a `PlaybookReviewRun` with one
`DeviationFinding` row per failed deterministic outcome. Pass results
are not persisted as separate rows; the run record carries the
aggregate `rules_checked` / `passed_count` / `failed_count` so the
audit signal is preserved without per-rule pass noise. Findings are
generated from firm-authored YAML playbooks and remain
exact-span-grounded — the matcher copies `span_start` / `span_end`
straight off the source `Clause` row.

Endpoints (under `/api/contracts/{contract_id}`):

- `POST /playbook-review/runs` — run the matcher and save the failed
  findings under a new `PlaybookReviewRun`. Marks any prior `open`
  findings on the same `(contract, playbook)` as `superseded`;
  `reviewed` and `ignored` findings are left alone so re-running a
  playbook does not silently reset deliberate human decisions.
- `GET /playbook-review/runs` and
  `GET /playbook-review/runs/{run_id}` — list runs / fetch a run's
  findings and per-rule outcomes.
- `GET /findings` — list a contract's findings, with optional
  filters on `playbook_id`, `finding_status`, `severity`, and
  `review_run_id`.
- `PATCH /findings/{finding_id}` — update the reviewer workflow
  status (`open` / `reviewed` / `ignored`). Deterministic fields
  (status, message, span, rule metadata) are immutable through this
  endpoint.

LLM redlines and suggested replacement language remain future work.
Findings are not legal advice — Whereas surfaces information about
contracts; it does not replace human review.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Whereas is community-driven; PRs welcome. Read [the design principles](docs/design-principles.md) before proposing significant changes. For an architecture/status handoff covering PRs #32–#62 — including the end-to-end CLM loop (template generation → DocuSeal send → verified webhook → signed PDF → executed contract), the Requests + Inbox intake/work-queue layer (PR #47), the request → contract conversion route (PR #48), the dashboard analytics foundation (PR #49), the approval workflow foundation (PR #50), reusable approval workflow templates (PR #51), the DocuSeal approval gate (PR #52), backend approval policies (PR #53) and their management UI (PR #54), the request approval visibility surface (PR #56), the approval / signature activity timeline (PR #58), policy names in the DocuSeal gate response (PR #59), gate remediation links in the Send-to-DocuSeal panel (PR #60), deep-link query strings on those remediation links (PR #61), and the approval analytics foundation on the dashboard (PR #62) — see [docs/local-first-pwa-clm-architecture.md](docs/local-first-pwa-clm-architecture.md). The consolidated approval-system checkpoint is in **section 14** of that doc.

Whereas tracks two layers of work:

- **Requests** are intake records: someone asks for a contract (new NDA, MSA, amendment, renewal). Status moves from open → in_progress → completed (or cancelled).
- **Inbox items** are the per-user work queue. Creating a request automatically creates a `request_review` inbox item; the approval workflow layer (PR #50) emits `approval` items as steps activate. Future PRs will emit signature follow-up and metadata cleanup items as well.

A request that carries a `linked_template_id` can be **converted to a draft Contract** in one click via `POST /api/requests/{id}/convert-to-contract`. The conversion reuses the existing `AgreementTemplate` generation path, links the new contract back to the request, marks the request `completed`, and resolves the linked open `request_review` inbox item — all in the same transaction. The endpoint stops at "draft Contract": sending out for signature is still a separate explicit step from the Contract workspace.

**Approval workflows** (`/api/approval-workflows`) attach an ordered list of approval steps to a request and/or contract. Creating the workflow opens an `approval` inbox item for step 1 only; approving advances to the next step (and opens its inbox item) or completes the workflow when there is no next step; rejecting ends the workflow and skips the remaining steps; cancelling dismisses any open approval inbox items and skips pending steps. This is intentionally narrow — no parallel approvals, no conditional branching, no SLA reminders, no auto-send to DocuSeal — and a workflow approval does NOT mutate the linked request/contract status (those transitions remain manual).

**Approval workflow templates** (`/api/approval-workflow-templates`) are reusable blueprints, distinct from `ApprovalWorkflowRun`. A template carries an ordered list of step definitions (title, optional approver, optional `due_in_days`); instantiating one (`POST /api/approval-workflow-templates/{template_id}/instantiate`) creates a concrete `ApprovalWorkflowRun` plus `ApprovalStep` rows, computes each concrete step's `due_date = today + due_in_days`, and opens an `approval` inbox item for the first step only — exactly the same surface as an ad-hoc workflow. The instantiate request takes `request_id` / `contract_id` / `agreement_template_id` (the AgreementTemplate document blueprint, deliberately spelled out so it doesn't collide with the workflow template path). Editing a template after it's been instantiated does **not** mutate the in-flight run; archived templates cannot be instantiated.

**Approval policies** (`/api/approval-policies`) match requests by `request_type`, `contract_type`, `priority`, and optional linked `AgreementTemplate`; null policy fields behave as wildcards. Active matching policies can auto-attach approval workflow templates on request create/update, and policy-derived workflow runs are idempotent (tracked by source policy metadata on the run). The DocuSeal send gate uses these policies to block generated/request-linked contracts when required policy approvals are unmet. If no policies match and no workflows exist, send remains allowed. An **Approval Policies** management UI ships under the demo app (`Approval Policies` sidebar entry) with list / create / archive controls; archived policies are hidden by default and shown via an include-archived toggle.

**Request approval visibility** (`GET /api/requests/{request_id}/approval-status`) is a read-only stitch of matching policies, attached `ApprovalWorkflowRun`s, and a summary aligned with the DocuSeal gate. The Requests page renders it inline (lazy-loaded per row via a "View approval status" toggle) so users can see which policies match, which workflow runs are attached, what step is currently pending, and whether the request is blocked, pending, completed, or ready for signature — without flipping pages or guessing at metadata. Visibility only: this endpoint does not mutate state, does not change the gate's allow/block rules, and does not auto-create or remove workflows.

**Approval / signature activity timeline** (`GET /api/requests/{request_id}/activity` and `GET /api/contracts/{contract_id}/activity`) is a read-only chronological feed of approval and DocuSeal events for a request or contract. The same approval workflow create / approve / reject / cancel / template-instantiate handlers now write narrowly-scoped audit events (`approval.workflow.created`, `approval.step.activated`, `approval.step.approved`, etc.); the timeline endpoints project those plus the existing `contract.sent_for_signature` and `contract.executed` audit events into a compact, server-rendered list. The Requests page surfaces it inline alongside the approval status section; the Contract workspace surfaces it as a dedicated panel. The audit chain is hash-validated, so payloads are intentionally compact: workflow / step / request / contract identifiers and a `decision_note_present: bool` boolean — never the decision-note text, signer PII, document bytes, storage keys, or DocuSeal secrets. Historical workflow events from before PR #58 are not backfilled.

**Activity export (PR #75)** adds `GET /api/contracts/{contract_id}/activity/export?format={csv|json}` and `GET /api/requests/{request_id}/activity/export?format={csv|json}` so a Repository or Request's activity timeline can be downloaded for governance / compliance handoffs. The export reuses the same sanitized timeline projection as the read-only `/activity` endpoints — it does **not** open a new broader audit query path, so storage internals, raw audit details, raw `metadata_json`, document bytes, signer PII, private/presigned URLs, DocuSeal secrets, and raw webhook payloads cannot leak. CSV uses Python's `csv` module with a fixed allowlisted column order, RFC-4180 quoting/escaping, and a header row; missing values render as empty strings. JSON is wrapped in an `{export_type, generated_at, subject_type, subject_id, events}` envelope where `events` uses the timeline projection shape. Cross-org subjects return 404, unsupported `?format=` values return 422, and a hard cap of 1,000 events keeps any one export bounded. Each successful export appends a `contract.activity_exported` or `request.activity_exported` audit row with safe details only (`subject_id`, `format`, `event_count`) — the exported bytes are never recorded, and the new event types are deliberately outside the timeline projection's surfaced set, so an export cannot appear inside the timeline it just produced. The Repository activity panel and the per-row Request activity panel render `CSV` / `JSON` buttons that drive the existing authenticated download flow; bytes go to a Blob → anchor click, never into rendered DOM text. Demo mode mirrors the same shape in-process and never calls the network. This is an audit/activity export foundation — full enterprise reporting (cycle time per template, workload-over-time, scheduled exports, multi-subject bundles) is deliberately out of scope.

**Duplicate merge (PR #76)** turns the warning-only duplicate-detection surface from PR #66 into an intentional resolution workflow. `GET /api/contracts/{contract_id}/duplicate-candidates` lists possible duplicates for an existing Repository record using the same allowlisted projection as the upload-time list — exact-hash and normalized-title matches, no storage internals. `POST /api/contracts/{target_contract_id}/merge-duplicate` accepts `{source_contract_id, merge_note?}` and merges the source into the target. The source row is **not** deleted: its `ContractArtifact` rows are reassigned to the target (the only mutation is the `contract_id` FK — `storage_key`, `wrapped_dek`, `metadata_json`, hashes, and timestamps are preserved verbatim), and the source is flagged with new nullable columns `merged_into_contract_id` / `merged_at` / `merged_by_user_id` (migration `0016_contract_duplicate_merge`). The default Repository list filters merged rows out; `?include_merged=true` brings them back. A merged source's detail still resolves (no 404) and carries the merged-into pointer so the UI renders a safe "merged into …" notice with a deep link to the canonical record. Errors are explicit: 400 for `source == target`, 404 for cross-org / missing rows, 409 for already-merged source or target. Two paired audit events fire — `contract.duplicate_merged` (against the target) and `contract.merged_into` (against the source) — each carrying only `{target_contract_id, source_contract_id, artifacts_moved, merge_note_present, workflow_runs_attached_to_source, requests_attached_to_source}`; the note text is never persisted, never echoed back, never written to the audit log. This PR deliberately does **not** rewire workflow / request links, does **not** call DocuSeal, does **not** change contract status, and does **not** touch download/preview priority — the response surfaces counts so the UI can warn that those links stayed on the merged record. The Repository workspace shows a "Possible duplicates" section with a confirmation modal that spells out what does (artifacts move into Document History; source is marked merged and hidden) and does not (no files deleted; no DocuSeal calls; workflows stay put) happen. Demo mode mirrors the same posture in memory. Richer conflict resolution (workflow / request migration, undo merge, side-by-side diff assist) is future work.

Richer policy builders, policy reconciliation/removal when requests stop matching, RBAC for policy management and overrides, workflow / policy detail routes (the deep-link query strings shipped in PR #61 still land on the existing approval list pages), a remediation checklist UI, request approval analytics, SLA / calendar reminders, and PowerSync sync rules are tracked as follow-ups.

A **dashboard summary** at `GET /api/dashboard/summary` (and the corresponding Dashboard page) gives a read-only view of CLM activity in the workspace: open / in-progress request counts, urgent + high-priority counts, open and overdue inbox counts, contract totals broken down by sent-for-signature and executed, active template count, active approval workflows + pending / overdue approval steps, active approval workflow template count, plus small lists of requests / inbox items due in the next 14 days and the most recent contracts, requests, and signed contracts. It is a lightweight aggregate of existing state, **not** a reporting / BI engine — there are no charts, cycle-time metrics, or workload-by-assignee breakdowns yet.

PR #62 added an **approval analytics foundation** alongside the existing dashboard counts. `GET /api/dashboard/summary` now also carries an `approval_analytics` block with: pending / overdue step totals (mirrored from the existing `counts` so the two can never disagree), workflow status counts (active / completed / rejected / cancelled), 30-day windowed `workflows_completed_last_30_days` and `workflows_rejected_last_30_days`, a small `pending_by_assignee` grouping (capped at 10) reporting per-assignee pending count + overdue subset, and an `oldest_pending_steps` list (capped at 5) ordered by `due_date ASC NULLS LAST, created_at ASC, id ASC`. The dashboard page renders five lightweight cards plus the two lists side-by-side, with workflow rows deep-linking via `/demo/approvals?workflow_id=<id>` and (when a request is linked) `/demo/requests?request_id=<id>` per PR #61. Reporting / explainability only — `approver_email` is intentionally omitted from the analytics surface, no storage internals are emitted, and the block does not change workflow state, the DocuSeal gate, or approval-policy matching.

Conditional / parallel approvals, richer template builders, deeper approval analytics (cycle time per template, average days-pending, workload by approver over time, exportable approval reports), upload-file request conversion (uploading a counterparty paper directly through the request), one-click convert-and-send to DocuSeal, request → DocuSeal gating, calendar reminders, richer dashboard analytics (charts, cycle time, workload by assignee), and PowerSync sync rules are deliberately not part of this layer — they belong on top.

## Acknowledgments

Whereas builds on the work of:
- [DocuSeal](https://www.docuseal.com/) for the e-signature layer
- [CUAD](https://www.atticusprojectai.org/cuad) for the contract clause taxonomy and dataset
- [LiteLLM](https://github.com/BerriAI/litellm) for provider-agnostic LLM access
- [pgvector](https://github.com/pgvector/pgvector) for embedding storage


### Request → DocuSeal approval gating

For `POST /api/contracts/{id}/send-to-docuseal`, Whereas now checks approval readiness for request-linked contracts:
- If no linked `ContractRequest`, send is allowed (standalone/uploaded contracts keep previous behavior).
- If linked request has no approval workflows, send is currently allowed.
- Active or rejected workflows block send.
- At least one completed workflow (with no active/rejected) allows send.
- Cancelled-only workflows block send.

`GET /api/contracts/{id}/approval-gate` returns the same allow/block decision plus compact `required_policies` / `missing_policies` summaries (id + name + match attributes) so the Send-to-DocuSeal panel can render policy *names* directly when the gate blocks with `required_approval_policy_unmet`. The legacy `required_policy_ids` / `missing_policy_ids` arrays remain on the response for back-compat and are aligned element-by-element with the named summaries. Storage internals (`storage_key` / `wrapped_dek` / `s3_key`) and signer PII are never surfaced. This is explainability only; the gate's allow/block rules are unchanged.

When the gate blocks, the Contract workspace's Send-to-DocuSeal panel renders a **"How to unblock"** section that maps the gate `code` to actionable links: `active_approval_workflows` and `rejected_approval_workflows` link to the linked request's approval status (Requests page) and to specific blocking workflow rows on the Approvals page; `required_approval_policy_unmet` links each missing policy to the matching row on the Approval Policies page (falling back to ids if names are absent); `cancelled_without_completed_approval` links to the request approvals and the Approvals page so a fresh workflow can be started. PR #61 added query-string deep-links — `/demo/requests?request_id=<id>`, `/demo/approvals?workflow_id=<id>`, `/demo/approval-policies?policy_id=<id>` — so each destination page scrolls the matching row into view, applies a subtle highlight, and (where applicable) auto-expands its detail section. Hitting a deep link with an unknown id renders a small not-found notice instead of a silent no-op; the Approval Policies page also auto-enables `Include archived` once if the linked policy is archived. There are no new detail routes; this is navigation/explainability only and gate semantics, approval policy matching, approval state transitions, and DocuSeal send behavior are unchanged.

An override escape hatch exists for now (`approval_override=true`) and requires `approval_override_reason`; override details are audit logged. RBAC-limited override permissions are future work.
