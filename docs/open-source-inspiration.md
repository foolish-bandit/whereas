# Open-source inspiration radar

This note records product patterns worth adapting into Whereas while preserving the project's self-hostable, human-reviewed CLM direction.

## Audited inspiration

| Project | Useful pattern | Whereas adaptation |
| --- | --- | --- |
| Accord Project Cicero / template archive | Contract and clause templates combine natural-language text with structured variables and executable/request-response logic. | Treat agreement templates as parameterized, testable artifacts: variable coverage, fallback clause options, and previewable generated output. |
| Contract Playbook AI | Playbook generation, contract review against playbook rules, and interactive redline-style remediation. | Keep deterministic playbook review as the default, but make findings easier to turn into suggested clause swaps and reviewer tasks. |
| OpenContracts | Legal knowledge is more useful as a graph of connected documents, citations, clauses, and entities than as files in folders. | Move repository UX toward a relationship graph: parties, obligations, clauses, approvals, source documents, renewals, and related records. |
| DocuSeal / Documenso | Self-hostable signing products emphasize reusable templates, direct signing links, API/webhook handoff, and audit trails. | Improve signature handoff around signer packets, template readiness, webhook-backed lifecycle events, and audit evidence surfacing. |
| Twenty CRM | Modern open-source CRM primitives include custom objects, views, workflows, agents, and code-extensible business apps. | Make Repository records feel like configurable business objects without losing CLM defaults: saved views, lifecycle fields, and CRM links. |
| n8n / Activepieces-style automation | Operators expect visual trigger/action automation that stays self-hostable and auditable. | Add a future workflow builder for events such as request submitted, approval blocked, renewal due, signature completed, and metadata changed. |
| NocoBase / low-code business systems | Plugin/data-model-first business apps let teams adapt workflows without forking. | Use admin-defined fields and views for intake/repository metadata once core evaluator flows are stable. |

## Scoped product bets

1. **Template intelligence**: expose variable readiness, fallback clauses, and generated preview checks in template flows.
2. **Graph-first repository**: show relationships among records, parties, clauses, requests, approvals, and signature events.
3. **Automation recipes**: start with curated, auditable recipes before a full visual builder.
4. **Signature packet readiness**: turn DocuSeal handoff into a checklist with signer roles, documents, fields, and audit status.
5. **Review-to-action loop**: convert playbook findings into tasks, clause swaps, and approval-gate remediation.
6. **Open extensibility posture**: document where Whereas should integrate instead of rebuilding broad CRM/workflow/signature surfaces.

## Guardrails

- Keep human review explicit; do not present AI output as legal advice.
- Prefer deterministic checks and traceable evidence over opaque automation.
- Keep `/api/*` outside PWA caching and do not surface secret-bearing integration internals.
- Favor self-hostable, open-source-compatible integrations and designs.
