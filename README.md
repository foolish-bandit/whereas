# Whereas

**Whereas is an open-source, self-hostable CLM MVP focused on request-to-repository workflow execution.**

This repository is currently **pre-v0.1** and intended for evaluation, contribution, and guided demos rather than production deployment.

## What Whereas is

Whereas helps legal and ops teams run a coherent contract lifecycle workflow across intake, request review, repository management, approvals, document history, and signature handoff.

The product is intentionally opinionated around an evaluator-friendly flow:

- Start from a dashboard command center.
- Route intake work through Inbox and Requests.
- Convert approved requests into Repository records.
- Review text preview, metadata, clauses, approvals, and document history.
- Send signature-ready records through DocuSeal when configured.

## What works today

The following surfaces are implemented and routable in the app today:

- **Dashboard command center** (`/demo/dashboard`) with workflow-oriented shortcuts and summary context.
- **Guided intake** (`/demo/intake`) and **Inbox routing** (`/demo/inbox`) for triage and request/repository direction.
- **Requests workspace** (`/demo/requests`) with guided supporting-question capture and Request Detail stage/next-action guidance.
- **Request-to-Repository conversion UX** from request detail flows where supported.
- **Agreement Templates** catalog and template-detail flow (`/demo/requests/templates` and alias routes).
- **Repository record list + workspace** (`/demo/repository`) including text preview/document context, metadata/clause panels, lifecycle presentation, and document history tooling.
- **Approval surfaces** (`/demo/approvals` + tasks/workflows/templates/policies routes) with existing approval semantics preserved.
- **Clause Manager** (`/demo/clause-manager`) and **Playbooks** (`/demo/playbooks`) as review-standards surfaces.
- **Integrations roadmap page** (`/demo/integrations`) for planned connectors.
- **Known limitations page** (`/demo/known-limitations`) for evaluator-facing boundaries.

> In user-facing docs and UI copy, use **Repository record** terminology (not "Contract") unless discussing backend internals.

## Demo workflow (recommended evaluator path)

1. Open `/demo/dashboard`.
2. Start from `/demo/intake` (or dashboard quick actions) and review `/demo/inbox` routing.
3. Create/open a request at `/demo/requests`.
4. In request detail (`/demo/requests/:id`), review supporting questions, stage, and next action.
5. Convert the request to a Repository record where the flow supports conversion.
6. Open `/demo/repository` and enter a record workspace (`/demo/repository/:id`).
7. Review text preview/document panels, metadata, clauses, lifecycle context, and document history.
8. Review approval work at `/demo/approvals` and `/demo/approvals/tasks`.
9. Explore `/demo/clause-manager` and `/demo/playbooks`.
10. Finish at `/demo/integrations` and `/demo/known-limitations` for roadmap and MVP boundaries.

## Core surfaces

- **Work:** Dashboard, Intake, Inbox, Approvals
- **Library:** Repository, Requests, Templates
- **Knowledge:** Playbooks, Clause Manager
- **Admin:** Settings, Integrations

## What is demo/session-only

- Demo seed data is fictional and intended for walkthroughs, not legal operations.
- Some UI state/editing behavior is demo- or session-scoped and may rely on local/browser state.
- Supporting-question answers are currently summarized into existing free-text request fields; no fully structured backend answer model is shipped yet.
- Integrations marked as planned on the Integrations page are visible roadmap items, not active connectors.
- Deterministic checklist/review guidance is workflow assistance only and is not legal advice.

## What is not implemented yet

The following are intentionally out of scope for the current MVP state:

- Full Microsoft Word add-in / Outlook or Gmail plugin workflows.
- Slack / Teams / CRM connector execution (roadmap visibility exists, wiring does not).
- Calendar/reminder sync and notification automation.
- LLM-powered legal judgment/reasoning features beyond existing extraction/workflow aids.
- Small-model AI roadmap details live in [`docs/AI_SMALL_MODEL_STACK.md`](docs/AI_SMALL_MODEL_STACK.md) and in-app Known limitations (`/demo/known-limitations#small-model-ai-roadmap`).
- Full backend Clause ↔ Playbook relational linkage and authoring loop.
- Enterprise-grade RBAC/SSO deployment story.
- Advanced reporting/export beyond current shipped workspace and activity surfaces.
- Nango / Clerk / PowerSync integration layers.

## Security and privacy boundaries

- The PWA/service worker is expected to keep `/api/*` outside cache handling.
- Sensitive storage internals and secret-bearing fields should never be surfaced in UI/docs.
- Demo data is fictional and should not be treated as confidential client data.
- Machine-generated metadata/extractions require human review before operational use.
- Whereas is software workflow support and **does not provide legal advice**.

See also: [`docs/security-notes.md`](docs/security-notes.md).

## Running locally

Quickstart:

```sh
git clone https://github.com/foolish-bandit/whereas.git
cd whereas
./scripts/generate-secrets.sh
docker compose up -d
```

Default local endpoints:

- App: `http://localhost:8080`
- API: `http://localhost:8000`
- DocuSeal: `http://localhost:8081`

First-run developer setup and optional dependencies:

- [`docs/local-developer-quickstart.md`](docs/local-developer-quickstart.md)
- [`docs/optional-dependencies.md`](docs/optional-dependencies.md)

## Testing

Common commands:

```sh
cd backend && pytest
cd frontend && npx vitest run
cd frontend && npx tsc -b
cd frontend && npm run build
```

Evaluator smoke paths:

- [`docs/mvp-smoke-checklist.md`](docs/mvp-smoke-checklist.md)
- [`docs/deployment-smoke-test.md`](docs/deployment-smoke-test.md)

## Roadmap

For a maintained snapshot of done/next/later scope, see:

- [`docs/project-status.md`](docs/project-status.md)
- `/demo/integrations` (planned connector visibility)
- [`docs/AI_SMALL_MODEL_STACK.md`](docs/AI_SMALL_MODEL_STACK.md) (canonical small-model AI architecture)

## Known limitations

- In-app: `/demo/known-limitations`
- Docs: [`docs/project-status.md`](docs/project-status.md) and [`docs/security-notes.md`](docs/security-notes.md)

## License

Whereas is licensed under **AGPL-3.0-or-later**. See [LICENSE](LICENSE).
