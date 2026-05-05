# Whereas Design Principles

These are the load-bearing decisions that shape Whereas. New features and PRs are evaluated against them. If you want to push back on one, open a Discussion — but do it with a real argument, not a vibe.

## 1. Self-host is the primary deployment

Whereas is built for legal teams who don't want their contracts on someone else's server. Every feature must work on a single machine running `docker compose up`. SaaS-only features are out of scope for the open-source project.

This means:
- No hard dependency on managed cloud services.
- No telemetry on by default.
- No "free tier" gating in the code itself. The code is AGPL; pricing happens elsewhere.

## 2. Span citations are non-negotiable

Every piece of information Whereas surfaces from a contract — extracted metadata, clause classifications, deviation findings, Q&A answers — must include a span citation back to the source document and a confidence score. The UI must show both.

This isn't about UX polish. Lawyers rely on these outputs to make decisions that have malpractice consequences. Hallucinated metadata that looks authoritative is worse than no metadata at all. If you can't cite it, don't surface it.

## 3. The LLM is a dependency, not the product

Whereas uses LLMs for extraction, classification, and Q&A. It does not assume any specific model or provider. LiteLLM is the abstraction layer. Default deployment targets a local Ollama instance; users can BYOK to any OpenAI-compatible provider.

We will not accept PRs that hard-code a specific provider, prompt-engineer for a specific model's quirks without a fallback, or assume frontier-model capabilities that aren't available locally.

## 4. Privacy is the differentiator

Whereas runs locally by default. Documents never leave the user's infrastructure unless the user explicitly configures a remote LLM provider. When a remote provider is used, Whereas should provide hooks for pre-flight masking (e.g., via a Sonomos-style PII layer) — but that integration is opt-in, not bundled.

## 5. Boring tech, where possible

Postgres, not a vector-only database. FastAPI, not a more interesting framework. React, not a more interesting framework. The interesting parts of Whereas are the legal-domain logic, the extraction pipeline, and the playbook engine. Everything else should be the most boring viable choice so contributors can focus on what matters.

## 6. The taxonomy is extensible, not opinionated

Whereas ships with the CUAD 41-clause taxonomy as the default. Users can extend or replace it via configuration. We will not adjudicate the "right" taxonomy. If you want to ship with a different default for your firm, fork the configuration, not the code.

## 7. DocuSeal is a peer, not a child

DocuSeal handles e-signature. Whereas handles everything before signature. We do not duplicate DocuSeal functionality (template fields, signature collection, audit trails) in Whereas. We integrate cleanly and stay out of its lane.

## 8. AGPL means AGPL

We chose AGPL deliberately. Don't propose changes that try to route around it (loadable proprietary modules, vendor-specific privileged APIs, etc.). If you have a commercial use case that AGPL doesn't fit, talk to the maintainers about a separate license — don't try to weaken the open-source one.

## 9. We do not pretend to be lawyers

Whereas is software. It surfaces information about contracts. It does not give legal advice. Documentation, error messages, and UI copy must reflect this. We will reject PRs that imply Whereas can replace human legal review, regardless of how impressive the underlying model is.

## 10. Build for boring durability

Legal teams don't want a tool that needs a major rewrite every 18 months. We optimize for stability over novelty. New features go through a "is this still going to make sense in three years" filter. Trends that haven't been load-bearing for at least a year don't get adopted.
