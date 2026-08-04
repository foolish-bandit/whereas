# Finding Remediation Workflow Design

Date: 2026-08-04  
Status: Implemented for `v0.1.0-alpha.1`

## Problem

Whereas could persist deterministic playbook failures and show firm-authored guidance, but the real workflow stopped before execution. Reviewers could acknowledge or ignore a finding without a reliable way to answer:

1. What approved language should be considered?
2. Why was that language selected?
3. How can the finding become one traceable unit of work without duplicates?

The demo surface previously contained a canned redline. Copying that behavior into production would have implied generated legal language without a firm-approved source.

## Goal

Give each persisted failed finding a deterministic, provenance-preserving remediation plan and an explicit action that creates, reuses, or reopens one Inbox task linked to that finding.

## Non-goals

- No automatic Repository record editing.
- No LLM-generated clause language.
- No fuzzy or embedding-based template selection.
- No second task-management subsystem.
- No automatic task creation for every failure.
- No evidence text, guidance text, clause text, or source display names in task metadata, link rows, or audit details.

## User flow

1. A reviewer opens a persisted playbook review run.
2. A failed finding exposes **Plan remediation**.
3. Whereas loads the plan only when the reviewer expands it.
4. The plan shows approved language when available, its source, a plain-language rationale, any scope warning, and existing task state.
5. The reviewer may copy approved language explicitly.
6. The reviewer may create one remediation Inbox task.
7. Repeating the action returns the existing task.
8. A dismissed task is reopened in place rather than duplicated.
9. Superseded findings remain inspectable but cannot create or reopen work. Reviewers must use the latest review run.

## Approved-language policy

### 1. Playbook preferred language

Use `DeviationFinding.preferred_language` when its trimmed value is non-empty.

Provenance:

- `source_type`: `playbook_preferred_language`
- `source_id`: finding `playbook_id`
- `source_name`: finding rule title
- rationale: firm-authored preferred language was stored with the rule

### 2. Clause Manager fallback

When playbook language is absent, consider active `ClauseTemplate` rows in the same organization whose normalized `clause_type` equals the finding's normalized `clause_type`.

Normalization:

- trim surrounding whitespace;
- lowercase;
- collapse runs of spaces, hyphens, and underscores to one underscore.

Ranking, highest priority first:

1. `preferred` tag, case-insensitive;
2. `default` tag, case-insensitive;
3. no `jurisdiction` and no `contract_type`;
4. `updated_at` descending;
5. UUID string ascending as a stable tie-break.

A scoped template is not silently excluded in version one. The response carries a scope warning so the reviewer can confirm fit.

### 3. No approved source

When neither source exists, return a valid plan with:

- `suggested_language = null`
- `source_type = none`
- a clear instruction to add preferred playbook language or an active Clause Manager source

Task creation remains available because assigning research or drafting work can still be useful. Whereas never fabricates a clause.

## Persistence model

Keep Inbox generic. Add a tenant-scoped one-to-one link entity: `FindingRemediationTask`.

Fields:

- `organization_id`
- `finding_id`, foreign key to `deviation_findings`, `ON DELETE CASCADE`
- `inbox_item_id`, foreign key to `inbox_items`, `ON DELETE CASCADE`
- `source_type`
- `source_id`
- timestamps

Constraints:

- unique `(organization_id, finding_id)`
- unique `inbox_item_id`

This creates one durable work record per finding. Completed work is reused. Dismissed work is reopened in place so history does not fragment.

The table has forced PostgreSQL Row-Level Security using the same organization session setting as other tenant-scoped tables.

## Inbox task defaults

- `item_type`: `finding_remediation`
- title: `Remediate: <rule title>`
- description: safe workflow copy identifying the clause type and linked Repository record, without legal text
- assignee: current user unless an active same-organization user is supplied
- `contract_id`: finding contract
- priority:
  - blocker or critical → urgent
  - high → high
  - medium → normal
  - low or unknown → low
- metadata: identifiers and normalized provenance only

Generic Inbox create/update routes cannot create a remediation item or alter its linkage/provenance. Status, assignment, priority, due date, title, and description remain ordinary work-queue fields.

## API

### Inspect plan

`GET /api/contracts/{contract_id}/findings/{finding_id}/remediation`

Returns finding identity and lifecycle state, approved language and provenance, rationale, optional scope warning, and an existing Inbox task when linked.

Cross-organization findings and mismatched contract/finding pairs return 404.

### Create or reopen task

`POST /api/contracts/{contract_id}/findings/{finding_id}/remediation/task`

Optional body:

```json
{
  "due_date": "2026-08-14",
  "assigned_to": "user-uuid"
}
```

The response includes `task`, `created`, `reopened`, and the current remediation plan.

A nested transaction creates the Inbox item and typed link atomically. The unique finding constraint is the concurrency backstop. A racing loser rolls back its savepoint and reloads the winner's task.

Superseded findings return 409 for task creation or reopening.

## Audit

Task creation and reopening emit distinct hash-chained events:

- `finding.remediation_task.created`
- `finding.remediation_task.reopened`

Safe details:

- finding ID
- contract ID
- Inbox item ID
- review run ID
- playbook ID
- rule ID
- normalized clause type
- severity
- source type
- source ID when present

Forbidden details:

- evidence text
- suggested clause text
- guidance text
- source display names
- counterparty data
- storage internals

No event is emitted when an existing non-dismissed task is merely returned.

## Frontend

`FindingRemediationCard` is rendered inside each persisted failed finding row.

Behavior:

- lazy plan fetch on expansion;
- abort stale plan and task requests on unmount or finding change;
- provenance rendered before approved language;
- explicit copy action;
- specialized task endpoint only;
- local state updated from the returned task;
- direct Inbox link;
- honest no-language state;
- superseded-run warning with no create/reopen action;
- no storage or encryption internals.

The old client-only deterministic checklist was removed. Persisted backend playbook runs are the sole review source of truth, preventing duplicate or contradictory findings.

## Demo mode

Demo remediation uses the existing session-scoped mock Inbox store, not a private shadow queue. Therefore task creation, listing, completion, dismissal, and reopening remain coherent across the review card and Inbox page.

Demo copy always identifies an approved source and never claims AI generated the language.

## Security and tenancy

- Every finding, template, task link, task, assignee, and Repository record query is organization-scoped.
- The new link table is included in the central RLS registry and migration policy.
- Legal text stays in its authoritative source tables and response body only.
- The frontend secret scrubber remains active on live responses.
- Audit and work-queue metadata contain identifiers, not document content.

## Release and verification policy

This feature ships as `v0.1.0-alpha.1` because Whereas remains an evaluation-stage pre-1.0 project.

GitHub-hosted workflows are removed. Verification is performed explicitly with `scripts/verify-local.sh` or `scripts/verify-local.ps1` before `main` is advanced, so the project does not consume GitHub Actions minutes.