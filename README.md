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

- **Dashboard** — at-a-glance counts and recent activity.
- **Repository** — all agreements, drafts, signed documents, and contract
  records. Backed by the same backend `Contract` APIs; the legacy
  `/demo/contracts` route is preserved as an alias of `/demo/repository`.
- **Requests** — the natural place to start work. The Requests workspace
  surfaces cards for *New request*, *Start from template*, *Upload
  third-party agreement*, *Agreement templates* (template management
  lives here, reachable at `/demo/requests/templates` and the legacy
  `/demo/agreement-templates`), and the *Request queue*. Each Request
  also has a detail workspace at `/demo/requests/:id` with intake
  metadata, approval status, matching Approval Policies, active
  Approval Workflows, conversion actions, linked Repository context,
  activity timeline, and activity export controls. A request can
  become a Repository record via two intake paths:
  - generating a draft from an `AgreementTemplate` and rendered variable
    values (PR #48), or
  - uploading a third-party agreement file (PDF/DOCX) — counterparty
    paper, signed exhibit, or external draft — which is stored as the
    new Repository record's Source file (PR #65).
  Both paths leave the request `linked_contract_id` set and the open
  `request_review` inbox item resolved in the same transaction. The
  Request detail workspace does not change approval gate, approval
  policy matching, DocuSeal send, or artifact priority semantics.
- **Playbooks** — review standards, fallback positions, and deviation
  rules for contract review.
- **Repository workspace** — the per-contract surface at
  `/demo/repository/:id` (legacy `/demo/contracts/:id`). PR #83 added
  a lifecycle status banner above the Document lifecycle strip:
  green "Executed" callout with the signed-PDF date when
  `status=executed`, info-toned "Out for signature" callout when
  `status=sent_for_signature`, nothing otherwise. The banner is
  informational — the header's "Download current document" button
  already prefers `signed_pdf` for executed contracts. No backend
  changes; no signer PII or DocuSeal secrets in the banner.
- **Dashboard** — the entry point at `/demo/dashboard`. PR #82 polished
  this surface: a conditional "Needs attention" banner when overdue
  approval steps or inbox items exist (with a CTA to the right
  triage surface), grouped + clickable count tiles (Request pipeline /
  Repository / Approvals / Inbox & templates), per-row deep links to
  the specific Request detail and Repository workspace pages, a
  loading skeleton, and friendlier "Pending by assignee" labels (no
  more raw `<code>` user IDs). No backend changes.
- **Repository** — the agreement list at `/demo/repository` (legacy
  `/demo/contracts` still resolves). PR #81 added the missing
  `Out for signature` and `Executed` options to the status filter,
  a sort dropdown (Newest / Oldest / Title A→Z), a "Show merged"
  toggle wired to the `?include_merged=true` API param from PR #76,
  and a `Merged` chip on rows whose Repository record has been merged
  into another. No backend changes.
- **Clause Manager** — approved clauses, fallback language, and reusable
  drafting guidance. PR #80 polished this surface: loading / error /
  empty states, an Active / Archived status pill, an "Add a clause"
  panel, server-side `clause_type` filter, client-side search across
  name / type / jurisdiction / tags / text, expandable clause text,
  copy-to-clipboard, metadata chips, and a two-step Archive confirm.
  Backend semantics are unchanged — Archive is still soft-delete via
  the existing endpoint. Legacy `/demo/clause-library` still resolves.
- **Approvals** — landing page with cards for *Approval tasks*, *Approval
  workflows*, *Approval templates*, and *Approval policies*. PR #79
  polished this surface: the landing cards show live counts pulled
  from the dashboard summary, `/demo/approvals/tasks` is now a
  dedicated Approval Tasks view (filtered to `item_type=approval`,
  with mount-aware links back to the related Request or Repository
  record), and workflow rows show a status pill, "Step N of M"
  progress, source indication (manual / from template / from policy),
  and clean Request/Repository link buttons. Approval gate, workflow
  state machine, and policy matching semantics are unchanged. The
  legacy `/demo/approval-workflows`, `/demo/approval-templates`,
  `/demo/approval-policies`, and `/demo/inbox` routes still resolve,
  and the `/demo/approvals?workflow_id=<id>` deep links wired in
  PR #60–#61 forward to `/demo/approvals/workflows`.
- **Settings**.

Nothing about the backend Contract / Approval / Template models or their
HTTP endpoints changed in this consolidation pass — only how they're
labelled, grouped, and routed in the web UI.

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
