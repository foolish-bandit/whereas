"""Unit tests for the diff / extraction service (PR #71).

These cover the pure functions in
``app.services.artifact_compare`` without going through the API.
They're complementary to ``test_artifact_compare_api`` which
exercises the route-level scoping + audit posture.
"""
from __future__ import annotations

import pytest

from app.services import artifact_compare as service
from app.services.document_markdown import MarkdownConversionResult


def test_artifact_compare_label_covers_taxonomy() -> None:
    """Every artifact_type the model can carry has a user-facing label."""
    assert service.artifact_compare_label("original_upload", None) == "Source file"
    assert service.artifact_compare_label("original_upload", "user_upload") == "Source file"
    assert service.artifact_compare_label("original_upload", "request_upload") == "Uploaded agreement"
    assert service.artifact_compare_label("generated_docx", None) == "Generated Word document"
    assert service.artifact_compare_label("signed_pdf", "docuseal") == "Signed PDF"
    assert service.artifact_compare_label("redline", None) == "Redline"
    assert service.artifact_compare_label("attachment", None) == "Attachment"
    assert service.artifact_compare_label("exhibit", None) == "Exhibit"
    # A new artifact_type we don't recognize falls back to a generic
    # bucket — never the raw enum string.
    assert service.artifact_compare_label("future_thing", None) == "File"


def test_compute_text_diff_simple_replace() -> None:
    """Replacing one line yields exactly one changed block + accurate
    summary counts."""
    base = "alpha\nbeta\ngamma\ndelta\n"
    compare = "alpha\nBETA\ngamma\ndelta\nepsilon\n"
    result = service.compute_text_diff(base, compare)
    assert result.summary.added_lines == 2  # BETA + epsilon
    assert result.summary.removed_lines == 1  # beta
    assert result.summary.changed_blocks == 1
    assert result.summary.unchanged_lines == 3
    # Reconstruct the rendered text by walking blocks: every original
    # line appears somewhere (context or removed) and every compare
    # line appears (context or added).
    rendered_added = [
        line.text for block in result.diff_blocks for line in block.lines if line.type == "added"
    ]
    rendered_removed = [
        line.text for block in result.diff_blocks for line in block.lines if line.type == "removed"
    ]
    assert "BETA" in rendered_added
    assert "epsilon" in rendered_added
    assert "beta" in rendered_removed


def test_compute_text_diff_pure_insert_and_pure_delete() -> None:
    base = "a\nb\nc\n"
    compare = "a\nb\nc\nd\n"
    result = service.compute_text_diff(base, compare)
    assert result.summary.added_lines == 1
    assert result.summary.removed_lines == 0
    assert result.summary.changed_blocks == 0
    block_types = [b.type for b in result.diff_blocks]
    assert "added" in block_types
    assert "removed" not in block_types

    result = service.compute_text_diff(compare, base)
    assert result.summary.added_lines == 0
    assert result.summary.removed_lines == 1
    block_types = [b.type for b in result.diff_blocks]
    assert "removed" in block_types
    assert "added" not in block_types


def test_compute_text_diff_normalizes_line_endings() -> None:
    """Windows-style CRLF and Unix LF should compare as identical."""
    base = "alpha\r\nbeta\r\n"
    compare = "alpha\nbeta\n"
    result = service.compute_text_diff(base, compare)
    assert result.summary.added_lines == 0
    assert result.summary.removed_lines == 0
    assert result.summary.changed_blocks == 0
    # Two context lines, no diff blocks of any change type.
    assert all(b.type == "context" for b in result.diff_blocks)


def test_compute_text_diff_truncates_with_warning() -> None:
    base = "\n".join(f"L{i}" for i in range(2500)) + "\n"
    compare = "\n".join(f"M{i}" for i in range(2500)) + "\n"
    result = service.compute_text_diff(base, compare)
    emitted = sum(len(b.lines) for b in result.diff_blocks)
    assert emitted <= service.DEFAULT_MAX_LINES
    assert "diff_lines_truncated" in result.warnings
    # Summary still reflects the full opcode stream.
    assert result.summary.added_lines == 2500
    assert result.summary.removed_lines == 2500


def test_extract_comparable_text_uses_converter(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def _ok(*, file_bytes: bytes, mime_type: str, filename: str | None, fallback_plain_text: str | None = None) -> MarkdownConversionResult:
        captured["file_bytes"] = file_bytes
        captured["mime_type"] = mime_type
        captured["filename"] = filename
        captured["fallback_plain_text"] = fallback_plain_text
        return MarkdownConversionResult(
            status="ready",
            markdown_text="Hello world\n",
            converter_name="markitdown",
            converter_version="x",
        )

    monkeypatch.setattr(service, "convert_document_to_markdown", _ok)
    extracted = service.extract_comparable_text(
        file_bytes=b"raw",
        mime_type="application/pdf",
        filename="a.pdf",
        side="base",
    )
    assert extracted.text == "Hello world\n"
    assert extracted.converter_name == "markitdown"
    assert extracted.truncated is False
    assert extracted.warnings == []
    # The compare service must NOT pass a fallback plain-text — that
    # would silently substitute the parsed contract text for an
    # unsupported artifact, which is the wrong behavior.
    assert captured["fallback_plain_text"] is None


def test_extract_comparable_text_truncates_long_input(monkeypatch: pytest.MonkeyPatch) -> None:
    long_text = "x" * (service.DEFAULT_MAX_INPUT_CHARS + 100)

    def _ok(**_kwargs):
        return MarkdownConversionResult(
            status="ready",
            markdown_text=long_text,
            converter_name="markitdown",
        )

    monkeypatch.setattr(service, "convert_document_to_markdown", _ok)
    extracted = service.extract_comparable_text(
        file_bytes=b"raw",
        mime_type="application/pdf",
        filename=None,
        side="compare",
    )
    assert len(extracted.text) == service.DEFAULT_MAX_INPUT_CHARS
    assert extracted.truncated is True
    assert extracted.warnings == ["compare_text_truncated"]


def test_extract_comparable_text_raises_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fail(**_kwargs):
        return MarkdownConversionResult(
            status="failed",
            markdown_text="",
            converter_name="markitdown",
            warnings=["markitdown_empty_output"],
        )

    monkeypatch.setattr(service, "convert_document_to_markdown", _fail)
    with pytest.raises(service.CompareTextExtractionError) as excinfo:
        service.extract_comparable_text(
            file_bytes=b"raw",
            mime_type="application/octet-stream",
            filename="weird.bin",
            side="base",
        )
    err = excinfo.value
    assert err.side == "base"
    assert err.converter_name == "markitdown"
    assert "markitdown_empty_output" in err.warnings
