# Whereas

**The open-source contract repository.**

Built-in clause extraction, playbook deviation analysis, and embedded e-signature via DocuSeal.

> Note: Whereas is currently pre-v0.1 and not ready for production use. If you want to follow along or contribute, watch this repo and read CONTRIBUTING.md.

---

## What it does

Whereas is a self-hostable contract management system aimed at small and mid-sized legal teams who don't want their contracts living on someone else's server. It covers the post-execution side of contract lifecycle management:

- **Repository.** Upload contracts (.docx, .pdf, scanned PDFs via OCR). Search across the corpus. Permission-scope by user and team.
- **Metadata extraction.** On upload, an LLM extracts parties, effective date, term, governing law, contract value, renewal terms, and termination provisions — every field accompanied by a span citation back to the source document and a confidence score.
- **Clause segmentation.** Contracts are segmented and tagged against the CUAD taxonomy (41 clause types). You can extend the taxonomy.
- **Playbook deviation.** Define your firm's positions in YAML (e.g., "indemnification cap ≤ 12 months fees"). Whereas flags clauses that deviate, with severity and a suggested redline.
- **Q&A over your corpus.** RAG-based question answering scoped to user permissions.
- **Embedded e-signature.** DocuSeal runs alongside Whereas in the same Docker Compose. Send contracts for signature without leaving the app.

What Whereas is **not** (yet): a drafting tool, a Word/Outlook plugin, a negotiation/redlining workflow, or a SaaS. Those may come in later versions or never.

## Stack

- **Backend:** Python 3.11, FastAPI, SQLAlchemy, Alembic
- **Database:** Postgres 16 with pgvector
- **Storage:** S3-compatible (MinIO by default for self-host)
- **LLM abstraction:** LiteLLM (default target: Ollama running locally; BYOK for any OpenAI-compatible provider)
- **Embeddings:** BGE-M3 via Ollama or a hosted endpoint
- **Frontend:** React + Vite + Tailwind
- **E-signature:** DocuSeal, deployed alongside Whereas, sharing Postgres
- **Auth:** Whereas-native (Argon2id + sessions). SSO is post-v0.1.

## License

Whereas is licensed under **AGPL-3.0-or-later**. See [LICENSE](LICENSE).

If you modify Whereas and run it as a network service, you must make your modifications available under the same license. If you want a commercially-licensed version (no copyleft obligations), get in touch.

The name "Whereas" and any associated logos are not covered by the AGPL — see [TRADEMARK.md](TRADEMARK.md) for the trademark policy. You can fork the code freely; you cannot ship a fork called "Whereas."

## Quickstart (local dev)

Requires Docker and Docker Compose.

    git clone https://github.com/foolish-bandit/whereas.git
    cd whereas
    ./scripts/generate-secrets.sh   # generates .env with random secrets
    # edit .env if you want to change LLM provider; defaults to local Ollama
    docker compose up -d

Whereas will be available at `http://localhost:8080`. DocuSeal at `http://localhost:8081`. The API at `http://localhost:8000`.

For production deployment, read [docs/deployment-guide.md](docs/deployment-guide.md) before exposing this to the internet. There are non-negotiable hardening steps that the local quickstart skips.

For the security architecture and threat model, see [docs/security-model.md](docs/security-model.md).

For frontend-only development (without the full Docker stack), see
[frontend/README.md](frontend/README.md). The frontend dev server runs on
`http://localhost:5173` and expects the backend at `VITE_API_BASE_URL`
(default `http://localhost:8000`).

## Project status

- [x] Repo scaffold
- [ ] Document upload + storage
- [ ] Metadata extraction with span citations
- [ ] CUAD clause segmentation
- [ ] Playbook YAML schema and deviation engine
- [ ] DocuSeal integration (embedded + auth bridge)
- [ ] RAG Q&A
- [ ] Permissioning model
- [ ] First tagged release (v0.1)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Whereas is community-driven; PRs welcome. Read [the design principles](docs/design-principles.md) before proposing significant changes.

## Acknowledgments

Whereas builds on the work of:
- [DocuSeal](https://www.docuseal.com/) for the e-signature layer
- [CUAD](https://www.atticusprojectai.org/cuad) for the contract clause taxonomy and dataset
- [LiteLLM](https://github.com/BerriAI/litellm) for provider-agnostic LLM access
- [pgvector](https://github.com/pgvector/pgvector) for embedding storage
