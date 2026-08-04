# Finding Remediation Implementation Plan

> **Execution status:** Product implementation complete on the feature branch. Verification, merge, and release gates remain open until they produce fresh evidence.

**Goal:** Turn each persisted failed playbook finding into a deterministic, provenance-aware remediation plan and one durable Inbox task.

**Final architecture:** A pure selection service chooses firm-authored playbook language first and an active Clause Manager source second. A specialized FastAPI router exposes plan and task actions. A tenant-scoped `finding_remediation_tasks` link table gives one finding one durable Inbox task, retains approved-source provenance, and lets the generic Inbox model stay generic. The React review surface lazy-loads plans and never generates or silently applies legal language.

**Tech stack:** Python 3.11, FastAPI, SQLAlchemy 2 async, Alembic, PostgreSQL, Pydantic 2, React 18, TypeScript 5.6, Vite, Vitest, Testing Library, Tailwind CSS.

## Global constraints

- Preserve exact finding evidence and source spans.
- Do not call an LLM or external service for remediation language.
- Do not mutate document text.
- Keep every query organization-scoped.
- Keep legal text out of audit details, link rows, and Inbox metadata.
- Use Repository record terminology in user-facing copy.
- Keep the repository's existing CI workflow; run local verification before using it as a merge gate.
- Ship version `0.1.0-alpha.1` consistently.

## Final file structure

### Backend additions

- `backend/app/services/finding_remediation.py`
  - clause-type normalization;
  - approved-source precedence;
  - deterministic Clause Manager ranking;
  - scope warnings;
  - severity-to-priority mapping;
  - safe title, description, metadata, and audit payload builders.
- `backend/app/models/remediation.py`
  - typed one-to-one finding and Inbox linkage;
  - identifier-only source provenance.
- `backend/app/schemas/remediation.py`
  - plan, task request, and task response contracts.
- `backend/app/api/remediation.py`
  - tenant-scoped GET plan endpoint;
  - create, reuse, and reopen task endpoint;
  - concurrency-safe nested transaction;
  - audit emission.
- `backend/alembic/versions/0020_finding_remediation_tasks.py`
  - table, constraints, indexes, grants, and direct-org RLS policy.

### Backend modifications

- `backend/app/api/inbox_items.py`
  - reserve `finding_remediation` for the specialized endpoint;
  - prevent generic provenance or linkage edits;
  - retain normal work-field edits and soft dismissal.
- `backend/app/main.py`
  - register remediation router.
- `backend/app/security/rls.py`
  - register `finding_remediation_tasks` as a direct-org table.

### Frontend additions

- `frontend/src/types/remediation.ts`
  - typed wire contracts.
- `frontend/src/lib/remediationApi.ts`
  - live authenticated API calls;
  - recursive secret scrubbing;
  - deterministic demo-mode plans and one-task reuse;
  - abortable requests.
- `frontend/src/components/FindingRemediationCard.tsx`
  - lazy plan loading;
  - provenance-first presentation;
  - explicit copy;
  - task create and reopen actions;
  - Inbox deep link;
  - honest no-language state;
  - explicit no-automatic-edit warning.

### Frontend modification

- `frontend/src/components/ReviewPanel.tsx`
  - remove the duplicate client-only checklist;
  - use persisted playbook findings as the only review source;
  - render remediation controls for each persisted failed finding.

### Tests

Backend:

- service selection and normalization;
- model and migration shape;
- RLS registration;
- schema validation;
- safe metadata and audit payloads;
- plan precedence and no-language behavior;
- task idempotency and reopen behavior;
- tenancy and assignee isolation;
- generic Inbox bypass protection;
- legal-text exclusion.

Frontend:

- no eager plan fetch;
- abort on unmount;
- provenance and scope-warning display;
- copy behavior;
- no-language actionability;
- existing task reuse;
- task creation;
- retry behavior;
- live authenticated request shape;
- deterministic demo behavior;
- removal of the duplicate ReviewPanel checklist.

## Implementation tasks

