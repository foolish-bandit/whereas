"""Unit tests for the document → markdown conversion service."""
from __future__ import annotations

import sys
import types
from typing import Any

import pytest

from app.services import document_markdown
from app.services.document_markdown import (
    CONVERTER_FALLBACK_PLAIN_TEXT,
    CONVERTER_MARKITDOWN,
    CONVERTER_NONE,
    convert_document_to_markdown,
)


def _install_fake_markitdown(
    monkeypatch: pytest.MonkeyPatch,
    *,
    text_content: str | None,
    raises: Exception | None = None,
) -> None:
    """Install a fake ``markitdown`` module so the service can import it.

    Tests that need the ImportError path simply skip this helper.
    """

    class FakeConversionResult:
        def __init__(self, text: str | None) -> None:
            self.text_content = text

    class FakeMarkItDown:
        def convert(self, _path: str) -> Any:
            if raises is not None:
                raise raises
            return FakeConversionResult(text_content)

    fake_module = types.ModuleType("markitdown")
    fake_module.MarkItDown = FakeMarkItDown  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "markitdown", fake_module)


def test_empty_input_returns_failed_with_no_converter() -> None:
    result = convert_document_to_markdown(
        file_bytes=b"",
        mime_type="application/pdf",
    )
    assert result.status == "failed"
    assert result.markdown_text == ""
    assert result.converter_name == CONVERTER_NONE
    assert "empty_input" in result.warnings


def test_uses_markitdown_when_available(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_markitdown(monkeypatch, text_content="# Title\n\nBody.")
    result = convert_document_to_markdown(
        file_bytes=b"%PDF-1.7\nfake\n",
        mime_type="application/pdf",
        filename="contract.pdf",
    )
    assert result.status == "ready"
    assert result.markdown_text.startswith("# Title")
    assert result.converter_name == CONVERTER_MARKITDOWN
    assert result.warnings == []


def test_falls_back_to_plain_text_when_markitdown_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Ensure markitdown can't be imported.
    monkeypatch.setitem(sys.modules, "markitdown", None)

    result = convert_document_to_markdown(
        file_bytes=b"%PDF-1.7\nfake\n",
        mime_type="application/pdf",
        fallback_plain_text="Effective Date: 2026-05-08.\r\n",
    )
    assert result.status == "ready"
    assert result.converter_name == CONVERTER_FALLBACK_PLAIN_TEXT
    assert result.markdown_text.endswith("\n")
    assert "\r" not in result.markdown_text


def test_falls_back_when_markitdown_returns_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_markitdown(monkeypatch, text_content="   ")
    result = convert_document_to_markdown(
        file_bytes=b"%PDF-1.7\nfake\n",
        mime_type="application/pdf",
        fallback_plain_text="Plain body text.",
    )
    assert result.status == "ready"
    assert result.converter_name == CONVERTER_FALLBACK_PLAIN_TEXT
    # The earlier markitdown attempt's warning is carried forward so
    # operators can see what happened.
    assert "markitdown_empty_output" in result.warnings


def test_failed_when_no_converter_and_no_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "markitdown", None)
    result = convert_document_to_markdown(
        file_bytes=b"%PDF-1.7\nfake\n",
        mime_type="application/pdf",
        fallback_plain_text=None,
    )
    assert result.status == "failed"
    assert result.markdown_text == ""
    assert "no_fallback_text_available" in result.warnings


def test_markitdown_exception_is_non_fatal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_markitdown(
        monkeypatch, text_content=None, raises=RuntimeError("boom")
    )
    result = convert_document_to_markdown(
        file_bytes=b"%PDF-1.7\nfake\n",
        mime_type="application/pdf",
        fallback_plain_text="recovered text",
    )
    # Should still succeed via fallback path.
    assert result.status == "ready"
    assert result.converter_name == CONVERTER_FALLBACK_PLAIN_TEXT
    assert any(w.startswith("markitdown_error") for w in result.warnings)


def test_suffix_for_unknown_mime_uses_filename_extension() -> None:
    assert document_markdown._suffix_for("application/x-weird", "doc.rtf") == ".rtf"
    assert document_markdown._suffix_for("application/x-weird", None) == ".bin"
    assert (
        document_markdown._suffix_for("application/pdf", "thing.pdf")
        == ".pdf"
    )
