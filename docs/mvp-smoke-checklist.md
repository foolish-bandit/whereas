# MVP smoke checklist

A concise end-to-end checklist for a self-host evaluator who has just
finished [docs/local-developer-quickstart.md](local-developer-quickstart.md)
and wants to confirm the MVP surfaces actually work. Every step below
exercises a feature that is shipped today.

If you only want to click through the UI without standing up Postgres /
MinIO / Ollama, run the frontend in
[demo mode](../frontend/README.md#local-development--demo-mode)
instead — the steps marked **(demo OK)** are simulated in-browser; the
others require a real backend.

> Time budget: ~15 minutes if Ollama and DocuSeal are already running;
> ~5 minutes for the demo-OK subset.

## 0. Pre-flight

- [ ] Backend reachable: `curl -fsS http://localhost:8000/api/health`
- [ ] Frontend reachable: `http://localhost:5173`
- [ ] Dev user created via Settings (or paste an existing UUID)
- [ ] **(demo OK)** Demo mode banner visible if `VITE_WHEREAS_DEMO_MODE=true`

## 1. Repository — upload + record (demo OK)

- [ ] **(demo OK)** Open `/demo/repository` (or `/repository` against
      a real backend); list renders, no `Could not reach the backend`
      error.
- [ ] Upload a PDF or DOCX (under 50 MB) from the Upload page.
- [ ] New contract appears in the Repository list with status
      `extracting` → `ready` (or `failed` if Ollama is offline; the
      file is still stored either way).
- [ ] Contract workspace shows the Text preview by default.
- [ ] **"Download original"** streams the encrypted blob back through
      the backend, decrypts it, and triggers a browser download.

## 2. Repository — search and filters (demo OK)

- [ ] Repository search box filters by title and by Text-preview body
      (PR #100).
- [ ] Each matching row carries a "Matched title" / "Matched Text
      preview" / "Matched title + Text preview" chip (PR #101).
- [ ] Quick Views bar switches between Drafts, Out for signature, etc.
      (PR #104).
- [ ] Advanced filters panel opens; Reset all clears every active
      filter (PR #105).

## 3. Requests workspace (demo OK)

- [ ] `/demo/requests` shows the Requests cards.
- [ ] Create a request — title, type, counterparty.
- [ ] Request detail page (`/demo/requests/:id`) shows the lifecycle
      section, related-record links, and the activity timeline.

## 4. Agreement Templates — generate (demo OK)

- [ ] `/demo/requests/templates` lists templates; click into a
      template (e.g. the seeded NDA).
- [ ] Source file history shows the *Current* row and any prior
      versions (PR #102).
- [ ] **Download version** on any source row returns the original
      DOCX/PDF bytes (PR #103).
- [ ] **Restore as current** on a non-current row flips the official
      source after a two-step confirm; the *Current* chip moves
      (PR #106).
- [ ] Generate a draft agreement from the template; a new Contract
      row appears in the Repository with a `generated_docx` artifact.

## 5. Approvals workspace

- [ ] `/demo/approvals` landing page renders Tasks / Workflows /
      Templates / Policies cards.
- [ ] Approval Tasks list (`/demo/approvals/tasks`) shows open tasks;
      task detail page (`/demo/approvals/tasks/:id`) renders the
      "What am I approving?" context (PR #99).
- [ ] Approval Workflow detail page renders the steps timeline,
      progress summary, and a two-step cancel action (PR #98).
- [ ] Approve / reject from the task detail page records an audit
      event and moves the workflow forward.

## 6. DocuSeal — send for signature (if configured)

Requires a running DocuSeal peer with `DOCUSEAL_BASE_URL`,
`DOCUSEAL_API_TOKEN`, and `DOCUSEAL_WEBHOOK_SECRET` set. See
[optional-dependencies.md](optional-dependencies.md#docuseal--optional-unless-you-exercise-signing).

- [ ] On a generated Contract, click **Send to DocuSeal**; the
      contract status flips to `sent_for_signature`.
- [ ] Complete the signing flow in DocuSeal; the webhook arrives at
      `POST /api/docuseal/webhook`.
- [ ] Whereas materializes a `signed_pdf` artifact, flips the
      contract status to `executed`, and `contract.executed` is
      appended to the audit log.
- [ ] **Download** on the executed Contract now returns the signed
      PDF (resolution order: signed_pdf → generated_docx →
      original_upload → legacy `Contract.s3_key`).

## 7. Document History — version comparison

- [ ] Contract workspace **Document History** section lists every
      artifact for the contract.
- [ ] Preview a non-current version inline.
- [ ] Download any prior artifact.
- [ ] Compare two artifacts; the diff renders inline.
- [ ] Open the redline view; saved redlines appear with
      paragraph-aware diff chunks (PR #91 / #93).

## 8. Activity export

- [ ] Activity timeline on a Contract / Request / Workflow renders
      events with allowlisted detail fields only — no raw
      `metadata_json` dump, no storage internals.
- [ ] Export activity (if surfaced on the page) returns a CSV /
      JSON with the same allowlisted fields.

## 9. Duplicate merge

- [ ] Upload a contract that duplicates an existing one (same hash).
- [ ] The duplicate detection panel surfaces the existing match.
- [ ] Merge the duplicate; the merged contract is hidden from the
      default Repository list (toggle "Show merged" to re-include).

## 10. Settings and dev-user hygiene

- [ ] Settings page (`/demo/settings`) loads; First-run setup card
      is at the top.
- [ ] Browser capabilities card lists the relevant PWA capability
      flags (File System Access API, persistent storage, etc.).
- [ ] Clearing the dev user UUID returns the workspace to the
      yellow "Set a development user ID" banner.

## 11. Security sanity

See [security-notes.md](security-notes.md) for the full list. Quick
checks:

- [ ] Built service worker retains `denylist:[/^\/api\//]`:
      ```sh
      cd frontend && npm run build && grep -o "denylist:\[/\^\\\\\/api\\\\\\/\]" dist/sw.js
      ```
- [ ] No rendered page leaks `storage_key`, `wrapped_dek`, `s3_key`,
      `presigned_url`, `private_url`, `metadata_json`, or raw artifact
      slot tokens (`original_upload`, `generated_docx`, `signed_pdf`,
      `redline_docx`) — the cross-route audit test asserts this on
      every CI run (PR #107).

## What's intentionally NOT in this checklist

- Real authentication / SSO / RBAC — pre-v0.1, not built.
- Real-time collaboration / PowerSync sync — pre-v0.1, not built.
- Email / calendar / Slack notifications — pre-v0.1, not built.
- Production deployment — see "Production deployment" in the root
  README; the local quickstart skips hardening steps.

If anything on this list fails, file an issue with the step number
and the observed behavior.
