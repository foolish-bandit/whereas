"""Safe local-command provider scaffold (disabled, not product-wired).

This module defines configuration and validation primitives for future
self-hosted small-model tooling. It intentionally does **not** execute commands.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

ProviderKind = Literal["embeddings", "extraction", "reranker", "explanation"]

MIN_TIMEOUT_MS = 100
MAX_TIMEOUT_MS = 120_000
MIN_MAX_INPUT_CHARS = 1
MAX_MAX_INPUT_CHARS = 200_000
_ALLOWED_COMMAND_NAMES = frozenset({"python3", "python", "uv", "node"})
_SHELL_METACHAR_PATTERN = (";", "&&", "||", "|", "`", "$()", ">", "<", "\n", "\r")


@dataclass(frozen=True)
class LocalCommandProviderConfig:
    """Admin-controlled future provider config.

    Security defaults:
    - disabled by default
    - empty env allowlist by default
    - command execution intentionally not implemented in this scaffold
    """

    enabled: bool = False
    provider_kind: ProviderKind = "embeddings"
    command_path: str = ""
    args: list[str] = field(default_factory=list)
    timeout_ms: int = 30_000
    max_input_chars: int = 16_000
    cwd: str | None = None
    env_allowlist: dict[str, str] = field(default_factory=dict)


def validate_local_command_provider_config(config: LocalCommandProviderConfig) -> None:
    """Validate config shape and safety constraints.

    Note: env values must never be logged by callers.
    """

    if config.provider_kind not in ("embeddings", "extraction", "reranker", "explanation"):
        raise ValueError("provider_kind must be one of: embeddings, extraction, reranker, explanation")

    if not isinstance(config.timeout_ms, int) or not (MIN_TIMEOUT_MS <= config.timeout_ms <= MAX_TIMEOUT_MS):
        raise ValueError(f"timeout_ms must be an int between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS}")

    if not isinstance(config.max_input_chars, int) or not (
        MIN_MAX_INPUT_CHARS <= config.max_input_chars <= MAX_MAX_INPUT_CHARS
    ):
        raise ValueError(
            f"max_input_chars must be an int between {MIN_MAX_INPUT_CHARS} and {MAX_MAX_INPUT_CHARS}"
        )

    if not isinstance(config.env_allowlist, dict):
        raise ValueError("env_allowlist must be a dict")

    for key in config.env_allowlist:
        if not isinstance(key, str) or not key.strip():
            raise ValueError("env_allowlist keys must be non-empty strings")

    if config.cwd is not None:
        cwd_path = Path(config.cwd)
        if not cwd_path.is_absolute():
            raise ValueError("cwd must be an absolute path when provided")

    if not config.enabled:
        return

    if not isinstance(config.command_path, str) or not config.command_path.strip():
        raise ValueError("command_path must be non-empty when enabled")

    _reject_shell_metacharacters(config.command_path, "command_path")

    is_explicit_path = config.command_path.startswith("/") or config.command_path.startswith("./")
    if not is_explicit_path and config.command_path not in _ALLOWED_COMMAND_NAMES:
        raise ValueError("command_path must be an explicit path or an explicitly allowed command")

    if not isinstance(config.args, list):
        raise ValueError("args must be a list of strings")

    for idx, arg in enumerate(config.args):
        if not isinstance(arg, str):
            raise ValueError(f"args[{idx}] must be a string")
        _reject_shell_metacharacters(arg, f"args[{idx}]")


def _reject_shell_metacharacters(value: str, field_name: str) -> None:
    for token in _SHELL_METACHAR_PATTERN:
        if token in value:
            raise ValueError(f"{field_name} contains forbidden shell metacharacter pattern")


def execute_local_command_provider(*_args: object, **_kwargs: object) -> None:
    """Future work placeholder.

    Intentionally disabled in this PR; use validation-only scaffold for now.
    """

    raise NotImplementedError("Local command provider execution is intentionally disabled in this scaffold")
