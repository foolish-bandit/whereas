"""Pre-LLM hook system.

Lets deployments insert PII redaction or transformation between Whereas and
the configured LLM provider. The default implementation is identity (no
transformation).

This is the cleanest way to integrate a tool like Sonomos CLOAK without
making Whereas depend on it. Users who care about pre-LLM masking configure
a hook; users who run a local LLM and don't need it leave the default in place.

Hook contract:
  - Input: the text that's about to be sent to the LLM, plus metadata about
    the call (purpose, model, document_id).
  - Output: transformed text. Must preserve span anchors used by extraction —
    if the hook redacts a clause, the extraction prompt may fail to produce
    spans for redacted regions, which is the intended behavior.
  - Hooks may raise to abort the LLM call entirely (e.g., if redaction policy
    cannot be satisfied).

Hooks are configured via Python entry points or by setting WHEREAS_PRE_LLM_HOOK
to the import path of a callable.
"""
from __future__ import annotations

import importlib
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

log = logging.getLogger(__name__)


@dataclass
class LLMCallContext:
    """Metadata about an outbound LLM call. Hooks receive this alongside the text
    so they can apply different policies for different call types.
    """
    purpose: str  # "extraction", "deviation_evaluation", "qa", etc.
    model: str
    is_remote_provider: bool  # True if the provider is not local Ollama
    document_id: str | None = None
    organization_id: str | None = None


class PreLLMHook(Protocol):
    """A callable invoked before every LLM call.

    Implementations should be deterministic when possible, idempotent, and
    fast — they're on the hot path of every extraction.
    """

    def __call__(self, text: str, context: LLMCallContext) -> str:
        ...


# --------------------------------------------------------------------------
# Built-in hooks
# --------------------------------------------------------------------------


def identity_hook(text: str, context: LLMCallContext) -> str:
    """Default no-op hook. Pass text through unchanged."""
    return text


def block_remote_hook(text: str, context: LLMCallContext) -> str:
    """A paranoid hook that refuses any remote LLM call.

    Useful for deployments where regulatory policy forbids document content
    from leaving the local environment, but the operator wants the safety net
    of a hard block rather than relying on configuration.
    """
    if context.is_remote_provider:
        raise PreLLMHookError(
            f"Remote LLM provider rejected by policy. "
            f"Purpose={context.purpose}, model={context.model}."
        )
    return text


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------


class PreLLMHookError(Exception):
    """Raised by a hook to abort the LLM call. The caller should treat this as
    a hard failure and surface the message to the user; do not retry.
    """


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


def load_hook_from_env() -> PreLLMHook:
    """Load the configured hook based on environment variables.

    Resolution order:
      1. WHEREAS_PRE_LLM_HOOK="block_remote" -> built-in block_remote_hook
      2. WHEREAS_PRE_LLM_HOOK="module.path:callable" -> dynamic import
      3. Default: identity_hook
    """
    spec = os.environ.get("WHEREAS_PRE_LLM_HOOK", "").strip()
    if not spec:
        return identity_hook
    if spec == "block_remote":
        log.info("Pre-LLM hook: block_remote (will refuse all remote LLM calls)")
        return block_remote_hook
    if spec == "identity":
        return identity_hook
    if ":" not in spec:
        log.error(
            "Invalid WHEREAS_PRE_LLM_HOOK format. Expected 'module.path:callable'. "
            "Falling back to identity hook (insecure if remote LLM is configured)."
        )
        return identity_hook
    module_path, callable_name = spec.split(":", 1)
    try:
        module = importlib.import_module(module_path)
        hook = getattr(module, callable_name)
    except (ImportError, AttributeError) as e:
        log.error(
            "Failed to load pre-LLM hook %s: %s. "
            "Falling back to identity hook (insecure if remote LLM is configured).",
            spec, e,
        )
        return identity_hook
    log.info("Pre-LLM hook: %s", spec)
    return hook


# --------------------------------------------------------------------------
# Application
# --------------------------------------------------------------------------


_hook: Callable[[str, LLMCallContext], str] | None = None


def get_hook() -> PreLLMHook:
    """Cached accessor for the configured hook."""
    global _hook
    if _hook is None:
        _hook = load_hook_from_env()
    return _hook


def apply_hook(text: str, context: LLMCallContext) -> str:
    """Apply the configured pre-LLM hook to text. Always called before the LLM."""
    hook = get_hook()
    return hook(text, context)
