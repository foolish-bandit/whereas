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
- **Template variables are metadata only in this release.** Templates can declare `AgreementTemplateVariable` rows (`counterparty_name`, `effective_date`, ...) so a later PR can render filled DOCX agreements; this PR does not generate DOCX, send to DocuSeal, or substitute placeholders. Variable keys are unique per template and are listed sorted by `sort_order`.
- **Templates can generate draft DOCX agreements.** `POST /api/agreement-templates/{id}/generate` takes a `{title?, variable_values}` payload, validates it against the template's `AgreementTemplateVariable` rows, renders the DOCX via [`docxtpl`](https://docxtpl.readthedocs.io/) using `{{ variable_name }}` placeholders, and creates a fresh **draft `Contract`** with a `generated_docx` `ContractArtifact` (`source='template_generation'`, `is_official=true`, `metadata_json` carries `template_id` / `template_name` / variable keys used). The original `original_upload` template artifact is never mutated; downloads of the generated DOCX go through the standard contract download endpoint. A Markdown working snapshot is created for the generated DOCX when the converter produces something usable; a conversion failure is logged and the DOCX still lands. **Generated agreements are not sent to DocuSeal in this PR** — that integration lives in a follow-up.
  - Validation: required variables must be provided and non-empty; unknown keys are rejected with a 400. `text` accepts strings; `date` accepts an ISO-8601 string when easy and otherwise passes the input through; `number`/`money` accept numbers or numeric strings; `boolean` accepts a bool or `"true"`/`"false"`; `select` is enforced against `metadata_json.options` when set.
  - Generation requires the template's latest official `original_upload` artifact to be a DOCX; PDF templates return 400. Templates uploaded before the `wrapped_dek` column on `agreement_template_artifacts` was introduced (migration `0010_template_artifact_wrapped_dek`) cannot be decrypted and must be re-uploaded.

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

See [CONTRIBUTING.md](CONTRIBUTING.md). Whereas is community-driven; PRs welcome. Read [the design principles](docs/design-principles.md) before proposing significant changes. For an architecture/status handoff covering PRs #32–#37 and the recommended next steps, see [docs/local-first-pwa-clm-architecture.md](docs/local-first-pwa-clm-architecture.md).

## Acknowledgments

Whereas builds on the work of:
- [DocuSeal](https://www.docuseal.com/) for the e-signature layer
- [CUAD](https://www.atticusprojectai.org/cuad) for the contract clause taxonomy and dataset
- [LiteLLM](https://github.com/BerriAI/litellm) for provider-agnostic LLM access
- [pgvector](https://github.com/pgvector/pgvector) for embedding storage
