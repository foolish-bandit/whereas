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
    # Summary block surfaces the counts (PR #93 — paragraph wording).
    assert "Added paragraphs: 2" in body
    assert "Removed paragraphs: 1" in body
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
    # Context blocks are collapsed to an "unchanged paragraphs"
    # indicator (PR #93 — paragraph wording) so the report focuses on
    # the actual changes.
    assert "unchanged paragraph" in body
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


# ---------------------------------------------------------------------------
# PR #93 — paragraph-aware diff (split + diff behavior)
# ---------------------------------------------------------------------------


from app.services.artifact_compare import (  # noqa: E402  (post-pytest import is fine here)
    _split_paragraphs,
    compute_text_diff,
)


def test_split_paragraphs_splits_on_blank_lines() -> None:
    text = (
        "Section 1. Term.\n"
        "\n"
        "The Agreement is for two (2) years.\n"
        "\n"
        "Section 2. Confidentiality.\n"
        "\n"
        "Each party shall hold Confidential Information in confidence.\n"
    )
    paragraphs = _split_paragraphs(text)
    assert paragraphs == [
        "Section 1. Term.",
        "The Agreement is for two (2) years.",
        "Section 2. Confidentiality.",
        "Each party shall hold Confidential Information in confidence.",
    ]


def test_split_paragraphs_collapses_internal_wrapping() -> None:
    """The key product property: a paragraph that has been wrapped
    differently in the source should still hash to the same
    paragraph. No noisy diff just because one side wraps at column
    72 and the other at column 80."""
    wrapped_a = (
        "Each party shall hold the other party's\n"
        "Confidential Information in strict confidence\n"
        "and shall not disclose it to any third party."
    )
    wrapped_b = (
        "Each party shall hold the other party's Confidential\n"
        "Information in strict confidence and shall not\n"
        "disclose it to any third party."
    )
    a = _split_paragraphs(wrapped_a)
    b = _split_paragraphs(wrapped_b)
    assert a == b
    assert len(a) == 1


def test_split_paragraphs_collapses_whitespace_runs() -> None:
    text = "alpha   beta\t\tgamma\n\n  next\n para  \n"
    assert _split_paragraphs(text) == ["alpha beta gamma", "next para"]


def test_split_paragraphs_drops_empty_chunks() -> None:
    text = "\n\nfirst\n\n\n\n\nsecond\n\n"
    assert _split_paragraphs(text) == ["first", "second"]


def test_split_paragraphs_handles_empty_input() -> None:
    assert _split_paragraphs("") == []
    assert _split_paragraphs("\n\n\n") == []


def test_compute_text_diff_added_paragraph() -> None:
    base = "Section 1.\n\nAlpha clause."
    compare = "Section 1.\n\nAlpha clause.\n\nSection 2.\n\nNew beta clause."
    result = compute_text_diff(base, compare)
    assert result.summary.added_lines == 2  # the two new paragraphs
    assert result.summary.removed_lines == 0
    assert result.summary.changed_blocks == 0
    # Block types preserve ordering: context first, then added.
    types = [b.type for b in result.diff_blocks]
    assert types == ["context", "added"]
    added_texts = [line.text for line in result.diff_blocks[1].lines]
    assert added_texts == ["Section 2.", "New beta clause."]


def test_compute_text_diff_removed_paragraph() -> None:
    base = "Alpha.\n\nDeprecated paragraph.\n\nGamma."
    compare = "Alpha.\n\nGamma."
    result = compute_text_diff(base, compare)
    assert result.summary.added_lines == 0
    assert result.summary.removed_lines == 1
    types = [b.type for b in result.diff_blocks]
    assert "removed" in types
    removed_block = next(b for b in result.diff_blocks if b.type == "removed")
    assert [line.text for line in removed_block.lines] == [
        "Deprecated paragraph.",
    ]


def test_compute_text_diff_changed_paragraph() -> None:
    base = "Alpha.\n\nTerm: one (1) year.\n\nGamma."
    compare = "Alpha.\n\nTerm: two (2) years.\n\nGamma."
    result = compute_text_diff(base, compare)
    assert result.summary.changed_blocks == 1
    # The changed block carries the removed paragraph followed by the
    # added paragraph (the order difflib reports for a ``replace``
    # opcode).
    changed = next(b for b in result.diff_blocks if b.type == "changed")
    types = [line.type for line in changed.lines]
    assert types == ["removed", "added"]
    assert changed.lines[0].text == "Term: one (1) year."
    assert changed.lines[1].text == "Term: two (2) years."


