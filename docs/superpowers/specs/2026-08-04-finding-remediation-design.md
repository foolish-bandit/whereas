# Finding Remediation Workflow Design

Date: 2026-08-04
Status: Approved for implementation by repository owner mandate

## Problem

Whereas can persist deterministic playbook failures and show playbook guidance, but the real workflow stops before execution. Reviewers can acknowledge or ignore a finding, yet they cannot reliably answer three practical questions from the finding itself:

1. What approved language should we use?
2. Why was that language selected?
3. How do we turn this finding into one traceable unit of work without creating duplicates?

The demo finding surface contains a canned suggested redline, but the real persisted finding workflow does not have a provenance-aware remediation model. Copying that demo behavior into production would be misleading because it would imply generated legal language without an approved source.

## Goal

Add a deterministic, provenance-preserving remediation plan for each persisted failed finding, plus an explicit action that creates or reuses one active Inbox task linked to that finding.

## Non-goals

- No automatic document editing.
- No LLM-generated clause language.
- No fuzzy or embedding-based template selection.
- No new task-management subsystem.
- No automatic task creation for every failed finding.
- No copying clause text or evidence text into audit-log details.

## User flow

1. A reviewer opens a persisted playbook review run.
2. A failed finding shows a `Plan remediation` action.
3. Whereas loads the plan only when the reviewer opens it.
4. The plan shows:
   - the approved language, when available;
   - its source and source name;
   - a plain-language selection rationale;
   - a scope warning when a Clause Manager fallback is more specific than the Repository record;
   - whether an active remediation task already exists.
5. The reviewer can copy approved language.
6. The reviewer can create a remediation Inbox task.
7. Repeating the action returns the same active task.
8. After the prior task is dismissed, a reviewer may create a new active task for the same finding.

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

When neither source exists, return a valid plan with `suggested_language = null`, `source_type = none`, and a message instructing the reviewer to add preferred language to the playbook rule or an active Clause Manager template.

## Task model

Add nullable `InboxItem.finding_id` referencing `deviation_findings.id` with `ON DELETE SET NULL`.

Add a partial unique index:

```sql
CREATE UNIQUE INDEX uq_inbox_active_finding_remediation
ON inbox_items (organization_id, finding_id)
WHERE finding_id IS NOT NULL
  AND item_type = 'finding_remediation'
  AND status <> 'dismissed';
```

This permits historical dismissed tasks while enforcing one active or completed remediation task per finding. A completed task remains the work record and is reused. Dismissing it explicitly allows a replacement.

Generic Inbox create/update endpoints do not accept `finding_id`. The specialized remediation endpoint owns this linkage. Inbox responses expose `finding_id` read-only.

Task defaults:

- `item_type`: `finding_remediation`
- `title`: `Remediate: <rule title>`
- `description`: safe workflow copy that identifies the clause type and directs the reviewer to the linked Repository record, without embedding evidence or approved clause text
- `assigned_to`: current user
- `contract_id`: finding contract
- `finding_id`: finding ID
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
- existing active task, when present

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

When omitted, the current user is assigned and due date is null.

Returns `FindingRemediationTaskResponse`:

- `task`
- `created`: true for a new task, false when reusing an existing active/completed task
- current remediation plan

The handler performs an initial lookup, then relies on the unique index as the concurrency backstop. An `IntegrityError` caused by a racing duplicate is recovered by reloading the existing task.

## Audit

Add `finding.remediation_task.created` to the hash-chained audit taxonomy.

Safe details:

- finding ID
- contract ID
- Inbox item ID
- rule ID
- clause type
- severity
- source type
- source ID when present

Forbidden details:

- evidence text
- suggested clause text
- guidance text
- counterparty data
- storage internals

No event is written when an existing task is merely returned.

## Frontend

Add a focused `FindingRemediationCard` component rendered inside each persisted failed finding row.

Behavior:

- lazy-load plan on expansion;
- abort stale requests when the row unmounts;
- render provenance before language;
- copy only on explicit click;
- create task through the specialized endpoint;
- update local state with returned task;
- show a link to Inbox and retain the Repository workspace context;
- render a no-language state without disabling task creation;
- never render storage or encryption internals.

Remove the separate client-side `DEFAULT_DETERMINISTIC_RULES` checklist from the real `ReviewPanel`. The backend playbook review is already the source of truth, and showing both systems creates duplicate and potentially contradictory findings.

## Demo mode

The mock API returns deterministic plans for seeded findings and keeps task state in module memory. Demo mode must not imply that text was generated by AI.

## Security and tenancy

- Every finding, template, task, assignee, and contract query is scoped to `organization_id`.
- The database RLS table list does not change because `inbox_items` and `deviation_findings` are already covered.
- The new foreign key does not expose cross-tenant data.
- API responses continue through the frontend secret scrubber.
- Audit payloads contain identifiers, not document text.

## Release policy

This feature ships as `v0.1.0-alpha.1`, reflecting the repository's documented pre-v0.1 evaluation status. Backend, frontend, API metadata, changelog, and release notes use the same version.

GitHub Actions are not used for verification or release. The repository's hosted-runner workflow is replaced with explicit local verification scripts so agents can run the complete gate without consuming Actions minutes.