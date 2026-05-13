# Whereas small-model AI architecture (canonical)

**Status:** Architecture roadmap and guardrails document (not a statement of fully implemented functionality).

This document defines Whereas's canonical AI strategy for MVP and default deployments. The strategy is intentionally narrow: **small models only, deterministic workflow first, and human-reviewed outputs grounded in source text and playbooks**.

## Core principles

- **Small models only** by default.
- **Local/self-hostable first** deployment direction.
- **Deterministic workflow first** before optional generative assistance.
- **Playbook-grounded review** over freeform model judgment.
- **Source-span citations required** for findings and extraction outputs.
- **Human review remains required** for operational use.

## 1) Hard model-size rule

- No default model may exceed **2B parameters**.
- Large cloud LLMs are **out of scope** for the MVP/default product.
- Any future cloud/BYOM provider support must be:
  - explicit,
  - optional,
  - admin-controlled,
  - and disabled by default.

## 2) Canonical AI pipeline

Whereas AI-assisted review should follow this sequence:

**Official artifacts**
→ **Text preview**
→ **deterministic extraction**
→ **small NER / classifier models**
→ **small embeddings**
→ **reranker**
→ **playbook-grounded findings**
→ **optional ≤2B explanation/drafting model**
→ **human review**

### Pipeline notes

- Official artifacts remain the source of truth.
- Text preview is derived content for workflow and analysis.
- Deterministic extraction should run before model inference whenever feasible.
- Retrieval and reranking should prioritize approved clauses and playbook rules.
- Any generated explanation should be a short, traceable rendering of structured findings.

## 3) Recommended model classes and defaults

Recommended defaults for the small-model stack:

- **Embeddings:** `BAAI/bge-small-en-v1.5`
- **Reranker:** `BAAI/bge-reranker-base`
- **NER / PII / key fields:** `GLiNER` small variants (including GLiNER PII small where appropriate)
- **Clause classification:**
  - near-term default: deterministic rules + embeddings + GLiNER-style extraction
  - later: small encoder classifier
- **Optional generative model (≤2B):**
  - `Qwen2.5-1.5B-Instruct`, or
  - `SmolLM2-1.7B-Instruct`


### Explanation writer guardrails (planned, disabled by default)

- The ≤2B explanation writer interface is planned and **disabled by default**.
- Default future models remain limited to ≤2B parameters (for example `Qwen2.5-1.5B-Instruct` or `SmolLM2-1.7B-Instruct`).
- The explanation writer may only explain **already grounded findings**.
- It may not create new findings, legal conclusions, or legal advice.
- It must rely only on supplied source excerpts/spans, playbook basis, and approved fallback language.

## 4) What AI may do (planned capabilities, not all active)

Within this architecture roadmap, AI may eventually:

- Extract entities with source spans.
- Classify clauses.
- Retrieve similar clauses and playbook rules.
- Rerank relevant approved clauses.
- Suggest playbook-grounded findings.
- Draft short reviewer explanations from structured findings (when explicitly enabled in a future phase).
- Suggest fallback language from Clause Manager content.

## 5) What AI must not do by default

By default, AI must **not**:

- Perform whole-contract legal review without grounding.
- Produce uncited legal conclusions.
- Upload contracts to cloud LLMs automatically.
- Present outputs as legal advice.
- Replace human review.
- Generate findings without source spans and playbook/approved-clause basis.

## 6) Privacy and security boundaries

- Official artifacts remain authoritative; derived analysis must not overwrite source truth.
- Text preview is derived and should be treated as workflow-view material.
- AI outputs are advisory workflow aids, not binding legal determinations.
- Local/self-hosted deployment is the default direction.
- Raw storage internals must not be exposed in UI/docs/tests.
- Secrets must never be included in logs, docs, tests, or fixtures.

### Explicitly forbidden to expose

Never expose or include:

- `storage_key`
- `wrapped_dek`
- `wrapped_master_key`
- `s3_key`
- raw `metadata_json`
- raw document bytes
- `private_url`
- presigned URLs
- signer PII
- DocuSeal secrets
- webhook secrets
- API tokens
- plaintext template variable values in metadata

## 7) Implementation roadmap (phased)

- **Phase 0:** deterministic workflow, Text preview, metadata, clauses, Playbooks, Clause Manager
- **Phase 1:** embedding provider abstraction
- **Phase 2:** clause similarity / approved language retrieval
- **Phase 3:** GLiNER-style extraction proof of concept
- **Phase 4:** playbook-grounded deterministic findings
- **Phase 5:** optional ≤2B explanation writer
- **Phase 6:** redline/comment drafting

## 8) Honest limitations and non-claims

This document is an architecture roadmap. It does **not** claim that all phases are implemented today.

Clear boundaries:

- No large-model legal review exists in the default product path.
- No Word add-in exists.
- No cloud AI provider is enabled by default.
- Human review remains required before operational/legal use.

## Relationship to existing docs

- Product status snapshot: [project-status.md](project-status.md)
- Security boundaries: [security-notes.md](security-notes.md)
- Evaluator workflow context: [../README.md](../README.md)


## 9) Extraction schema contract (planned, not active)

To support future GLiNER-style small-model extraction, Whereas defines a typed extraction contract in backend schemas. This is architecture preparation only and does not execute models.

Requirements for extraction outputs:

- Outputs must be **span-grounded** (`span_start`, `span_end`, `text`) against source text.
- Entity provenance must be explicit (`rule | gliner | manual | unknown`).
- Confidence values must remain in the `0..1` range.
- Human review remains required for operational/legal use.
- PII detection should run local/self-hosted by default.
- No cloud AI is enabled by default for extraction workflows.
- Raw document bytes must never be included in extraction payloads.
