"""Pre-LLM transformation hook.

Why this exists:
  Per the privacy design principle, documents stay on the tenant's
  infrastructure unless the user has explicitly configured a remote LLM
  provider. Even when they do, operators may want to mask, redact, or
  outright block content before it leaves the network. This module is the
  seam where that policy plugs in.

Shape:
  - A `PreLLMHook` is any callable `(text, context) -> text`. It returns
    transformed text or raises `PreLLMHookError` to abort the call.
  - We ship two stock implementations:
      * `identity_hook`  — pass-through. The default for local-only deploys.
      * `block_remote_hook` — raises if the call is going to a remote
        provider. The "no, really, never leave the box" setting.
  - Operators configure which hook is active via the `WHEREAS_PRE_LLM_HOOK`
    env var. Misconfiguration falls back to identity rather than crashing
    the app: an audit trail of "the hook didn't run" is preferable to an
    outage on every LLM call.

Threat-model bias:
  `is_remote_provider` defaults to "treat as remote" for unknown providers.
  False positives (over-flagging) are recoverable; false negatives (silent
  exfiltration) are not.
"""
from __future__ import annotations

import importlib
import logging
import os
from dataclasses import dataclass
from typing import Protocol

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# Errors and call context
# --------------------------------------------------------------------------


class PreLLMHookError(Exception):
    """Raised by a pre-LLM hook to abort the call.

    Distinct from generic LLM errors: this signals a policy decision, not
    a transport or model failure. Caller should surface this as a
    user-facing "blocked by policy" message, not retry.
    """


@dataclass
class LLMCallContext:
    """Metadata about an in-flight LLM call, passed to every hook.

    `purpose` is the call site identifier (e.g. "extraction",
    "qa.answer"). It's used in error messages and logs so operators can
    tell which feature was blocked.

    `is_remote_provider` is the load-bearing flag for any policy that
    cares whether content leaves the deployment. Computed once by the
    caller via `is_remote_provider`, not re-derived inside the hook.
    """

    purpose: str
    model: str
    is_remote_provider: bool
    document_id: str | None = None
    organization_id: str | None = None


class PreLLMHook(Protocol):
    """Callable contract for a pre-LLM hook."""

    def __call__(self, text: str, context: LLMCallContext) -> str:  # pragma: no cover
        ...


# --------------------------------------------------------------------------
# Provider classification
# --------------------------------------------------------------------------


def is_remote_provider(litellm_provider: str) -> bool:
    """True if the configured provider sends content off the box.

    Only `"ollama"` (case-insensitive, with whitespace tolerated) is
    treated as local. Everything else, including providers we've never
    heard of, returns True. The fail-safe default is "treat as remote":
    over-flagging is recoverable; silent exfiltration is not.
    """
    if not isinstance(litellm_provider, str):
        return True
    return litellm_provider.strip().lower() != "ollama"


# --------------------------------------------------------------------------
# Built-in hooks
# --------------------------------------------------------------------------


def identity_hook(text: str, context: LLMCallContext) -> str:
    """Pass-through hook. Default for deployments without policy config."""
    return text


def block_remote_hook(text: str, context: LLMCallContext) -> str:
    """Hook that refuses any call to a remote provider.

    Use this when an operator wants a hard guarantee that document content
    never leaves the deployment, even if a user accidentally configures a
    remote model. The error message names the purpose and model so the
    audit/log shows what was blocked.
    """
    if context.is_remote_provider:
        raise PreLLMHookError(
            f"Pre-LLM hook 'block_remote' refused call: "
            f"purpose={context.purpose!r}, model={context.model!r}. "
            f"Configure a local provider (e.g. ollama) or change "
            f"WHEREAS_PRE_LLM_HOOK to allow remote calls."
        )
    return text


# --------------------------------------------------------------------------
# Configuration loading
# --------------------------------------------------------------------------


_ENV_VAR = "WHEREAS_PRE_LLM_HOOK"
_BUILTINS: dict[str, PreLLMHook] = {
    "identity": identity_hook,
    "block_remote": block_remote_hook,
}


def load_hook_from_env() -> PreLLMHook:
    """Resolve the configured hook from `WHEREAS_PRE_LLM_HOOK`.

    Resolution order:
      1. Unset/empty           -> identity
      2. "identity"            -> identity
      3. "block_remote"        -> block_remote
      4. "module.path:callable" -> dynamic import
      5. Anything else / failure -> log and fall back to identity

    Misconfiguration MUST NOT crash the app. The cost of failing closed
    here would be every LLM call falling over for a typo in an env var,
    so we degrade to identity and log loudly instead.
    """
    raw = os.environ.get(_ENV_VAR, "").strip()
    if not raw:
        return identity_hook

    if raw in _BUILTINS:
        return _BUILTINS[raw]

    if ":" not in raw:
        log.error(
            "Invalid %s value %r: expected 'identity', 'block_remote', or "
            "'module.path:callable'. Falling back to identity.",
            _ENV_VAR,
            raw,
        )
        return identity_hook

    module_path, _, attr_name = raw.partition(":")
    if not module_path or not attr_name:
        log.error(
            "Invalid %s value %r: empty module or attribute. "
            "Falling back to identity.",
            _ENV_VAR,
            raw,
        )
        return identity_hook

    try:
        module = importlib.import_module(module_path)
    except Exception:
        log.exception(
            "Failed to import module %r referenced by %s. "
            "Falling back to identity.",
            module_path,
            _ENV_VAR,
        )
        return identity_hook

    hook = getattr(module, attr_name, None)
    if hook is None or not callable(hook):
        log.error(
            "Attribute %r on module %r is missing or not callable "
            "(referenced by %s). Falling back to identity.",
            attr_name,
            module_path,
            _ENV_VAR,
        )
        return identity_hook

    log.info("Loaded pre-LLM hook from %s=%s", _ENV_VAR, raw)
    return hook


# --------------------------------------------------------------------------
# Cached accessor
# --------------------------------------------------------------------------


# Resolved on first `get_hook()` call and reused for the process lifetime.
# Tests reset this via the `reset_hook_cache` fixture in test_llm_hook.
_hook: PreLLMHook | None = None


def get_hook() -> PreLLMHook:
    """Return the configured hook, resolving on first call.

    Caching matters: `load_hook_from_env` may import a Python module, and
    we don't want that cost on every LLM call. Operators changing the env
    var must restart the process — same posture as the rest of `Settings`.
    """
    global _hook
    if _hook is None:
        _hook = load_hook_from_env()
    return _hook


def apply_hook(text: str, context: LLMCallContext) -> str:
    """Convenience wrapper for the common case `get_hook()(text, context)`."""
    return get_hook()(text, context)
