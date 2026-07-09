"""Embeddings service: turns clause and question text into vectors for
hybrid retrieval (see `app.services.retrieval`).

Design mirrors `app.services.extraction`'s LiteLLM discipline:
- LiteLLM (`litellm.aembedding`) is the only seam; no provider SDK is
  imported directly, and the default model targets local Ollama.
- Outbound text runs through the same pre-LLM hook
  (`app.security.llm_hook`) that gates/redacts remote-provider calls, so
  embedding a clause is held to the same privacy policy as extracting
  metadata from it.
- A disabled provider raises a controlled error rather than silently
  no-op'ing, so callers can distinguish "embeddings are off" from "the
  provider is down."

`populate_clause_embeddings` is the ingest-time hook called from
`app.api.contracts` right after clause segmentation. It is always
best-effort from the caller's point of view (a provider outage must
never fail contract ingest) and only runs against Postgres: the
`Clause.embedding` column is a pgvector `Vector`, and the vector leg of
hybrid retrieval that reads it is Postgres-only, so there is nothing
useful to compute under the sqlite fallback used in tests.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal, Protocol

import litellm
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import Clause
from app.security.llm_hook import LLMCallContext, is_remote_provider, load_hook_from_env

log = logging.getLogger(__name__)
settings = get_settings()

EmbeddingKind = Literal["clause", "qa_question"]


class EmbeddingsDisabledError(RuntimeError):
    """Raised when embeddings are disabled by settings (`EMBEDDINGS_ENABLED=false`)."""


class EmbeddingProviderError(RuntimeError):
    """Raised when the embedding provider returns an unusable response."""


@dataclass(frozen=True)
class EmbeddingInput:
    """Input payload for a single embedding request.

    ``metadata`` must contain only safe/non-sensitive fields suitable for
    logs or the pre-LLM hook context (e.g. ``organization_id``) and
    defaults to ``None``.
    """

    id: str
    text: str
    kind: EmbeddingKind
    metadata: dict[str, str | int | float | bool | None] | None = None


class EmbeddingProvider(Protocol):
    mode: str

    async def embed_texts(self, inputs: list[EmbeddingInput]) -> list[list[float]]:
        """Embed validated ``inputs`` or raise ``EmbeddingsDisabledError``."""


class DisabledEmbeddingProvider:
    """No-op provider that always blocks embedding execution.

    Safety guarantees: no network calls, no model downloads, no storage
    writes.
    """

    mode = "disabled"

    async def embed_texts(self, inputs: list[EmbeddingInput]) -> list[list[float]]:
        _validate_inputs(inputs)
        raise EmbeddingsDisabledError(
            "Embeddings are disabled (settings.EMBEDDINGS_ENABLED=False)."
        )


class LiteLLMEmbeddingProvider:
    """Embeds text via `litellm.aembedding`, defaulting to local Ollama.

    Mirrors `app.services.extraction._resolve_model_name`: the configured
    `LITELLM_PROVIDER` picks the prefix LiteLLM needs, and outbound text
    is passed through the pre-LLM hook before it ever reaches
    `litellm.aembedding`, so a remote provider can be blocked or redacted
    the same way metadata extraction is.
    """

    mode = "litellm"

    def __init__(self, model: str | None = None) -> None:
        self.model = model or _resolve_embedding_model_name()

    async def embed_texts(self, inputs: list[EmbeddingInput]) -> list[list[float]]:
        _validate_inputs(inputs)
        if not inputs:
            return []

        remote_provider = is_remote_provider(settings.LITELLM_PROVIDER)
        hook = load_hook_from_env()
        hooked_texts: list[str] = []
        for item in inputs:
            org_id = (item.metadata or {}).get("organization_id")
            context = LLMCallContext(
                purpose="embedding",
                model=self.model,
                is_remote_provider=remote_provider,
                document_id=item.id,
                organization_id=str(org_id) if org_id is not None else None,
            )
            hooked_texts.append(hook(item.text, context))

        response = await litellm.aembedding(
            model=self.model,
            input=hooked_texts,
            timeout=settings.LLM_REQUEST_TIMEOUT_SECONDS,
        )
        vectors = [_vector_from_response_item(item) for item in response.data]
        if len(vectors) != len(inputs):
            raise EmbeddingProviderError(
                f"Embedding provider returned {len(vectors)} vectors for "
                f"{len(inputs)} inputs"
            )
        return vectors


def _vector_from_response_item(item: object) -> list[float]:
    """Extract the embedding vector from one LiteLLM response item.

    LiteLLM's embedding response mirrors the OpenAI embeddings API shape
    (``{"embedding": [...], "index": ..., "object": "embedding"}``).
    Response items may be plain dicts or LiteLLM's ``Embedding`` model,
    both of which support ``item["embedding"]``.
    """
    try:
        vector = item["embedding"]  # type: ignore[index]
    except (KeyError, TypeError) as e:
        raise EmbeddingProviderError(f"Malformed embedding response item: {item!r}") from e
    return list(vector)


def _resolve_embedding_model_name() -> str:
    """Map our config-style model name to a LiteLLM-compatible string.

    Mirrors `app.services.extraction._resolve_model_name`.
    """
    if settings.LITELLM_PROVIDER == "ollama":
        return f"ollama/{settings.EMBEDDING_MODEL}"
    if settings.LITELLM_PROVIDER == "openai":
        return settings.EMBEDDING_MODEL
    if settings.LITELLM_PROVIDER == "anthropic":
        return f"anthropic/{settings.EMBEDDING_MODEL}"
    if settings.LITELLM_PROVIDER == "azure":
        return f"azure/{settings.EMBEDDING_MODEL}"
    return settings.EMBEDDING_MODEL


def get_embedding_provider() -> EmbeddingProvider:
    """Return the configured embedding provider.

    Selection is a single settings flag (`EMBEDDINGS_ENABLED`), not a
    provider registry: there is exactly one real implementation
    (LiteLLM), so the only meaningful choice an operator makes is on/off.
    """
    if not settings.EMBEDDINGS_ENABLED:
        return DisabledEmbeddingProvider()
    return LiteLLMEmbeddingProvider()


def _validate_inputs(inputs: list[EmbeddingInput]) -> None:
    for item in inputs:
        if not item.text.strip():
            raise ValueError(f"Embedding input '{item.id}' has empty text")


async def populate_clause_embeddings(session: AsyncSession, clauses: list[Clause]) -> None:
    """Compute and set embeddings for freshly segmented clauses.

    Postgres-only: `Clause.embedding` is a pgvector `Vector`, and the
    vector leg of hybrid retrieval that reads it
    (`app.services.retrieval.search_clauses`) only runs on Postgres, so
    under the sqlite fallback used in tests there is nothing to
    compute — this returns immediately without calling the embedding
    provider.

    This function does not swallow errors itself; callers (see
    `app.api.contracts`) wrap it in a best-effort try/except so an
    embedding-provider outage never fails contract ingest.
    """
    if not clauses:
        return

    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        return

    provider = get_embedding_provider()
    if provider.mode == "disabled":
        return

    inputs = [
        EmbeddingInput(
            id=str(clause.id),
            text=clause.text,
            kind="clause",
            metadata={"organization_id": str(clause.organization_id)},
        )
        for clause in clauses
    ]
    vectors = await provider.embed_texts(inputs)
    for clause, vector in zip(clauses, vectors, strict=True):
        clause.embedding = vector
    await session.flush()
