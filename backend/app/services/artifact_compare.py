"""Text-based artifact version compare (PR #71).

This module powers the Document History "Compare versions" action:
given two ``ContractArtifact`` rows on the same contract, it extracts
comparable plain text from each blob and produces a structured diff
summary the frontend can render as a lightweight redline preview.

Scope (deliberate):

* Text-only. There is no DOCX redline generation here, no PDF visual
  comparison, and no persisted ``redline`` artifact — those are
  follow-up PRs.
* Best-effort extraction. We reuse the existing MarkItDown-backed
  converter (``app.services.document_markdown.convert_document_to_markdown``);
  when MarkItDown is not installed or the input is unsupported, the
  call site surfaces a clean 4xx instead of falling back to OCR / a
  remote service. No Docling, no LLM, no network calls.
* No persistence. Compare on demand. The audit chain records the
  fact of the comparison; raw extracted text is never stored.

Output structure mirrors the wire schema in ``app.schemas.compare``:
a small ``DiffSummary`` plus a ``list[DiffBlock]`` where each block
carries grouped opcodes (``equal`` / ``insert`` / ``delete`` /
``replace``) with the starting line indices from each side.
"""
from __future__ import annotations

import difflib
import logging
from dataclasses import dataclass, field
from typing import Literal

from app.services.document_markdown import convert_document_to_markdown

log = logging.getLogger(__name__)


# Sized so a typical mid-size contract (a few hundred pages of dense
# legalese, ~100-150 KB extracted text) compares in a single request
# without consuming an unbounded amount of memory. Larger artifacts
# return a ``base_text_truncated`` / ``compare_text_truncated``
# warning rather than failing outright — the diff is still useful as
# a preview, the warning tells the user it isn't exhaustive.
DEFAULT_MAX_INPUT_CHARS = 200_000

# Total ``DiffLine`` rows returned across all blocks. The summary
# counts are always computed against the full diff so the user sees
# accurate totals even when the rendered preview is truncated.
DEFAULT_MAX_LINES = 1_000


DiffLineType = Literal["context", "added", "removed"]
DiffBlockType = Literal["context", "added", "removed", "changed"]


class CompareTextExtractionError(Exception):
    """Raised when an artifact's bytes cannot be converted to text."""

    def __init__(self, *, side: str, converter_name: str, warnings: list[str]):
        super().__init__(
            f"Could not extract comparable text for the {side} version "
            f"(converter={converter_name})."
        )
        self.side = side
        self.converter_name = converter_name
        self.warnings = list(warnings)


@dataclass(frozen=True)
class ExtractedComparableText:
    """Outcome of one extraction pass.

    ``text`` is the comparable plain-text representation. When the
    underlying converter produced more than ``max_chars`` characters
    we truncate and record a warning rather than refusing to compare.
    """

    text: str
    converter_name: str
    truncated: bool
    warnings: list[str] = field(default_factory=list)


@dataclass
class DiffLine:
    type: DiffLineType
    text: str


@dataclass
class DiffBlock:
    type: DiffBlockType
    base_line_start: int
    compare_line_start: int
    lines: list[DiffLine]


@dataclass
class DiffSummary:
    added_lines: int
    removed_lines: int
    changed_blocks: int
    unchanged_lines: int


@dataclass
class DiffResult:
    summary: DiffSummary
    diff_blocks: list[DiffBlock]
    warnings: list[str]


def extract_comparable_text(
    *,
    file_bytes: bytes,
    mime_type: str,
    filename: str | None,
    side: str,
    max_chars: int = DEFAULT_MAX_INPUT_CHARS,
) -> ExtractedComparableText:
    """Convert artifact bytes to comparable plain text.

    Uses the existing MarkItDown-backed converter. The converter is
    treated as the only seam: when it cannot produce usable output
    (unsupported MIME, MarkItDown not installed, conversion error)
    this function raises ``CompareTextExtractionError`` so the route
    can return a clean 4xx with a user-friendly message — there is no
    silent fallback to OCR or to a remote service.

    Text longer than ``max_chars`` is truncated and reported via a
    side-tagged warning so the caller can surface "compared first
    X chars only" in the UI.
    """
    try:
        result = convert_document_to_markdown(
            file_bytes=file_bytes,
            mime_type=mime_type,
            filename=filename,
            # No plain-text fallback: the caller resolves a specific
            # artifact, and we should not silently substitute a
            # different artifact's parsed text just because MarkItDown
            # cannot handle the input.
            fallback_plain_text=None,
        )
    except Exception as exc:  # pragma: no cover - defensive
        log.warning(
            "Compare text extraction raised unexpectedly",
            extra={
                "side": side,
                "mime_type": mime_type,
                "error": f"{type(exc).__name__}: {exc}",
            },
        )
        raise CompareTextExtractionError(
            side=side,
            converter_name="error",
            warnings=[f"converter_exception:{type(exc).__name__}"],
        ) from exc

    if result.status != "ready" or not (result.markdown_text or "").strip():
        raise CompareTextExtractionError(
            side=side,
            converter_name=result.converter_name,
            warnings=list(result.warnings or []),
        )

    text = result.markdown_text
    warnings: list[str] = []
    truncated = False
    if len(text) > max_chars:
        text = text[:max_chars]
        truncated = True
        warnings.append(f"{side}_text_truncated")

    return ExtractedComparableText(
        text=text,
        converter_name=result.converter_name,
        truncated=truncated,
        warnings=warnings,
    )