### 1. Approved-language selection

- [x] Add failing normalization and ranking tests.
- [x] Implement exact clause taxonomy normalization.
- [x] Prefer persisted playbook language.
- [x] Add deterministic Clause Manager fallback.
- [x] Return source provenance, rationale, and scope warning.
- [x] Return an honest no-language plan instead of generating text.
- [x] Verify the pure service independently.

### 2. Durable typed linkage

- [x] Add `FindingRemediationTask` model.
- [x] Enforce one durable task per organization and finding.
- [x] Enforce one link per Inbox item.
- [x] Store source type and source ID only.
- [x] Add migration, index, grants, and RLS policy.
- [x] Register the table in the head-state RLS generator.
- [x] Keep remediation fields out of generic Inbox schemas.

### 3. API workflow

- [x] Add GET remediation-plan endpoint.
- [x] Add POST create/reuse/reopen endpoint.
- [x] Scope findings, templates, assignees, links, and tasks by organization.
- [x] Return 404 for cross-tenant or contract/finding mismatch.
- [x] Use a nested transaction for concurrent task creation.
- [x] Recover a racing duplicate by returning the winner's task.
- [x] Reopen a dismissed durable task instead of creating a duplicate.
- [x] Keep task creation available when no approved language exists.
- [x] Emit identifier-only created and reopened audit events.

### 4. Generic Inbox invariants

- [x] Reject generic creation of `finding_remediation` items.
- [x] Reject conversion of another Inbox item into remediation work.
- [x] Protect contract linkage, item type, and provenance metadata.
- [x] Permit normal status, assignment, due-date, title, description, and priority edits.
- [x] Preserve soft dismissal so the specialized endpoint can reopen work.

### 5. Frontend workflow

- [x] Add typed remediation contracts.
- [x] Add live and demo remediation API client.
- [x] Lazy-load only when the user expands a finding.
- [x] Abort stale plan and task requests.
- [x] Display approved source before approved language.
- [x] Display deterministic selection rationale and scope warning.
- [x] Support explicit copy with fallback behavior.
- [x] Support task create, reuse, and reopen UI.
- [x] Deep-link to Inbox.
- [x] Retain actionability when no language source exists.
- [x] State that Whereas never edits the Repository record automatically.

### 6. One review source of truth

- [x] Remove `DEFAULT_DETERMINISTIC_RULES` from the real ReviewPanel.
- [x] Remove the duplicate client-derived findings section.
- [x] Preserve exact-evidence highlighting.
- [x] Preserve reviewer status controls.
- [x] Render remediation controls from persisted findings only.

### 7. Documentation and release metadata

- [x] Record open-source research and adopted patterns.
- [x] Reconcile design documentation with the durable-link implementation.
- [x] Reconcile this implementation plan with the delivered architecture.
- [ ] Add changelog and release notes.
- [ ] Align backend, FastAPI, frontend, and lockfile versions.
- [ ] Update README with the new workflow and verification commands.

### 8. Verification

- [x] Run isolated pure-service tests and Python compilation.
- [ ] Run the complete backend test suite.
- [ ] Run Ruff against the entire backend.
- [ ] Run frontend Vitest suite.
- [ ] Run TypeScript project build.
- [ ] Run production frontend build and service-worker assertion.
- [ ] Run production dependency audits.
- [ ] Validate Alembic migration replay and downgrade behavior.
- [ ] Validate Docker Compose configuration.
- [ ] Review the complete branch diff for secrets and unrelated changes.
- [ ] Confirm no legal text reaches audit details, link rows, or task metadata.

### 9. Merge and release

- [ ] Open the implementation pull request.
- [ ] Resolve every verification or review failure.
- [ ] Confirm the branch is current with `main`.
- [ ] Merge only after fresh green evidence.
- [ ] Tag the merged commit `v0.1.0-alpha.1`.
- [ ] Publish a GitHub prerelease from the verified tag.
- [ ] Confirm `main`, tag, and release all point to the intended commit.
