# Finding Remediation Workflow Design

Date: 2026-08-04
Status: Implemented design

## Problem

Whereas can persist deterministic playbook failures and show playbook guidance, but the real workflow stops before execution. Reviewers can acknowledge or ignore a finding, yet they cannot reliably answer three practical questions from the finding itself:

1. What approved language should we use?
2. Why was that language selected?
3. How do we turn this finding into one traceable unit of work without creating duplicates?

The demo finding surface previously contained a canned suggested redline, but the persisted finding workflow did not have a provenance-aware remediation model. Copying that behavior into production would have been misleading because it would imply generated legal language without an approved source.

## Goal

Add a deterministic, provenance-preserving remediation plan for each persisted failed finding, plus an explicit action that creates, reuses, or reopens one durable Inbox task linked to that finding.

## Non-goals

- No automatic Repository record editing.
- No LLM-generated clause language.
- No fuzzy or embedding-based template selection.
- No new task-management subsystem.
- No automatic task creation for every failed finding.
- No copying clause text or evidence text into audit-log details, link rows, or Inbox metadata.

## User flow

1. A reviewer opens a persisted playbook review run.
2. A failed finding shows a `Plan remediation` action.
3. Whereas loads the plan only when the reviewer opens it.
4. The plan shows:
   - the approved language, when available;
   - its source and source name;
   - a plain-language selection rationale;
   - a scope warning when a Clause Manager fallback is more specific than the Repository record;
   - whether a remediation task already exists.
5. The reviewer can copy approved language.
6. The reviewer can create a remediation Inbox task.
7. Repeating the action returns the same task.
8. If the task was dismissed, the action reopens that same task instead of creating another historical duplicate.
9. Whereas never edits the Repository record automatically.

## Selection policy

### Step 1: Playbook language

Use `DeviationFinding.preferred_language` when its trimmed value is non-empty.

Response provenance:

- `source_type`: `playbook_preferred_language`
- `source_id`: the finding's `playbook_id`
- `source_name`: the finding's rule title
- `rationale`: `Firm-authored preferred language was stored with this playbook rule.`

### Step 2: Clause Manager fallback

When playbook preferred language is absent, find active `ClauseTemplate` rows in the same organization whose normalized `clause_type` equals the finding's normalized `clause_type`.

Normalization:

- trim leading and trailing whitespace;
- lowercase;
- replace runs of spaces, hyphens, and underscores with a single underscore.

Ranking, highest priority first:

1. `preferred` tag present, case-insensitive.
2. `default` tag present, case-insensitive.
3. no `jurisdiction` and no `contract_type`.
4. `updated_at` descending.
5. UUID string ascending for a stable tie-break.

A template's `jurisdiction` and `contract_type` do not exclude it in version one. Instead, the response includes `scope_warning` when either value is present so the reviewer can confirm fit. This prevents a silent false-negative while remaining honest about scope.

Response provenance:

- `source_type`: `clause_template`
- `source_id`: Clause Manager template ID
- `source_name`: Clause Manager template name
- `rationale`: a deterministic summary of the ranking factors that selected the template

### Step 3: No approved language

When neither source exists, return a valid plan with `suggested_language = null`, `source_type = none`, and a message instructing the reviewer to add preferred language to the playbook rule or an active Clause Manager template. Task creation remains available because identifying and assigning the work is still useful.

## Task and provenance model

The final implementation uses a dedicated tenant-scoped link model rather than adding remediation-specific columns to the generic Inbox model.

`FindingRemediationTask` contains:

- `organization_id`
- `finding_id` referencing `deviation_findings.id`
- `inbox_item_id` referencing `inbox_items.id`
- `source_type`
- `source_id`
- timestamps

Database constraints enforce:

```text
UNIQUE (organization_id, finding_id)
UNIQUE (inbox_item_id)
```

This model has three advantages over an `InboxItem.finding_id` column:

1. Inbox remains a generic work-queue surface instead of accumulating feature-specific linkage fields.
2. One durable task per finding is enforced independently of editable Inbox status.
3. Approved-source provenance has a typed home without copying legal text.

The link table is included in the Row-Level Security registry and has a direct organization policy. The unique finding link is also the concurrency backstop for racing create requests.

