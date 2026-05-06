"""Tests for the pre-LLM transformation hook.

Covers provider classification, the two stock hooks, env-driven hook
resolution (including every misconfiguration path), and the module-level
cache. The cache is reset between tests via the `reset_hook_cache`
autouse fixture — tests would otherwise leak state through the global.
"""
from __future__ import annotations

import pytest

from app.security import llm_hook
from app.security.llm_hook import (
    LLMCallContext,
    PreLLMHookError,
    apply_hook,
    block_remote_hook,
    get_hook,
    identity_hook,
    is_remote_provider,
    load_hook_from_env,
)

# A test-local hook callable that swaps the input text. Referenced by
# string from the dynamic-import test below.
SENTINEL_TEXT = "<<masked>>"


def custom_hook(text: str, context: LLMCallContext) -> str:
    return SENTINEL_TEXT


def _local_ctx(**overrides: object) -> LLMCallContext:
    base = {
        "purpose": "extraction",
        "model": "ollama/llama3",
        "is_remote_provider": False,
    }
    base.update(overrides)
    return LLMCallContext(**base)  # type: ignore[arg-type]


def _remote_ctx(**overrides: object) -> LLMCallContext:
    base = {
        "purpose": "extraction",
        "model": "gpt-4o-mini",
        "is_remote_provider": True,
    }
    base.update(overrides)
    return LLMCallContext(**base)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def reset_hook_cache() -> None:
    """Force `get_hook()` to re-resolve from env between tests.

    Without this, the first test to call `get_hook()` pins the cached
    value for the entire session, making every subsequent env-var-driven
    test pass for the wrong reason.
    """
    llm_hook._hook = None


# --------------------------------------------------------------------------
# is_remote_provider
# --------------------------------------------------------------------------


class TestIsRemoteProvider:
    @pytest.mark.parametrize("value", ["ollama", "OLLAMA", "Ollama", " ollama ", "\tollama\n"])
    def test_ollama_variants_are_local(self, value: str) -> None:
        assert is_remote_provider(value) is False

    @pytest.mark.parametrize(
        "value",
        ["openai", "OpenAI", "anthropic", "azure", "bedrock", "vertex_ai", "unknown-provider"],
    )
    def test_known_and_unknown_remote_providers_flagged(self, value: str) -> None:
        assert is_remote_provider(value) is True

    def test_empty_string_is_remote(self) -> None:
        # Fail-safe: an empty/garbled provider must NOT be treated as local.
        assert is_remote_provider("") is True


# --------------------------------------------------------------------------
# identity_hook
# --------------------------------------------------------------------------


class TestIdentityHook:
    def test_returns_input_unchanged_local(self) -> None:
        text = "the quick brown fox"
        assert identity_hook(text, _local_ctx()) == text

    def test_returns_input_unchanged_remote(self) -> None:
        # identity is "do nothing", regardless of remoteness — the policy
        # decision belongs to the caller's choice of hook.
        text = "the quick brown fox"
        assert identity_hook(text, _remote_ctx()) == text


# --------------------------------------------------------------------------
# block_remote_hook
# --------------------------------------------------------------------------


class TestBlockRemoteHook:
    def test_allows_local(self) -> None:
        text = "secret contract terms"
        assert block_remote_hook(text, _local_ctx()) == text

    def test_blocks_remote(self) -> None:
        with pytest.raises(PreLLMHookError):
            block_remote_hook("secret contract terms", _remote_ctx())

    def test_error_message_includes_purpose_and_model(self) -> None:
        ctx = _remote_ctx(purpose="qa.answer", model="gpt-4o-mini")
        with pytest.raises(PreLLMHookError) as excinfo:
            block_remote_hook("payload", ctx)
        message = str(excinfo.value)
        assert "qa.answer" in message
        assert "gpt-4o-mini" in message


# --------------------------------------------------------------------------
# load_hook_from_env
# --------------------------------------------------------------------------


class TestLoadHookFromEnv:
    def test_unset_returns_identity(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("WHEREAS_PRE_LLM_HOOK", raising=False)
        assert load_hook_from_env() is identity_hook

    def test_empty_returns_identity(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "")
        assert load_hook_from_env() is identity_hook

    def test_whitespace_only_returns_identity(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "   ")
        assert load_hook_from_env() is identity_hook

    def test_identity_keyword_returns_identity(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "identity")
        assert load_hook_from_env() is identity_hook

    def test_block_remote_keyword_returns_block_remote(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "block_remote")
        assert load_hook_from_env() is block_remote_hook

    def test_malformed_no_colon_returns_identity(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # No colon and not a known keyword: fallback, not crash.
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "garbage")
        assert load_hook_from_env() is identity_hook

    def test_empty_module_or_attribute_returns_identity(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", ":callable")
        assert load_hook_from_env() is identity_hook
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "module.path:")
        assert load_hook_from_env() is identity_hook

    def test_unimportable_module_returns_identity(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(
            "WHEREAS_PRE_LLM_HOOK",
            "this_module_does_not_exist_12345:hook",
        )
        assert load_hook_from_env() is identity_hook

    def test_missing_attribute_returns_identity(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Real module, attribute that isn't there.
        monkeypatch.setenv(
            "WHEREAS_PRE_LLM_HOOK",
            "tests.test_llm_hook:no_such_attribute",
        )
        assert load_hook_from_env() is identity_hook

    def test_non_callable_attribute_returns_identity(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # SENTINEL_TEXT is a str, not callable.
        monkeypatch.setenv(
            "WHEREAS_PRE_LLM_HOOK",
            "tests.test_llm_hook:SENTINEL_TEXT",
        )
        assert load_hook_from_env() is identity_hook

    def test_valid_module_callable_loads_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(
            "WHEREAS_PRE_LLM_HOOK",
            "tests.test_llm_hook:custom_hook",
        )
        loaded = load_hook_from_env()
        assert loaded is custom_hook
        assert loaded("anything", _local_ctx()) == SENTINEL_TEXT


# --------------------------------------------------------------------------
# apply_hook + get_hook caching
# --------------------------------------------------------------------------


class TestApplyHook:
    def test_default_is_identity(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("WHEREAS_PRE_LLM_HOOK", raising=False)
        assert apply_hook("hello", _local_ctx()) == "hello"

    def test_configured_block_remote_blocks(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "block_remote")
        with pytest.raises(PreLLMHookError):
            apply_hook("hello", _remote_ctx())

    def test_configured_block_remote_allows_local(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "block_remote")
        assert apply_hook("hello", _local_ctx()) == "hello"

    def test_configured_module_callable_runs(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(
            "WHEREAS_PRE_LLM_HOOK",
            "tests.test_llm_hook:custom_hook",
        )
        assert apply_hook("anything", _local_ctx()) == SENTINEL_TEXT


class TestGetHookCaching:
    def test_subsequent_env_change_does_not_unpin_cache(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "block_remote")
        first = get_hook()
        assert first is block_remote_hook

        # Operator "changes" the env. Cache must NOT pick this up — the
        # process-restart contract is the documented behavior.
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "identity")
        second = get_hook()
        assert second is first

    def test_cache_reset_picks_up_new_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The autouse reset_hook_cache fixture resets between tests, so
        # this case verifies that an explicit reset (process restart proxy)
        # does pick up the new value.
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "block_remote")
        assert get_hook() is block_remote_hook

        llm_hook._hook = None
        monkeypatch.setenv("WHEREAS_PRE_LLM_HOOK", "identity")
        assert get_hook() is identity_hook
