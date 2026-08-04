# Changelog

All notable changes to Whereas are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version identifiers follow [Semantic Versioning](https://semver.org/) while the project remains pre-1.0.

## [Unreleased]

## [0.1.0-alpha.1] - 2026-08-04

### Added

- Provenance-aware remediation plans for persisted playbook findings.
- Deterministic approved-language selection from playbook preferred language or Clause Manager sources.
- Stable Clause Manager ranking by explicit tags, scope, recency, and UUID tie-break.
- Scope warnings for jurisdiction- or Repository-record-type-specific fallback language.
- One durable, tenant-scoped finding-to-Inbox task link with database uniqueness and Row-Level Security.
- Idempotent remediation task creation and dismissed-task reopening.
- Identifier-only created and reopened audit events.
- Lazy, abortable remediation cards in the Review tab with explicit copy and Inbox actions.
- Honest no-language state that remains assignable as work.
- Deterministic demo-mode remediation plans and session task reuse.
- Backend and frontend tests covering source precedence, tenancy, concurrency, provenance, no-language behavior, copying, retry, abort, and task reuse.
- Open-source design research and implementation documentation.

### Changed

- Persisted backend playbook findings are now the Review tab's single source of truth.
- Removed the separate client-only deterministic checklist that could duplicate or contradict persisted findings.
- Generic Inbox endpoints now reserve and protect `finding_remediation` items.
- User-facing remediation copy consistently refers to the linked Repository record and states that Whereas never edits it automatically.
- Project prerelease version is now `0.1.0-alpha.1` (`0.1.0a1` in Python package metadata).

### Security

- Every remediation query is explicitly organization-scoped and the new link table is protected by direct-org PostgreSQL Row-Level Security.
- Approved language, exact evidence, guidance, source display names, counterparty data, and storage internals are excluded from task metadata, link rows, and audit details.
- Generic Inbox routes cannot forge, convert, or relink remediation work.
- Concurrent task creation uses a database uniqueness constraint and nested transaction to prevent duplicate or orphan work items.

[Unreleased]: https://github.com/zgbrenner/whereas/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/zgbrenner/whereas/releases/tag/v0.1.0-alpha.1
