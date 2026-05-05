# CLAUDE.md

Conventions for Claude Code working on this repository. Read this at the start of every session.

## Project summary

Whereas is an open-source, self-hostable contract repository for small and mid-sized legal teams that don't want their contracts on someone else's server. It handles the post-execution side of contract lifecycle management: storage and search, LLM-driven metadata extraction with span citations, CUAD-based clause segmentation, YAML-defined playbook deviation analysis, RAG Q&A scoped to user permissions, and embedded e-signature via DocuSeal running alongside in the same Docker Compose. The project is pre-v0.1 and not production-ready.

## License

- Whereas is licensed under **AGPL-3.0-or-later**.
- **Do not** add per-file copyright or license headers. The root `LICENSE` file covers the whole tree; per-file headers are noise here.
- Every contribution must be compatible with AGPL-3.0-or-later. Don't pull in code under incompatible licenses (proprietary, GPL-2.0-only, etc.) and don't propose loadable proprietary modules or vendor-privileged hooks that route around the AGPL.

## Stack

- **Backend:** Python 3.11, FastAPI, SQLAlchemy 2.0 (async), Alembic
- **Database:** Postgres 16 with pgvector
- **Object storage:** MinIO / any S3-compatible store
- **LLM abstraction:** LiteLLM, defaulting to a local Ollama instance; users BYOK any OpenAI-compatible provider
- **Document parsing:** Docling
- **Frontend:** React + Vite + Tailwind
- **E-signature:** DocuSeal (peer service, not embedded code)

## Non-negotiable design rules

These come from `docs/design-principles.md`. PRs that violate them get rejected.

1. **Span citations are mandatory.** Every piece of information surfaced from a contract — extracted metadata, clause classifications, deviation findings, Q&A answers — must include a span citation back to the source document and a confidence score. The UI must display both. If you can't cite it, don't surface it.
2. **Documents never leave the deployment by default.** Whereas runs locally; documents stay on the tenant's infrastructure unless the user explicitly configures a remote LLM provider. Any feature that would exfiltrate document content to a third party must be opt-in and clearly disclosed.
3. **LiteLLM is the only LLM seam — no vendor lock-in.** Don't hard-code a specific provider, prompt-engineer for one model's quirks without a fallback, or assume frontier-model capabilities that aren't available locally. Default deployment must work against local Ollama.
4. **Self-host is the primary deployment.** Every feature must work on a single machine running `docker compose up`. No hard dependency on managed cloud services.
5. **Boring tech where possible.** Postgres over a vector-only DB, FastAPI over something more interesting, etc. The interesting parts are the legal-domain logic.

## Testing

- Test runner is **pytest**. Backend tests live in `backend/tests/`.
- **Every PR must include tests for new behavior.** Bug fixes need a regression test. Features need coverage of the happy path and the meaningful edge cases.
- **Security-critical code (anything under `backend/app/security/`) must have exhaustive tests.** That includes tampering scenarios, malformed input, authorization edge cases, and replay/forgery cases. Default to over-testing here, not under-testing.

## Git workflow

- **Branch protection is on for `main`.** Never push directly to `main`.
- Create a feature branch (e.g., `feat/...`, `fix/...`, `chore/...`), commit, push, then open a PR with `gh pr create`. The user reviews and merges.
- Use the `gh` CLI for all GitHub operations (PRs, issues, reviews, status checks). Don't paste GitHub URLs back at the user when a `gh` command would do.
- Don't force-push shared branches. Don't rewrite history on anything that's been pushed unless explicitly asked.

## Pre-commit checks

Before declaring a task done, run both of these from the repo root and make sure they pass:

```
ruff check .
pytest
```

If either fails, fix the underlying issue — don't disable the rule or skip the test.

## When in doubt, ask

If you're choosing between two reasonable architectural approaches (which abstraction to use, how to structure a module, where a new boundary belongs, how to model a piece of data), **ask the user before choosing.** Don't guess on architecture. A short clarifying question is always cheaper than ripping out a wrong design later.

Day-to-day, mechanical decisions (variable names, obvious refactors, test layout that follows existing patterns) don't need a check-in.

## Things NOT to do

- **Do not invent telemetry.** No phone-home, no anonymous usage stats, no "just a heartbeat." Telemetry is off by default and is not added without an explicit, scoped request from the maintainers.
- **Do not add a hard dependency on a specific LLM provider.** Everything LLM-related goes through LiteLLM. No `import openai` in feature code, no provider-specific SDKs as required dependencies, no prompts that only work on one vendor's model without a fallback path.
- **Do not weaken the AGPL posture.** No loadable proprietary modules, no vendor-privileged APIs, no dual-licensing shims in the open-source tree, no per-file headers that contradict the root license. If a commercial use case doesn't fit AGPL, that's a maintainer conversation, not a code change.
- **Do not pretend Whereas gives legal advice.** Documentation, error messages, and UI copy must reflect that Whereas surfaces information about contracts; it does not replace human legal review.
- **Do not duplicate DocuSeal functionality** (template fields, signature collection, audit trails). DocuSeal is a peer service. Integrate; don't reimplement.