def compute_text_diff(
    base_text: str,
    compare_text: str,
    *,
    max_blocks: int | None = None,
    max_lines: int = DEFAULT_MAX_LINES,
) -> DiffResult:
    """Compute a structured diff between two plain-text documents.

    Built on :mod:`difflib`. Two complementary views:

    * ``summary`` is computed against the FULL opcode stream so users
      always see accurate add/remove/context totals.
    * ``diff_blocks`` mirror those opcodes but stop emitting lines
      once the total reaches ``max_lines`` (or once we exceed
      ``max_blocks`` if supplied). A truncation warning is appended
      so the UI can disclose that the preview is partial.

    Block taxonomy:
      * ``context`` — a run of equal lines.
      * ``added`` — pure insertion.
      * ``removed`` — pure deletion.
      * ``changed`` — a ``replace`` opcode (both sides differ). The
        inner ``lines`` are a sequence of ``removed`` followed by
        ``added``, matching the order difflib reports.
    """
    base_lines = _split_lines(base_text)
    compare_lines = _split_lines(compare_text)

    matcher = difflib.SequenceMatcher(a=base_lines, b=compare_lines, autojunk=False)

    summary = DiffSummary(
        added_lines=0, removed_lines=0, changed_blocks=0, unchanged_lines=0
    )
    diff_blocks: list[DiffBlock] = []
    warnings: list[str] = []
    emitted_lines = 0
    truncated = False

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            summary.unchanged_lines += i2 - i1
        elif tag == "insert":
            summary.added_lines += j2 - j1
        elif tag == "delete":
            summary.removed_lines += i2 - i1
        elif tag == "replace":
            summary.removed_lines += i2 - i1
            summary.added_lines += j2 - j1
            summary.changed_blocks += 1

        if truncated:
            continue

        if max_blocks is not None and len(diff_blocks) >= max_blocks:
            truncated = True
            warnings.append("diff_blocks_truncated")
            continue

        block_lines: list[DiffLine] = []
        block_type: DiffBlockType
        if tag == "equal":
            block_type = "context"
            for line in base_lines[i1:i2]:
                if emitted_lines >= max_lines:
                    truncated = True
                    break
                block_lines.append(DiffLine(type="context", text=line))
                emitted_lines += 1
        elif tag == "insert":
            block_type = "added"
            for line in compare_lines[j1:j2]:
                if emitted_lines >= max_lines:
                    truncated = True
                    break
                block_lines.append(DiffLine(type="added", text=line))
                emitted_lines += 1
        elif tag == "delete":
            block_type = "removed"
            for line in base_lines[i1:i2]:
                if emitted_lines >= max_lines:
                    truncated = True
                    break
                block_lines.append(DiffLine(type="removed", text=line))
                emitted_lines += 1
        else:  # replace
            block_type = "changed"
            for line in base_lines[i1:i2]:
                if emitted_lines >= max_lines:
                    truncated = True
                    break
                block_lines.append(DiffLine(type="removed", text=line))
                emitted_lines += 1
            for line in compare_lines[j1:j2]:
                if emitted_lines >= max_lines:
                    truncated = True
                    break
                block_lines.append(DiffLine(type="added", text=line))
                emitted_lines += 1

        if block_lines:
            diff_blocks.append(
                DiffBlock(
                    type=block_type,
                    # SequenceMatcher indices are 0-based; the wire
                    # shape uses 1-based line numbers because that's
                    # what users see when they scroll a document.
                    base_line_start=i1 + 1,
                    compare_line_start=j1 + 1,
                    lines=block_lines,
                )
            )

        if truncated and "diff_lines_truncated" not in warnings:
            warnings.append("diff_lines_truncated")

    return DiffResult(summary=summary, diff_blocks=diff_blocks, warnings=warnings)


def artifact_compare_label(artifact_type: str, source: str | None) -> str:
    """User-facing label for a compare side.

    Mirrors the frontend's ``artifactDisplayLabel`` (lib/artifacts.ts)
    so the row label, the lifecycle strip, and the compare panel all
    use the same vocabulary. Kept here so the backend can hand a
    pre-resolved label to the API response — the frontend never has
    to render raw ``artifact_type`` strings into the compare panel.
    """
    if artifact_type == "original_upload":
        if source == "request_upload":
            return "Uploaded agreement"
        return "Source file"
    if artifact_type == "generated_docx":
        return "Generated Word document"
    if artifact_type == "signed_pdf":
        return "Signed PDF"
    if artifact_type == "redline":
        return "Redline"
    if artifact_type == "attachment":
        return "Attachment"
    if artifact_type == "exhibit":
        return "Exhibit"
    return "File"


def _split_lines(text: str) -> list[str]:
    """Split ``text`` into lines with normalized line endings.

    Difflib operates on equal-length sequences, so we normalize
    Windows / classic-Mac line endings up-front and strip the trailing
    newline so the user-visible block doesn't render a stray empty
    line for documents that end with one.
    """
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if normalized.endswith("\n"):
        normalized = normalized[:-1]
    return normalized.split("\n")
