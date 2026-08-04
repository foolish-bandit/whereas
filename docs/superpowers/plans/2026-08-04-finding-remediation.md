# Finding Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each persisted failed playbook finding into a deterministic, provenance-aware remediation plan and one idempotent Inbox task.

**Architecture:** A pure selection service chooses firm-authored playbook language first and an active Clause Manager template second. A specialized FastAPI router exposes the plan and task-creation actions, while a typed `finding_id` foreign key and partial unique index enforce one non-dismissed remediation task per finding. The React review surface lazy-loads the plan and never generates or silently applies legal language.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy 2 async, Alembic, PostgreSQL, Pydantic 2, React 18, TypeScript 5.6, Vite, Vitest, Testing Library, Tailwind CSS.

## Global Constraints

- Preserve exact finding evidence and source spans.
- Do not call an LLM or external service.
- Do not mutate document text.
- Keep every query organization-scoped.
- Keep legal text out of audit details and Inbox metadata.
- Run verification locally; do not use GitHub Actions or hosted-runner minutes.
- Use Repository record terminology in user-facing copy.
- Ship version `0.1.0-alpha.1` consistently.

---

## File structure

### New backend files

- `backend/app/schemas/remediation.py`: API request and response contracts.
- `backend/app/services/finding_remediation.py`: pure normalization, candidate ranking, plan construction, and priority mapping.
- `backend/app/api/remediation.py`: tenant-scoped GET plan and POST task endpoints.
- `backend/alembic/versions/0020_finding_remediation_tasks.py`: `finding_id` foreign key, index, and partial uniqueness.
- `backend/tests/test_finding_remediation_service.py`: pure service behavior.
- `backend/tests/test_finding_remediation_api.py`: endpoint, tenancy, idempotency, and audit behavior.
- `backend/tests/test_migration_0020_finding_remediation_tasks.py`: migration SQL shape and revision chain.

### Modified backend files

- `backend/app/models/__init__.py`: add `InboxItem.finding_id`.
- `backend/app/schemas/inbox_items.py`: expose `finding_id` read-only.
- `backend/app/api/inbox_items.py`: preserve specialized remediation linkage against generic edits.
- `backend/app/security/audit_log.py`: add task-created audit event.
- `backend/app/main.py`: register router and version.
- `backend/pyproject.toml`: version.
- `backend/app/security/rls.py`: no new table, but tests confirm existing coverage remains unchanged.

### New frontend files

- `frontend/src/types/remediation.ts`: typed API models.
- `frontend/src/components/FindingRemediationCard.tsx`: lazy plan and task UI.
- `frontend/src/components/__tests__/FindingRemediationCard.test.tsx`: component behavior.

### Modified frontend files

- `frontend/src/lib/api.ts`: remediation calls.
- `frontend/src/lib/mockApi.ts`: deterministic demo plans and session task state.
- `frontend/src/components/ReviewPanel.tsx`: render remediation card and remove duplicate client checklist.
- `frontend/src/components/__tests__/ReviewPanel.test.tsx`: assert one review source of truth.
- `frontend/src/types/inboxItems.ts`: expose `finding_id`.
- `frontend/package.json`: version.

### Repository and release files

- Delete `.github/workflows/ci.yml`: eliminate automatic hosted-runner usage.
- `scripts/verify-local.sh`: Unix local verification gate.
- `scripts/verify-local.ps1`: Windows local verification gate.
- `CHANGELOG.md`: release history.
- `docs/releases/v0.1.0-alpha.1.md`: release notes.
- `README.md`: document the remediation workflow and local verification command.

---

### Task 1: Service selection policy

**Files:**
- Create: `backend/tests/test_finding_remediation_service.py`
- Create: `backend/app/services/finding_remediation.py`

