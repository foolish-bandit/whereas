"""Unit tests for the PR #90 comparison-report DOCX renderer.

These run without Postgres / httpx — they only verify that the
:func:`render_compare_report_docx` service produces a real DOCX file
and that the disclaimer / version block / summary line are present in
the rendered document body.
"""
from __future__ import annotations

import io
import zipfile
from datetime import UTC, datetime

import pytest

from app.services.artifact_compare import (
    DiffBlock,
    DiffLine,
    DiffResult,
    DiffSummary,
)
from app.services.compare_report_docx import (
    CompareSideMetadata,
    render_compare_report_docx,
)


def _sample_diff() -> DiffResult:
    return DiffResult(
        summary=DiffSummary(
            added_lines=2,
            removed_lines=1,
            changed_blocks=1,
            unchanged_lines=3,
        ),
        diff_blocks=[
            DiffBlock(
                type="context",
                base_line_start=1,
                compare_line_start=1,
                lines=[
                    DiffLine(type="context", text="alpha"),
                    DiffLine(type="context", text="gamma"),
                ],
            ),
            DiffBlock(
                type="changed",
                base_line_start=2,
                compare_line_start=2,
                lines=[
                    DiffLine(type="removed", text="beta"),
                    DiffLine(type="added", text="BETA"),
                ],
            ),
            DiffBlock(
                type="added",
                base_line_start=5,
                compare_line_start=5,
                lines=[DiffLine(type="added", text="epsilon")],
            ),
        ],
        warnings=["compare_text_truncated"],
    )


def _read_docx_text(blob: bytes) -> str:
    """Concatenate the text content of ``word/document.xml``.

    DOCX files are ZIP archives. The main document body lives in
    ``word/document.xml`` and the visible text shows up between
    ``<w:t>`` tags. For a smoke test it's enough to read that file and
    do a substring check — we don't need to parse the OOXML.
    """
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        return zf.read("word/document.xml").decode("utf-8")


def test_render_returns_a_valid_docx() -> None:
    blob = render_compare_report_docx(
        diff=_sample_diff(),
        base=CompareSideMetadata(
            label="Source file",
            filename="base.pdf",
            created_at=datetime(2026, 5, 1, tzinfo=UTC),
        ),
        compare=CompareSideMetadata(
            label="Generated Word document",
            filename="generated.docx",
            created_at=datetime(2026, 5, 8, tzinfo=UTC),
        ),
        contract_title="Acme MSA",
    )
    # Real DOCX files are ZIPs.
    assert blob[:2] == b"PK"
    assert len(blob) > 1000


def test_rendered_document_includes_disclaimer_and_summary() -> None:
    blob = render_compare_report_docx(
        diff=_sample_diff(),
        base=CompareSideMetadata(
            label="Source file", filename="base.pdf", created_at=None
        ),
        compare=CompareSideMetadata(
            label="Generated Word document",
            filename="generated.docx",
            created_at=None,
        ),
        contract_title="Acme MSA",
    )
    body = _read_docx_text(blob)
    # Title + contract name surface in the report body.
    assert "Comparison report" in body
    assert "Acme MSA" in body
    # The disclaimer copy that frames this as a working preview rather
    # than an official Word redline must appear in the rendered DOCX.
    assert "not an official Word redline" in body
    # Both versions get their label + filename in the Versions block.
    assert "Source file" in body
    assert "Generated Word document" in body
    assert "generated.docx" in body
    # Summary block surfaces the counts.
    assert "Added lines: 2" in body
    assert "Removed lines: 1" in body
    assert "Changed blocks: 1" in body
    # Warning surfaces in the report body when present in the diff.
    assert "compare_text_truncated" in body


def test_rendered_document_includes_diff_line_text() -> None:
    blob = render_compare_report_docx(
        diff=_sample_diff(),
        base=CompareSideMetadata(label="L", filename=None, created_at=None),
        compare=CompareSideMetadata(label="R", filename=None, created_at=None),
        contract_title="X",
    )
    body = _read_docx_text(blob)
    assert "beta" in body
    assert "BETA" in body
    assert "epsilon" in body
    # Context lines are collapsed to an "unchanged lines" indicator so
    # the report focuses on the actual changes.
    assert "unchanged line" in body
    # The raw text "alpha"/"gamma" should NOT appear since context runs
    # are collapsed.
    assert "alpha" not in body
    assert "gamma" not in body


def test_rendered_document_handles_no_diff_blocks() -> None:
    """When there are zero diff blocks the renderer should still
    produce a valid DOCX with a friendly empty-state paragraph."""
    blob = render_compare_report_docx(
        diff=DiffResult(
            summary=DiffSummary(
                added_lines=0,
                removed_lines=0,
                changed_blocks=0,
                unchanged_lines=10,
            ),
            diff_blocks=[],
            warnings=[],
        ),
        base=CompareSideMetadata(label="L", filename=None, created_at=None),
        compare=CompareSideMetadata(label="R", filename=None, created_at=None),
        contract_title="Empty diff",
    )
    body = _read_docx_text(blob)
    assert "Comparison report" in body
    assert "No differences" in body


@pytest.mark.parametrize(
    "title,needle",
    [
        ("My Contract!@#", "My_Contract"),
        ("", "comparison-report"),
    ],
)
def test_filename_sanitization_smoke(title: str, needle: str) -> None:
    """Title sanitization for the Content-Disposition filename."""
    from app.services.compare_report_docx import build_export_filename

    name = build_export_filename(title)
    assert name.endswith("-comparison-report.docx")
    assert needle in name
