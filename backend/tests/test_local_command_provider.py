from __future__ import annotations

from pathlib import Path

import pytest

from app.services.local_command_provider import (
    LocalCommandProviderConfig,
    execute_local_command_provider,
    validate_local_command_provider_config,
)


def test_disabled_provider_does_not_require_command_and_does_not_execute() -> None:
    cfg = LocalCommandProviderConfig(enabled=False, command_path="")
    validate_local_command_provider_config(cfg)

    with pytest.raises(NotImplementedError):
        execute_local_command_provider(cfg)


def test_invalid_enabled_config_is_rejected() -> None:
    cfg = LocalCommandProviderConfig(enabled=True, command_path="")
    with pytest.raises(ValueError, match="command_path must be non-empty when enabled"):
        validate_local_command_provider_config(cfg)


def test_shell_metacharacters_are_rejected() -> None:
    cfg = LocalCommandProviderConfig(enabled=True, command_path="/usr/bin/python3;rm -rf /", args=[])
    with pytest.raises(ValueError, match="forbidden shell metacharacter"):
        validate_local_command_provider_config(cfg)


def test_timeout_validation() -> None:
    cfg = LocalCommandProviderConfig(enabled=False, timeout_ms=999_999_999)
    with pytest.raises(ValueError, match="timeout_ms"):
        validate_local_command_provider_config(cfg)


def test_max_input_chars_validation() -> None:
    cfg = LocalCommandProviderConfig(enabled=False, max_input_chars=0)
    with pytest.raises(ValueError, match="max_input_chars"):
        validate_local_command_provider_config(cfg)


def test_provider_kind_validation() -> None:
    cfg = LocalCommandProviderConfig(provider_kind="embeddings")
    validate_local_command_provider_config(cfg)

    bad = LocalCommandProviderConfig(provider_kind="embeddings")
    object.__setattr__(bad, "provider_kind", "unknown")
    with pytest.raises(ValueError, match="provider_kind"):
        validate_local_command_provider_config(bad)


def test_env_values_are_not_in_validation_errors() -> None:
    secret_value = "super-secret-token"
    cfg = LocalCommandProviderConfig(
        enabled=True,
        command_path="not_allowed_command_name",
        env_allowlist={"API_TOKEN": secret_value},
    )
    with pytest.raises(ValueError) as exc:
        validate_local_command_provider_config(cfg)
    assert secret_value not in str(exc.value)


def test_no_product_flow_imports_local_command_provider() -> None:
    root = Path(__file__).resolve().parents[1]
    py_files = [p for p in root.rglob("*.py") if "tests" not in p.parts]
    violators: list[str] = []
    for path in py_files:
        text = path.read_text(encoding="utf-8")
        if "app.services.local_command_provider" in text and path.name != "local_command_provider.py":
            violators.append(str(path.relative_to(root)))
    assert violators == []