def test_compute_text_diff_wrapping_differences_do_not_explode() -> None:
    """Same prose, wrapped differently → no noise. This is the headline
    behavior of PR #93. Before PR #93 this would generate one
    paragraph's worth of changes per wrap boundary."""
    base = (
        "Section 1. Term.\n\n"
        "Each party shall hold the other party's Confidential\n"
        "Information in strict confidence and shall not disclose\n"
        "it to any third party for any purpose."
    )
    compare = (
        "Section 1. Term.\n\n"
        "Each party shall hold the other party's Confidential Information\n"
        "in strict confidence and shall not disclose it to any third\n"
        "party for any purpose."
    )
    result = compute_text_diff(base, compare)
    assert result.summary.added_lines == 0
    assert result.summary.removed_lines == 0
    assert result.summary.changed_blocks == 0
    assert result.summary.unchanged_lines == 2


def test_compute_text_diff_preserves_paragraph_ordering() -> None:
    base = "A.\n\nB.\n\nC.\n\nD."
    compare = "A.\n\nB.\n\nC.\n\nD."
    result = compute_text_diff(base, compare)
    # All-context, single block, 4 paragraphs in source order.
    assert len(result.diff_blocks) == 1
    assert result.diff_blocks[0].type == "context"
    texts = [line.text for line in result.diff_blocks[0].lines]
    assert texts == ["A.", "B.", "C.", "D."]


def test_compute_text_diff_is_deterministic() -> None:
    """Same input → same output, byte for byte."""
    base = "alpha.\n\nbeta old.\n\ngamma."
    compare = "alpha.\n\nbeta new.\n\ngamma.\n\ndelta."
    a = compute_text_diff(base, compare)
    b = compute_text_diff(base, compare)
    assert a.summary == b.summary
    assert len(a.diff_blocks) == len(b.diff_blocks)
    for ab, bb in zip(a.diff_blocks, b.diff_blocks, strict=True):
        assert ab.type == bb.type
        assert ab.base_line_start == bb.base_line_start
        assert ab.compare_line_start == bb.compare_line_start
        assert [line.text for line in ab.lines] == [line.text for line in bb.lines]


# ---------------------------------------------------------------------------
# PR #93 — DOCX report uses paragraph-aware section labels
# ---------------------------------------------------------------------------


def test_rendered_document_has_paragraph_aware_section_labels() -> None:
    """The DOCX rendered from a paragraph-mode diff should include the
    user-facing section labels added in PR #93 — Added paragraphs,
    Removed paragraphs, and Changed paragraph (with Before/After
    sub-labels)."""
    diff = DiffResult(
        summary=DiffSummary(
            added_lines=1, removed_lines=1, changed_blocks=1, unchanged_lines=1,
        ),
        diff_blocks=[
            DiffBlock(
                type="context",
                base_line_start=1,
                compare_line_start=1,
                lines=[DiffLine(type="context", text="Alpha paragraph.")],
            ),
            DiffBlock(
                type="added",
                base_line_start=2,
                compare_line_start=2,
                lines=[DiffLine(type="added", text="A brand new clause.")],
            ),
            DiffBlock(
                type="removed",
                base_line_start=2,
                compare_line_start=3,
                lines=[DiffLine(type="removed", text="Deprecated clause body.")],
            ),
            DiffBlock(
                type="changed",
                base_line_start=3,
                compare_line_start=3,
                lines=[
                    DiffLine(type="removed", text="Term: one (1) year."),
                    DiffLine(type="added", text="Term: two (2) years."),
                ],
            ),
        ],
        warnings=[],
    )
    blob = render_compare_report_docx(
        diff=diff,
        base=CompareSideMetadata(label="Source file", filename=None, created_at=None),
        compare=CompareSideMetadata(
            label="Generated Word document", filename=None, created_at=None
        ),
        contract_title="Acme MSA",
    )
    body = _read_docx_text(blob)
    assert "Added paragraphs:" in body  # summary line
    assert "Added paragraphs" in body  # added-block section label
    assert "Removed paragraphs" in body
    assert "Changed paragraph" in body
    assert "Before:" in body
    assert "After:" in body
    # And the actual paragraph text shows up too.
    assert "A brand new clause." in body
    assert "Deprecated clause body." in body
    assert "Term: one (1) year." in body
    assert "Term: two (2) years." in body
    # Context block label uses the new "paragraph" wording.
    assert "unchanged paragraph" in body
    # Paranoia: no storage internals or secrets in the rendered body.
    for needle in ("storage_key", "wrapped_dek", "s3_key"):
        assert needle not in body
