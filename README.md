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

See [CONTRIBUTING.md](CONTRIBUTING.md). Whereas is community-driven; PRs welcome. Read [the design principles](docs/design-principles.md) before proposing significant changes. For an architecture/status handoff covering PRs #32–#59 — including the end-to-end CLM loop (template generation → DocuSeal send → verified webhook → signed PDF → executed contract), the Requests + Inbox intake/work-queue layer (PR #47), the request → contract conversion route (PR #48), the dashboard analytics foundation (PR #49), the approval workflow foundation (PR #50), reusable approval workflow templates (PR #51), the DocuSeal approval gate (PR #52), backend approval policies (PR #53) and their management UI (PR #54), the request approval visibility surface (PR #56), the approval / signature activity timeline (PR #58), and policy names in the DocuSeal gate response (PR #59) — see [docs/local-first-pwa-clm-architecture.md](docs/local-first-pwa-clm-architecture.md). The consolidated approval-system checkpoint is in **section 14** of that doc.

Whereas tracks two layers of work:

- **Requests** are intake records: someone asks for a contract (new NDA, MSA, amendment, renewal). Status moves from open → in_progress → completed (or cancelled).
- **Inbox items** are the per-user work queue. Creating a request automatically creates a `request_review` inbox item; the approval workflow layer (PR #50) emits `approval` items as steps activate. Future PRs will emit signature follow-up and metadata cleanup items as well.

A request that carries a `linked_template_id` can be **converted to a draft Contract** in one click via `POST /api/requests/{id}/convert-to-contract`. The conversion reuses the existing `AgreementTemplate` generation path, links the new contract back to the request, marks the request `completed`, and resolves the linked open `request_review` inbox item — all in the same transaction. The endpoint stops at "draft Contract": sending out for signature is still a separate explicit step from the Contract workspace.

**Approval workflows** (`/api/approval-workflows`) attach an ordered list of approval steps to a request and/or contract. Creating the workflow opens an `approval` inbox item for step 1 only; approving advances to the next step (and opens its inbox item) or completes the workflow when there is no next step; rejecting ends the workflow and skips the remaining steps; cancelling dismisses any open approval inbox items and skips pending steps. This is intentionally narrow — no parallel approvals, no conditional branching, no SLA reminders, no auto-send to DocuSeal — and a workflow approval does NOT mutate the linked request/contract status (those transitions remain manual).

**Approval workflow templates** (`/api/approval-workflow-templates`) are reusable blueprints, distinct from `ApprovalWorkflowRun`. A template carries an ordered list of step definitions (title, optional approver, optional `due_in_days`); instantiating one (`POST /api/approval-workflow-templates/{template_id}/instantiate`) creates a concrete `ApprovalWorkflowRun` plus `ApprovalStep` rows, computes each concrete step's `due_date = today + due_in_days`, and opens an `approval` inbox item for the first step only — exactly the same surface as an ad-hoc workflow. The instantiate request takes `request_id` / `contract_id` / `agreement_template_id` (the AgreementTemplate document blueprint, deliberately spelled out so it doesn't collide with the workflow template path). Editing a template after it's been instantiated does **not** mutate the in-flight run; archived templates cannot be instantiated.

**Approval policies** (`/api/approval-policies`) match requests by `request_type`, `contract_type`, `priority`, and optional linked `AgreementTemplate`; null policy fields behave as wildcards. Active matching policies can auto-attach approval workflow templates on request create/update, and policy-derived workflow runs are idempotent (tracked by source policy metadata on the run). The DocuSeal send gate uses these policies to block generated/request-linked contracts when required policy approvals are unmet. If no policies match and no workflows exist, send remains allowed. An **Approval Policies** management UI ships under the demo app (`Approval Policies` sidebar entry) with list / create / archive controls; archived policies are hidden by default and shown via an include-archived toggle.

**Request approval visibility** (`GET /api/requests/{request_id}/approval-status`) is a read-only stitch of matching policies, attached `ApprovalWorkflowRun`s, and a summary aligned with the DocuSeal gate. The Requests page renders it inline (lazy-loaded per row via a "View approval status" toggle) so users can see which policies match, which workflow runs are attached, what step is currently pending, and whether the request is blocked, pending, completed, or ready for signature — without flipping pages or guessing at metadata. Visibility only: this endpoint does not mutate state, does not change the gate's allow/block rules, and does not auto-create or remove workflows.

**Approval / signature activity timeline** (`GET /api/requests/{request_id}/activity` and `GET /api/contracts/{contract_id}/activity`) is a read-only chronological feed of approval and DocuSeal events for a request or contract. The same approval workflow create / approve / reject / cancel / template-instantiate handlers now write narrowly-scoped audit events (`approval.workflow.created`, `approval.step.activated`, `approval.step.approved`, etc.); the timeline endpoints project those plus the existing `contract.sent_for_signature` and `contract.executed` audit events into a compact, server-rendered list. The Requests page surfaces it inline alongside the approval status section; the Contract workspace surfaces it as a dedicated panel. The audit chain is hash-validated, so payloads are intentionally compact: workflow / step / request / contract identifiers and a `decision_note_present: bool` boolean — never the decision-note text, signer PII, document bytes, storage keys, or DocuSeal secrets. Historical workflow events from before PR #58 are not backfilled.

Richer policy builders, policy reconciliation/removal when requests stop matching, RBAC for policy management and overrides, richer gate remediation links (deep-linking from a missing-policy bullet to the workflow-template / policy screens), request approval timeline / analytics, SLA / calendar reminders, and PowerSync sync rules are tracked as follow-ups.

A **dashboard summary** at `GET /api/dashboard/summary` (and the corresponding Dashboard page) gives a read-only view of CLM activity in the workspace: open / in-progress request counts, urgent + high-priority counts, open and overdue inbox counts, contract totals broken down by sent-for-signature and executed, active template count, active approval workflows + pending / overdue approval steps, active approval workflow template count, plus small lists of requests / inbox items due in the next 14 days and the most recent contracts, requests, and signed contracts. It is a lightweight aggregate of existing state, **not** a reporting / BI engine — there are no charts, cycle-time metrics, or workload-by-assignee breakdowns yet.

Conditional / parallel approvals, richer template builders, approval analytics, upload-file request conversion (uploading a counterparty paper directly through the request), one-click convert-and-send to DocuSeal, request → DocuSeal gating, calendar reminders, richer dashboard analytics (charts, cycle time, workload by assignee), and PowerSync sync rules are deliberately not part of this layer — they belong on top.

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

An override escape hatch exists for now (`approval_override=true`) and requires `approval_override_reason`; override details are audit logged. RBAC-limited override permissions are future work.
