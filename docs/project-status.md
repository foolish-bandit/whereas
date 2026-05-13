# Project status — Whereas

**As of 2026-05-13. Pre-v0.1.**

This page is the evaluator-facing status snapshot for the current MVP.
It distinguishes what works today, what needs near-term polish, what is
planned later, and what belongs to future AI/automation phases.

> Whereas remains pre-v0.1 and not production-certified. Review
> [security-notes.md](security-notes.md) before exposing a deployment.

## Works today (MVP-ready evaluation scope)

- Coherent CLM workflow surfaces across **Dashboard → Intake/Inbox → Requests → Repository → Approvals**.
- Request detail stage + next-action guidance and request-to-repository handoff UX.
- Agreement Templates catalog/detail flow, plus repository workspaces and document history surfaces.
- Clause Manager and Playbooks as review-standards surfaces.
- Integrations roadmap page with explicit planned-vs-available labeling.
- Known Limitations route for evaluator-safe boundaries.

## Next polish (near-term)

- Continue copy/empty-state clarity so first-time evaluators can complete the full demo workflow without onboarding help.
- Tighten cross-linking between README, in-app Known Limitations, and Integrations roadmap content.
- Expand smoke-test guidance as routes/copy evolve.

## Later integrations (post-MVP)

- Email/chat/CRM connector execution (for example Outlook/Gmail/Slack/Teams/Salesforce).
- Calendar/reminder sync and broader notification orchestration.
- Additional enterprise deployment controls and operational tooling.

## Future AI/automation

- Richer structured supporting-question answer persistence in backend models.
- Deeper Clause ↔ Playbook relationship and automation loop.
- Broader AI-assisted review/automation features beyond current deterministic workflow aids.

## Important boundaries

- Demo data is fictional.
- Some UX behavior may be session/browser-state scoped in demo paths.
- Metadata/guidance output requires human review.
- Whereas does not provide legal advice.

## Verification references

- [README.md](../README.md) — evaluator-facing MVP release notes.
- [mvp-smoke-checklist.md](mvp-smoke-checklist.md) — workflow validation.
- [deployment-smoke-test.md](deployment-smoke-test.md) — deployment verification checks.
- [security-notes.md](security-notes.md) — security/privacy boundaries.
