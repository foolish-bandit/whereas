from __future__ import annotations

from unittest.mock import patch

import pytest

from app.services.embeddings import (
    DisabledEmbeddingProvider,
    EmbeddingInput,
    EmbeddingsDisabledError,
    FuturePythonServicePlaceholderEmbeddingProvider,
    LocalCommandPlaceholderEmbeddingProvider,
    get_embedding_provider,
)


def _sample_input(text: str = "Sample clause text") -> EmbeddingInput:
    return EmbeddingInput(id="clause-1", text=text, kind="clause", metadata={"version": 1})


def test_disabled_provider_raises_controlled_error() -> None:
    provider = DisabledEmbeddingProvider()

    with pytest.raises(EmbeddingsDisabledError, match="Embeddings are disabled"):
        provider.embed_texts([_sample_input()])


def test_placeholder_provider_modes_are_disabled_behavior() -> None:
    local = LocalCommandPlaceholderEmbeddingProvider()
    future = FuturePythonServicePlaceholderEmbeddingProvider()

    with pytest.raises(EmbeddingsDisabledError):
        local.embed_texts([_sample_input()])
    with pytest.raises(EmbeddingsDisabledError):
        future.embed_texts([_sample_input()])


def test_no_external_command_called_in_disabled_provider() -> None:
    provider = DisabledEmbeddingProvider()

    with patch("subprocess.run") as run_mock:
        with pytest.raises(EmbeddingsDisabledError):
            provider.embed_texts([_sample_input()])

    run_mock.assert_not_called()


def test_empty_text_is_rejected_before_disabled_error() -> None:
    provider = DisabledEmbeddingProvider()

    with pytest.raises(ValueError, match="empty text"):
        provider.embed_texts([_sample_input(text="   ")])


def test_provider_factory_modes() -> None:
    assert isinstance(get_embedding_provider("disabled"), DisabledEmbeddingProvider)
    assert isinstance(
        get_embedding_provider("local_command_placeholder"),
        LocalCommandPlaceholderEmbeddingProvider,
    )
    assert isinstance(
        get_embedding_provider("future_python_service_placeholder"),
        FuturePythonServicePlaceholderEmbeddingProvider,
    )
