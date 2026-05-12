# Project status — Whereas

**As of 2026-05-11. Pre-v0.1.**

A snapshot of what's shipped, what's in flight, and what's left
before v0.1. This is the document an evaluator (or a contributor
coming back after a break) should read first.

> Pre-v0.1 still. Not production-ready. Don't expose to the
> internet without first reading
> [security-notes.md](security-notes.md).

## TL;DR

Whereas now covers the post-execution CLM loop end-to-end:
**request → template → generation → repository → approval →
DocuSeal → executed → search / history / redline / audit**. Every
surface is wired to the same Postgres + S3-compatible backend, the
frontend ships as an installable PWA, and every state change is
recorded in an org-scoped audit chain with allowlisted detail
fields. Real authentication, SSO, RBAC, and notifications are
**not** built — pre-v0.1 deliberately runs on a dev-user header.

## What's shipped (highlights of the recent run, PRs #95–#110)

### Repository
- **Search foundation** (PR #95): URL-wired `?q=` filter on the
  Repository list against `/api/contracts`.
- **Text-preview search** (PR #100): `?q=` now matches the
  Markdown-snapshot body via a correlated `EXISTS` subquery,
  org-scoped and deduped at the SQL layer.
- **Match-source chips** (PR #101): each search-result row carries
  a closed-enum `search_match_source` (`title` / `text_preview` /
  `title_and_text_preview` / `null`) so the UI can render *Matched
  title* / *Matched Text preview* / *Matched title + Text preview*
  hints without ever returning raw snippet content.
- **Quick Views / saved-view presets** (PR #104): URL-backed status
  / sort / merged presets at `?view=` plus a Quick Views bar with
  built-in *Drafts*, *Out for signature*, *Executed*, etc.
- **Advanced filters panel** (PR #105): toggleable panel with
  active-filter count chip, search-summary chip, and *Reset all*.
- **MVP readiness audit** (PR #107): centralized
  `FORBIDDEN_DOM_TOKENS` list and cross-route audit test asserting
  no rendered page leaks storage internals, signed URLs, raw
  artifact tokens, or `metadata_json`.

### Agreement Templates
- **Variable detection helper** (PR #96): one-shot scan that parses
  `{{placeholder}}` tokens out of the source DOCX and suggests
  variables to define.
- **Pre-generation review step** (PR #97): user reviews resolved
  variable values + generated filename before the draft Contract +
  `generated_docx` artifact are created.
- **Source-file history section** (PR #102): the template detail
  page shows every `original_upload` artifact, newest-first, with a
  *Current* chip.
- **Per-version download** (PR #103): each historical version is
  downloadable; backend route is org/template scoped, ASCII-restricted
  filename, audit event on download.
- **Source-file rollback** (PR #106): non-current versions carry a
  *Restore as current* two-step confirm. Transactional flip of
  `is_official` across siblings; no rows deleted, no storage keys
  mutated.

### Approvals
- **Approval Workflow detail page** (PR #98): timeline of steps,
  progress summary, current-step highlight, approve/reject inline,
  two-step cancel ActionArea, ActivityArea.
- **Approval Task detail page** (PR #99): per-task page with
  "What am I approving?" explainer, context cards
  (Request / Repository / Workflow), inline approve/reject with
  optional decision note for approval tasks; mark-complete/dismiss
  for non-approval inbox items.

### Document History / redline
- **DOCX comparison-report export** (PR #90): on-demand DOCX render
  of a diff between two artifacts.
- **Persisted redlines** (PR #91): the export can be saved as a
  `redline` artifact attached to the Contract. `is_official=false`
  so it never becomes the *current document*.
- **Redline source linkage** (PR #92): Document History shows the
  base/compare ids on saved redlines.
- **Paragraph-aware diff** (PR #93): diff unit is a paragraph-shaped
  block, not a raw line. Source-wrap differences no longer surface
  as content changes.

### Backend hardening
- **Backend API response leak audit** (PR #109): canonical
  `FORBIDDEN_RESPONSE_TOKENS` list + cross-cutting test exercising
  list / detail / 404 envelopes across every major resource group,
  plus an audit-event detail scan during bootstrap. **No leaks
  found** — schemas already exclude storage internals by construction.
- **Redline/compare test suite repair** (PR #110): three stale
  paragraph-mode assertions, a wrong-column-name audit helper, and a
  hard-coded download-priority expectation in the compare tests were
  fixed. Backend suite returns to **0 failures**.

### Docs / self-host
- **Self-host setup polish** (PR #108):
  - `docs/optional-dependencies.md` — LibreOffice / MarkItDown /
    DocuSeal / Ollama clarity (unlocks what, breaks what when
    missing).
  - `docs/mvp-smoke-checklist.md` — ~15-min end-to-end checklist for
    a new evaluator.
  - `docs/security-notes.md` — shipped-behavior security reference
    (encryption at rest, SW exclusion, audit-log allowlisting,
    DocuSeal webhook HMAC).
  - Self-host evaluator quickstart section in the root README.

## What's in flight (paused mid-flight, branch saved)

- **PR #111 — Demo data / empty-state consistency pass.** Partial
  work stashed on branch `claude/pr-111-demo-data-consistency`:
  added `sent_for_signature` / `executed` / `merged-duplicate` /
  `draft` lifecycle states to the demo Repository list, wired
  matching artifact stacks (generated_docx / signed_pdf) per
  lifecycle state, seeded a historical redline against the sample
  NDA, and pointed the demo active approval workflow at the open
  NDA request id (vs a placeholder). **Resume:** unstash from
  `git stash list`, run vitest / build / SW denylist check, ship as
  PR #111. Empty-state copy audit not started.

## What's left before v0.1

The list below is what an honest pre-v0.1 evaluator should know is
*missing*, not a roadmap. Items are roughly grouped by gating-ness.

### Required for v0.1 (foundation)
- **Real authentication.** Today's dev-user `X-Whereas-Dev-User`
  header is a temporary bridge. Replacement options
  (Whereas-native Argon2id + sessions, OIDC, SSO) and the
  `/api/setup/dev` lifecycle need to be designed and shipped.
  Production currently rejects every `/api/setup/dev` call.
- **Permissioning / RBAC.** Every list endpoint is already
  org-scoped; user-level roles (admin / editor / approver /
  viewer) are not built. Cross-org isolation is the only access
  boundary today.
- **Production deployment guide.** TLS termination, reverse-proxy
  config, rate-limiting, secret rotation, backup encryption — none
  written yet. The link target `docs/deployment-guide.md` is
  intentionally not created until this is real.
- **Real-document tests against a Postgres + MinIO + Ollama
  stack.** CI runs against SQLite + stubbed converters; an
  end-to-end integration job against a containerized Postgres +
  pgvector + MinIO + ollama (small model) is missing.

### Functional gaps (visible in the UI today)
- **Playbook deviation engine.** Schema + loader landed; the actual
  deviation evaluation (clauses ↔ rules) is stubbed.
- **RAG Q&A over the corpus.** Permission-scoped retrieval is
  designed; ingestion → retrieval → answer pipeline is not built.
- **Email / calendar / notifications.** Pre-v0.1 deliberately has
  none. The approvals inbox is the only "notification" surface.
- **Real-time collaboration / PowerSync sync.** PWA local-first
  surface is wired (the Markdown working snapshot is the seam) but
  no sync layer is shipped.
- **Send-back / partial-approval flows on DocuSeal completion.**
  Today, a signed webhook lands and the contract flips to
  `executed`; declined / partially-signed completions are 202-noop
  but don't surface remediation.

### Polish / nice-to-haves
- **Demo data / empty-state consistency** (PR #111, paused).
- **Reading-mode improvements** on the Repository workspace's Text
  preview surface (PR-sized).
- **Per-tenant LLM provider override UI.** LiteLLM seam exists
  server-side; no settings UI to switch providers per org.
- **Activity export CSV/JSON polish.** Allowlist is already tight;
  copy + filter options can be tightened.
- **Service-worker update prompt.** Today, autoUpdate; a UI prompt
  would let users opt-in.

## How to verify the current state

- **Run the smoke checklist** at
  [`docs/mvp-smoke-checklist.md`](mvp-smoke-checklist.md).
- **Check the test surface**:
  - Backend: `pytest` from `backend/` — should be **793 passing,
    14 skipped, 0 failures** post-PR #110.
  - Frontend: `npx vitest run` from `frontend/` — should be
    **640 passing** post-PR #107.
- **Verify the SW exclusion**: `npm run build` from `frontend/`
  and confirm `dist/sw.js` still contains `denylist:[/^\/api\//]`.
- **Walk the cross-route audit test**:
  `frontend/src/__tests__/MvpReadiness.test.tsx` — exercises every
  top-level route, scans for forbidden DOM tokens, rejects
  legacy *Markdown preview* copy.

## How to resume PR #111

```sh
git checkout claude/pr-111-demo-data-consistency
git stash pop  # restore the saved demo-data changes
# Or, if the branch is up to date and the stash has been dropped:
#   git diff HEAD~1 HEAD  -- frontend/src/lib/mockApi.ts
# to remind yourself of the patch shape.
cd frontend
npx tsc -b && npx vitest run && npm run build
```

Then audit empty-state copy on `RepositoryEmpty`, `RequestsEmpty`,
`ApprovalTasksEmpty`, `TemplatesEmpty`, `ClauseManagerEmpty`, and
`ActivityEmpty` per the original PR #111 brief.