Generic Inbox behavior is protected:

- generic create cannot use `item_type = finding_remediation`;
- a generic patch cannot convert another item into a remediation item;
- a generic patch cannot alter the remediation item's contract linkage, item type, or provenance metadata;
- normal work fields such as status, assignee, due date, priority, title, and description remain editable;
- soft-dismiss remains available, and the specialized endpoint reopens the same durable task.

Task defaults:

- `item_type`: `finding_remediation`
- `title`: `Remediate: <rule title>`
- `description`: safe workflow copy that identifies the clause type and directs the reviewer to the linked Repository record, without embedding evidence or approved clause text
- `assigned_to`: current user
- `contract_id`: finding contract
- `priority` mapping:
  - blocker or critical to urgent
  - high to high
  - medium to normal
  - low or unknown to low
- `metadata_json`: identifiers and provenance only

## API

### GET plan

`GET /api/contracts/{contract_id}/findings/{finding_id}/remediation`

Returns `FindingRemediationPlanResponse`:

- finding identifiers and status
- suggested language and provenance
- rationale and optional scope warning
- existing task, when present

Cross-organization findings and mismatched contract/finding pairs return 404.

### POST task

`POST /api/contracts/{contract_id}/findings/{finding_id}/remediation/task`

Optional body:

```json
{
  "due_date": "2026-08-14",
  "assigned_to": "user-uuid"
}
```

When omitted, the current user is assigned and due date is null for a newly created task.

Returns `FindingRemediationTaskResponse`:

- `task`
- `created`: true only for a new task
- `reopened`: true only when a dismissed task was reopened
- current remediation plan

The handler performs an initial lookup, then relies on the unique link constraint as the concurrency backstop. New Inbox and link rows are created inside a nested transaction so a racing loser cannot leave an orphan Inbox item. An `IntegrityError` caused by a concurrent winner is recovered by reloading the existing linked task.

## Audit

The hash-chained audit log records:

- `finding.remediation_task.created`
- `finding.remediation_task.reopened`

Safe details:

- finding ID
- contract ID
- Inbox item ID
- review run ID
- playbook ID
- rule ID
- clause type
- severity
- source type
- source ID when present

Forbidden details:

- evidence text
- suggested clause text
- guidance text
- source display name
- counterparty data
- storage internals

No event is written when an existing non-dismissed task is merely returned.

## Frontend

A focused `FindingRemediationCard` is rendered inside each persisted failed finding row.

Behavior:

- lazy-load the plan on expansion;
- abort stale requests when the row unmounts;
- render provenance before language;
- copy only on explicit click;
- create or reopen work through the specialized endpoint;
- update local state with the returned task;
- show a deep link to Inbox;
- render a no-language state without disabling task creation;
- never render storage or encryption internals;
- state explicitly that Whereas does not edit the Repository record automatically.

The separate client-side `DEFAULT_DETERMINISTIC_RULES` checklist was removed from the real `ReviewPanel`. Persisted backend playbook runs are the single source of review truth, avoiding duplicate or contradictory findings.

## Demo mode

A dedicated remediation API client provides deterministic demo plans and keeps task state in module memory. It applies the same source priority as the backend and never implies that approved text was generated by AI. Demo task metadata contains identifiers and provenance only.

## Security and tenancy

- Every finding, template, task, assignee, and contract query is scoped to `organization_id`.
- `finding_remediation_tasks` is included in the direct-organization RLS registry.
- The dedicated foreign-key links do not expose cross-tenant data.
- The frontend client recursively removes known storage and key-management fields from responses as defense in depth.
- Audit payloads, task metadata, and link rows contain identifiers, not document text.
- Generic Inbox endpoints cannot forge or relink remediation work.

## Release policy

This feature ships as `v0.1.0-alpha.1`, reflecting the repository's documented pre-v0.1 evaluation status. Backend, frontend, API metadata, changelog, and release notes use the same version.

Verification is run locally first using the repository's complete test, type-check, build, lint, audit, migration, and Compose gates. The existing GitHub Actions workflow remains the repository merge gate rather than being removed as part of an unrelated product feature.