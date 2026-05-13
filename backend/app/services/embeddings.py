"""Embeddings service abstraction (architecture-only, disabled by default).

This module intentionally wires only interfaces and no-op behavior so backend
and frontend-facing code can depend on stable types before local embedding
execution is implemented.

Planned default model target (not bundled/downloaded here):
- ``BAAI/bge-small-en-v1.5``
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

EmbeddingKind = Literal["clause", "playbook_rule", "clause_manager_entry", "text_chunk"]
EmbeddingProviderMode = Literal[
    "disabled",
    "local_command_placeholder",
    "future_python_service_placeholder",
]

PLANNED_DEFAULT_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"


class EmbeddingsDisabledError(RuntimeError):
    """Raised when embeddings are disabled by provider mode."""


@dataclass(frozen=True)
class EmbeddingInput:
    """Input payload for a single embedding request.

    ``metadata`` must contain only safe/non-sensitive fields suitable for logs or
    telemetry and defaults to ``None``.
    """

    id: str
    text: str
    kind: EmbeddingKind
    metadata: dict[str, str | int | float | bool | None] | None = None


@dataclass(frozen=True)
class EmbeddingResult:
    """Embedding response shape for downstream semantic workflows."""

    id: str
    vector: list[float]
    model: str
    dimensions: int


class EmbeddingProvider(Protocol):
    mode: EmbeddingProviderMode

    def embed_texts(self, inputs: list[EmbeddingInput]) -> list[EmbeddingResult]:
        """Embed validated ``inputs`` or raise ``EmbeddingsDisabledError``."""


class DisabledEmbeddingProvider:
    """No-op provider that always blocks embedding execution.

    Safety guarantees in this placeholder implementation:
    - no subprocess invocation
    - no network calls
    - no model downloads
    - no storage writes
    """

    mode: EmbeddingProviderMode = "disabled"

    def embed_texts(self, inputs: list[EmbeddingInput]) -> list[EmbeddingResult]:
        _validate_inputs(inputs)
        raise EmbeddingsDisabledError(
            "Embeddings are disabled (provider mode: disabled). "
            "This build includes interface-only plumbing."
        )


class LocalCommandPlaceholderEmbeddingProvider(DisabledEmbeddingProvider):
    """Reserved mode for future local command execution.

    Currently behaves exactly like ``DisabledEmbeddingProvider``.
    """

    mode: EmbeddingProviderMode = "local_command_placeholder"


class FuturePythonServicePlaceholderEmbeddingProvider(DisabledEmbeddingProvider):
    """Reserved mode for future in-process/out-of-process Python serving.

    Currently behaves exactly like ``DisabledEmbeddingProvider``.
    """

    mode: EmbeddingProviderMode = "future_python_service_placeholder"


def get_embedding_provider(mode: EmbeddingProviderMode = "disabled") -> EmbeddingProvider:
    """Return the configured provider abstraction without executing embeddings."""
    if mode == "disabled":
        return DisabledEmbeddingProvider()
    if mode == "local_command_placeholder":
        return LocalCommandPlaceholderEmbeddingProvider()
    return FuturePythonServicePlaceholderEmbeddingProvider()


def _validate_inputs(inputs: list[EmbeddingInput]) -> None:
    for item in inputs:
        if not item.text.strip():
            raise ValueError(f"Embedding input '{item.id}' has empty text")