**Interfaces:**
- Produces: `normalize_clause_type(value: str) -> str`
- Produces: `rank_clause_template(candidate: ClauseTemplate) -> tuple[int, int, int, float, str]`
- Produces: `build_remediation_plan(finding: DeviationFinding, candidates: Sequence[ClauseTemplate], existing_task: InboxItem | None) -> RemediationPlan`
- Produces: `priority_for_severity(severity: str) -> str`

- [ ] **Step 1: Write failing normalization and ranking tests**

```python
def test_normalize_clause_type_collapses_supported_separators() -> None:
    assert normalize_clause_type(" Governing-Law ") == "governing_law"


def test_preferred_tag_beats_newer_generic_candidate() -> None:
    selected = select_clause_template([newer_generic, older_preferred])
    assert selected.id == older_preferred.id
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd backend && pytest tests/test_finding_remediation_service.py -q`

Expected: import failure because `app.services.finding_remediation` does not exist.

- [ ] **Step 3: Implement normalization, deterministic ranking, source provenance, scope warning, and severity priority mapping**

```python
_SEPARATOR_RE = re.compile(r"[\s_-]+")


def normalize_clause_type(value: str) -> str:
    return _SEPARATOR_RE.sub("_", value.strip().lower()).strip("_")
```

The implementation must sort by preferred tag, default tag, broad scope, `updated_at` descending, then UUID ascending. Playbook preferred language bypasses candidate selection.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cd backend && pytest tests/test_finding_remediation_service.py -q`

Expected: all service tests pass.

- [ ] **Step 5: Run lint for the new module**

Run: `cd backend && ruff check app/services/finding_remediation.py tests/test_finding_remediation_service.py`

Expected: no findings.

### Task 2: Typed persistence link and migration

**Files:**
- Create: `backend/tests/test_migration_0020_finding_remediation_tasks.py`
- Create: `backend/alembic/versions/0020_finding_remediation_tasks.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/schemas/inbox_items.py`
- Modify: `backend/app/api/inbox_items.py`
- Modify: `frontend/src/types/inboxItems.ts`

**Interfaces:**
- Produces: nullable `InboxItem.finding_id: UUID | None`
- Produces: read-only API field `InboxItemResponse.finding_id`
- Produces: partial unique index `uq_inbox_active_finding_remediation`

- [ ] **Step 1: Write failing migration and schema tests**

```python
def test_revision_chain() -> None:
    assert migration.revision == "0020_finding_remediation_tasks"
    assert migration.down_revision == "0019_rls_backfill_0006_0017"


def test_inbox_response_exposes_finding_id() -> None:
    assert "finding_id" in InboxItemResponse.model_fields
    assert "finding_id" not in InboxItemCreateRequest.model_fields
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd backend && pytest tests/test_migration_0020_finding_remediation_tasks.py tests/test_inbox_items.py -q`

Expected: missing migration and field assertions fail.

- [ ] **Step 3: Add model, migration, response field, and generic-route protection**

Migration requirements:

```sql
ALTER TABLE inbox_items
ADD COLUMN finding_id UUID NULL
REFERENCES deviation_findings(id) ON DELETE SET NULL;
```

Add a normal lookup index and the partial unique index from the design specification. Generic create/update schemas remain unable to set `finding_id`.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same pytest command.

Expected: all selected tests pass.

- [ ] **Step 5: Run Alembic upgrade/downgrade test against the repository's migration fixture**

Run: `cd backend && pytest -q -k "migration and finding_remediation"`

Expected: pass.

### Task 3: API plan and task endpoints

**Files:**
- Create: `backend/app/schemas/remediation.py`
- Create: `backend/app/api/remediation.py`
- Create: `backend/tests/test_finding_remediation_api.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/security/audit_log.py`

**Interfaces:**
- Produces: `GET /api/contracts/{contract_id}/findings/{finding_id}/remediation`
- Produces: `POST /api/contracts/{contract_id}/findings/{finding_id}/remediation/task`
- Produces: `AuditEventType.FINDING_REMEDIATION_TASK_CREATED`

- [ ] **Step 1: Write failing API tests**

```python
async def test_create_task_is_idempotent(client, seeded_finding) -> None:
    first = await client.post(task_url)
    second = await client.post(task_url)
    assert first.json()["created"] is True
    assert second.json()["created"] is False
    assert first.json()["task"]["id"] == second.json()["task"]["id"]
