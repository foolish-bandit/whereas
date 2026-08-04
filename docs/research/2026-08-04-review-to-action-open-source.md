# Review-to-Action Open-Source Research

Date: 2026-08-04

## Question

What should Whereas borrow from mature open-source legal, document, workflow, and vulnerability-management projects to turn a verified playbook finding into useful work without weakening provenance or inventing legal language?

## Projects reviewed

### OpenContracts / cite

Source: https://github.com/Open-Source-Legal/cite

Useful pattern:

- Treat source annotations and exact spans as ground truth.
- Let automated systems propose work while preserving a human acceptance step.
- Keep source evidence and downstream actions linked rather than copying untraceable summaries.

Applied to Whereas:

- A remediation plan remains attached to one persisted `DeviationFinding`.
- The finding's exact evidence span stays visible and unchanged.
- Whereas suggests approved language, but never edits the document automatically.

### DefectDojo

Sources:

- https://github.com/DefectDojo/django-DefectDojo
- https://docs.defectdojo.com/en/working_with_findings/finding_deduplication/

Useful pattern:

- Findings have an explicit lifecycle after detection.
- Deduplication is part of the workflow model, not a cosmetic UI behavior.
- Work should be linked back to the finding that created it.

Applied to Whereas:

- A finding can create one active `finding_remediation` Inbox item.
- A database constraint enforces idempotency under concurrent requests.
- Repeated clicks return the existing active task instead of creating duplicates.

### GitHub code scanning

Source: https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/tracking-code-scanning-alerts-in-issues

Useful pattern:

- An alert can be promoted into a normal work item while retaining a link to the originating alert.
- Existing work is reused rather than silently duplicated.

Applied to Whereas:

- The Inbox task stores a typed `finding_id` foreign key.
- The task opens the linked Repository record and carries safe finding identifiers in metadata.
- Finding text, evidence text, and approved clause text are not copied into audit metadata.

### Paperless-ngx

Sources:

- https://github.com/paperless-ngx/paperless-ngx
- https://docs.paperless-ngx.com/advanced_usage/#workflows

Useful pattern:

- Deterministic workflows and metadata rules should do routine routing before AI is considered.
- User-visible automation should make its rule and destination understandable.

Applied to Whereas:

- Clause selection uses a deterministic ranking policy.
- The API returns the selected source, rationale, and any scope warning.
- No remote or local language model is called.

### n8n and Activepieces

Sources:

- https://github.com/n8n-io/n8n
- https://github.com/activepieces/activepieces

Useful pattern:

- Human-in-the-loop work is a first-class state transition.
- Versioned, observable workflow steps are preferable to hidden automation.

Applied to Whereas:

- Creating a remediation task is explicit and user-triggered.
- Task creation is recorded in the append-only audit chain.
- The plan can be inspected before any work item is created.

### Documenso and Cicero

Sources:

- https://github.com/documenso/documenso
- https://github.com/accordproject/cicero-ui

Useful pattern:

- Reusable approved templates should be first-class objects.
- Execution and authoring should remain separate concerns.

Applied to Whereas:

- Firm-authored playbook language has highest priority.
- Clause Manager is the deterministic fallback source.
- The remediation plan references approved text but does not modify Clause Manager or the source document.

## Adopted decision

Whereas will add a first-class remediation plan for persisted failed findings.

Selection order:

1. Use the finding's persisted playbook `preferred_language` when present.
2. Otherwise select an active Clause Manager template with the same normalized `clause_type`.
3. Rank matching templates by explicit `preferred` tag, then `default` tag, then broadly reusable scope, then most recent update, then stable UUID tie-break.
4. Return no language when no approved source exists.

The result includes provenance and rationale. It never fabricates a clause.

## Rejected ideas

### Generate a redline with an LLM

Rejected because legal language would no longer be clearly attributable to an approved firm source. This also conflicts with Whereas's deterministic-first and local-document principles.

### Automatically replace source text

Rejected because a finding is review evidence, not permission to mutate a legal document. Remediation remains a human-controlled work item.

### Store the link only in `metadata_json`

Rejected because an untyped JSON link cannot provide referential integrity or concurrency-safe uniqueness.

### Create a task on every review failure automatically

Rejected because not every finding deserves a work item, and automatic creation would flood the Inbox. The reviewer chooses when to promote a finding into work.

### Match Clause Manager language by fuzzy semantic similarity

Rejected for the first version because exact normalized clause taxonomy is explainable and testable. Semantic fallback can be reconsidered after the taxonomy is stable and measured.