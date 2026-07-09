from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import patch

import pytest

from app.models import Clause
from app.services import embeddings
from app.services.embeddings import (
    DisabledEmbeddingProvider,
    EmbeddingInput,
    EmbeddingProviderError,
    EmbeddingsDisabledError,
    LiteLLMEmbeddingProvider,
    get_embedding_provider,
    populate_clause_embeddings,
)


def _sample_input(text: str = "Sample clause text") -> EmbeddingInput:
    return EmbeddingInput(id="clause-1", text=text, kind="clause", metadata={"version": 1})


async def test_disabled_provider_raises_controlled_error() -> None:
    provider = DisabledEmbeddingProvider()

    with pytest.raises(EmbeddingsDisabledError, match="Embeddings are disabled"):
        await provider.embed_texts([_sample_input()])


async def test_no_external_command_called_in_disabled_provider() -> None:
    provider = DisabledEmbeddingProvider()

    with patch("subprocess.run") as run_mock, pytest.raises(EmbeddingsDisabledError):
        await provider.embed_texts([_sample_input()])

    run_mock.assert_not_called()


async def test_empty_text_is_rejected_before_disabled_error() -> None:
    provider = DisabledEmbeddingProvider()

    with pytest.raises(ValueError, match="empty text"):
        await provider.embed_texts([_sample_input(text="   ")])


async def test_empty_text_is_rejected_by_litellm_provider() -> None:
    provider = LiteLLMEmbeddingProvider(model="ollama/bge-m3")

    with pytest.raises(ValueError, match="empty text"):
        await provider.embed_texts([_sample_input(text="   ")])


def test_get_embedding_provider_respects_settings_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(embeddings.settings, "EMBEDDINGS_ENABLED", False)
    assert isinstance(get_embedding_provider(), DisabledEmbeddingProvider)

    monkeypatch.setattr(embeddings.settings, "EMBEDDINGS_ENABLED", True)
    assert isinstance(get_embedding_provider(), LiteLLMEmbeddingProvider)


async def test_litellm_provider_embeds_texts_in_one_batched_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(embeddings.settings, "LITELLM_PROVIDER", "ollama")
    monkeypatch.setattr(embeddings.settings, "EMBEDDING_MODEL", "bge-m3")

    seen_calls: list[dict[str, Any]] = []

    async def fake_aembedding(**kwargs: Any) -> Any:
        seen_calls.append(kwargs)
        return SimpleEmbeddingResponse(
            [{"embedding": [0.1, 0.2], "index": 0, "object": "embedding"}] * len(kwargs["input"])
        )

    monkeypatch.setattr(embeddings.litellm, "aembedding", fake_aembedding)

    provider = LiteLLMEmbeddingProvider()
    inputs = [
        EmbeddingInput(id="a", text="first clause", kind="clause"),
        EmbeddingInput(id="b", text="second clause", kind="clause"),
    ]
    vectors = await provider.embed_texts(inputs)

    assert vectors == [[0.1, 0.2], [0.1, 0.2]]
    assert len(seen_calls) == 1
    assert seen_calls[0]["model"] == "ollama/bge-m3"
    assert seen_calls[0]["input"] == ["first clause", "second clause"]