```

Also cover playbook-language provenance, Clause Manager fallback, no-language state, cross-tenant 404, contract mismatch 404, assignee validation, severity priority, racing `IntegrityError` recovery, and audit payload exclusion.

- [ ] **Step 2: Run tests and verify RED**

Run: `cd backend && pytest tests/test_finding_remediation_api.py -q`

Expected: route import or 404 failures.

- [ ] **Step 3: Implement schemas, router, scoped loaders, task creation, race recovery, and audit emission**

Use one database transaction. On uniqueness failure, roll back only the nested savepoint and reload the existing task so unrelated request work is not discarded.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cd backend && pytest tests/test_finding_remediation_api.py -q`

Expected: all endpoint tests pass.

- [ ] **Step 5: Run adjacent backend tests**

Run: `cd backend && pytest tests -q -k "finding or inbox or audit or main"`

Expected: pass.

### Task 4: Frontend remediation card

**Files:**
- Create: `frontend/src/types/remediation.ts`
- Create: `frontend/src/components/FindingRemediationCard.tsx`
- Create: `frontend/src/components/__tests__/FindingRemediationCard.test.tsx`
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Produces: `getFindingRemediationPlan(contractId, findingId, options)`
- Produces: `createFindingRemediationTask(contractId, findingId, payload, options)`
- Produces: `<FindingRemediationCard contractId finding />`

- [ ] **Step 1: Write failing component tests**

```tsx
it("does not fetch until Plan remediation is opened", async () => {
  render(<FindingRemediationCard contractId={CONTRACT_ID} finding={FINDING} />);
  expect(getFindingRemediationPlan).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /plan remediation/i }));
  expect(getFindingRemediationPlan).toHaveBeenCalledTimes(1);
});
```

Cover provenance, scope warning, no-language state, copy action, create task, existing task, API error, and request abort on unmount.

- [ ] **Step 2: Run tests and verify RED**

Run: `cd frontend && npx vitest run src/components/__tests__/FindingRemediationCard.test.tsx`

Expected: missing module failure.

- [ ] **Step 3: Implement typed API calls and focused component**

Keep plan fetch lazy. Do not fetch plans for every finding during run load. Use functional state updates and primitive effect dependencies.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same Vitest command.

Expected: pass.

- [ ] **Step 5: Run TypeScript check**

Run: `cd frontend && npx tsc -b`

Expected: pass.

### Task 5: Integrate one review source of truth

**Files:**
- Modify: `frontend/src/components/ReviewPanel.tsx`
- Modify: `frontend/src/components/__tests__/ReviewPanel.test.tsx`

**Interfaces:**
- Consumes: `FindingRemediationCard`
- Produces: one backend-grounded review list with remediation controls

- [ ] **Step 1: Replace the old duplicate-checklist test with failing integration assertions**

```tsx
it("uses persisted playbook results as the only review source", async () => {
  render(<ReviewPanel contractId={CONTRACT_ID} selectedKey={null} onSelect={() => {}} />);
  await screen.findByText("Governing law should be California");
  expect(screen.queryByTestId("deterministic-review-findings")).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /plan remediation/i })).toHaveLength(2);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd frontend && npx vitest run src/components/__tests__/ReviewPanel.test.tsx`

Expected: duplicate checklist still present and remediation buttons missing.

- [ ] **Step 3: Remove `DEFAULT_DETERMINISTIC_RULES` and its derived section, then render the remediation card for each persisted finding**

Do not change exact evidence selection behavior or reviewer status buttons.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same Vitest command.

Expected: pass.

### Task 6: Demo parity

**Files:**
- Modify: `frontend/src/lib/mockApi.ts`
- Test: `frontend/src/components/__tests__/FindingRemediationCard.test.tsx`