async def test_litellm_provider_runs_text_through_pre_llm_hook(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.security import llm_hook

    monkeypatch.setattr(embeddings.settings, "LITELLM_PROVIDER", "ollama")

    def redacting_hook(text: str, context: llm_hook.LLMCallContext) -> str:
        assert context.purpose == "embedding"
        return "REDACTED"

    monkeypatch.setattr(embeddings, "load_hook_from_env", lambda: redacting_hook)

    seen_inputs: list[str] = []

    async def fake_aembedding(**kwargs: Any) -> Any:
        seen_inputs.extend(kwargs["input"])
        return SimpleEmbeddingResponse(
            [{"embedding": [1.0], "index": 0, "object": "embedding"}] * len(kwargs["input"])
        )

    monkeypatch.setattr(embeddings.litellm, "aembedding", fake_aembedding)

    provider = LiteLLMEmbeddingProvider()
    await provider.embed_texts([EmbeddingInput(id="a", text="sensitive clause", kind="clause")])

    assert seen_inputs == ["REDACTED"]


async def test_litellm_provider_raises_on_mismatched_vector_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_aembedding(**kwargs: Any) -> Any:
        return SimpleEmbeddingResponse([{"embedding": [0.1], "index": 0, "object": "embedding"}])

    monkeypatch.setattr(embeddings.litellm, "aembedding", fake_aembedding)

    provider = LiteLLMEmbeddingProvider(model="ollama/bge-m3")
    with pytest.raises(EmbeddingProviderError, match="vectors"):
        await provider.embed_texts(
            [
                EmbeddingInput(id="a", text="one", kind="clause"),
                EmbeddingInput(id="b", text="two", kind="clause"),
            ]
        )


class SimpleEmbeddingResponse:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class _FakeBind:
    def __init__(self, dialect_name: str) -> None:
        self.dialect = SimpleNamespaceDialect(dialect_name)


class SimpleNamespaceDialect:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakeSession:
    """Minimal AsyncSession double for `populate_clause_embeddings` tests."""

    def __init__(self, dialect_name: str) -> None:
        self._dialect_name = dialect_name
        self.flush_count = 0

    def get_bind(self) -> _FakeBind:
        return _FakeBind(self._dialect_name)

    async def flush(self) -> None:
        self.flush_count += 1


def _make_clause(text: str = "Confidentiality clause text.") -> Clause:
    org_id = uuid.uuid4()
    return Clause(
        id=uuid.uuid4(),
        organization_id=org_id,
        contract_id=uuid.uuid4(),
        ordinal=0,
        text=text,
        span_start=0,
        span_end=len(text),
        segmentation_method="heuristic_v1",
    )


async def test_populate_clause_embeddings_sets_vectors_on_postgres(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(embeddings.settings, "EMBEDDINGS_ENABLED", True)
    monkeypatch.setattr(embeddings.settings, "LITELLM_PROVIDER", "ollama")

    async def fake_aembedding(**kwargs: Any) -> Any:
        return SimpleEmbeddingResponse(
            [{"embedding": [0.5, 0.5], "index": i, "object": "embedding"} for i in range(len(kwargs["input"]))]
        )

    monkeypatch.setattr(embeddings.litellm, "aembedding", fake_aembedding)

    session = _FakeSession("postgresql")
    clauses = [_make_clause("first"), _make_clause("second")]

    await populate_clause_embeddings(session, clauses)

    assert clauses[0].embedding == [0.5, 0.5]
    assert clauses[1].embedding == [0.5, 0.5]
    assert session.flush_count == 1


async def test_populate_clause_embeddings_skips_under_sqlite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(embeddings.settings, "EMBEDDINGS_ENABLED", True)

    async def boom(**kwargs: Any) -> Any:
        raise AssertionError("must not call the embedding provider under sqlite")

    monkeypatch.setattr(embeddings.litellm, "aembedding", boom)

    session = _FakeSession("sqlite")
    clauses = [_make_clause()]

    await populate_clause_embeddings(session, clauses)

    assert clauses[0].embedding is None
    assert session.flush_count == 0


async def test_populate_clause_embeddings_noop_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(embeddings.settings, "EMBEDDINGS_ENABLED", False)

    async def boom(**kwargs: Any) -> Any:
        raise AssertionError("must not call the embedding provider when disabled")

    monkeypatch.setattr(embeddings.litellm, "aembedding", boom)

    session = _FakeSession("postgresql")
    clauses = [_make_clause()]

    await populate_clause_embeddings(session, clauses)

    assert clauses[0].embedding is None
    assert session.flush_count == 0


async def test_populate_clause_embeddings_noop_for_empty_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _FakeSession("postgresql")
    await populate_clause_embeddings(session, [])
    assert session.flush_count == 0


async def test_populate_clause_embeddings_propagates_provider_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The caller (app.api.contracts) is responsible for catching this —
    this function itself must not swallow provider failures, otherwise
    ingest code can't tell embeddings apart from "nothing to do"."""
    monkeypatch.setattr(embeddings.settings, "EMBEDDINGS_ENABLED", True)

    async def fake_aembedding(**kwargs: Any) -> Any:
        raise RuntimeError("ollama unreachable")

    monkeypatch.setattr(embeddings.litellm, "aembedding", fake_aembedding)

    session = _FakeSession("postgresql")
    clauses = [_make_clause()]

    with pytest.raises(RuntimeError, match="ollama unreachable"):
        await populate_clause_embeddings(session, clauses)

    assert session.flush_count == 0