**Interfaces:**
- Produces: deterministic mock plan and session-scoped task reuse

- [ ] **Step 1: Add failing demo-mode test**

```tsx
it("reuses a session task in demo mode", async () => {
  const first = await createFindingRemediationTask(CONTRACT_ID, FINDING_ID, {});
  const second = await createFindingRemediationTask(CONTRACT_ID, FINDING_ID, {});
  expect(second.task.id).toBe(first.task.id);
  expect(second.created).toBe(false);
});
```

- [ ] **Step 2: Run and verify RED**

Run the focused Vitest file.

Expected: missing mock implementation.

- [ ] **Step 3: Implement seeded plan selection and module-scoped task state**

Mock text must identify its approved source and must not say it was AI-generated.

- [ ] **Step 4: Run and verify GREEN**

Run the focused Vitest file.

Expected: pass.

### Task 7: Local verification gate and release metadata

**Files:**
- Delete: `.github/workflows/ci.yml`
- Create: `scripts/verify-local.sh`
- Create: `scripts/verify-local.ps1`
- Create: `CHANGELOG.md`
- Create: `docs/releases/v0.1.0-alpha.1.md`
- Modify: `backend/pyproject.toml`
- Modify: `backend/app/main.py`
- Modify: `frontend/package.json`
- Modify: `README.md`

**Interfaces:**
- Produces: local commands that run frontend tests, TypeScript, production build, service-worker check, production dependency audit, backend tests, Ruff, backend dependency audit, and Docker Compose validation.

- [ ] **Step 1: Write a shell-level smoke test for command coverage**

Run:

```bash
grep -F "pytest" scripts/verify-local.sh
grep -F "ruff check" scripts/verify-local.sh
grep -F "vitest run" scripts/verify-local.sh
grep -F "tsc -b" scripts/verify-local.sh
grep -F "docker compose config -q" scripts/verify-local.sh
```

Expected before implementation: files do not exist.

- [ ] **Step 2: Create local gates and remove hosted workflow**

Both scripts must fail fast, preserve the existing audit exclusions, and print which gate is running.

- [ ] **Step 3: Align version metadata and release notes**

Set backend package, FastAPI app, and frontend package versions to `0.1.0-alpha.1`.

- [ ] **Step 4: Run both script syntax checks**

Run:

```bash
bash -n scripts/verify-local.sh
pwsh -NoProfile -Command '$null = [System.Management.Automation.Language.Parser]::ParseFile("scripts/verify-local.ps1", [ref]$null, [ref]$null)'
```

Expected: pass.

### Task 8: Full local verification and merge preparation

**Files:** all changed files

- [ ] **Step 1: Run complete local verification**

Run: `bash scripts/verify-local.sh`

Expected: every gate passes without GitHub Actions.

- [ ] **Step 2: Run focused security assertions**

Run:

```bash
rg -n "wrapped_dek|storage_key|evidence_text|suggested_language" backend/app/api/remediation.py backend/app/security/audit_log.py
```

Expected: no legal text is placed in audit details or task metadata; response schemas may contain `suggested_language` by design.

- [ ] **Step 3: Review the complete branch diff**

Confirm no unrelated refactor, no generated dependencies, no Actions workflow, exact version consistency, migration chain correctness, and no secrets.

- [ ] **Step 4: Merge the verified branch into `main` without opening a pull request that would trigger hosted CI**

Use a fast-forward or squash merge only after all local verification passes.

- [ ] **Step 5: Create GitHub prerelease `v0.1.0-alpha.1` from the verified `main` commit**

Use `docs/releases/v0.1.0-alpha.1.md` as the release body and mark it prerelease.

- [ ] **Step 6: Verify repository state**

Confirm:

- `main` points at the merged commit;
- tag `v0.1.0-alpha.1` targets that commit;
- release is visible and marked prerelease;
- no GitHub Actions run was created for the work;
- there are no open implementation pull requests.