"""Document parsing service.

Turns user-uploaded PDF/DOCX bytes into a `ParsedDocument` with:
- a single canonical `full_text` string used by the extraction layer for span
  validation (`extraction._validate_span` searches against this exact string),
- per-page text blocks with bounding boxes for citation rendering,
- a sha256 content hash, page count, and detected language.

Parsing runs in a spawned worker process with a hard timeout, so a malicious
or pathological input can't hang the API process.
"""
from __future__ import annotations

from dataclasses import dataclass

DEFAULT_PARSE_TIMEOUT_SECONDS = 300
DEFAULT_MAX_PAGES = 1000

SUPPORTED_EXTENSIONS = frozenset({".pdf", ".docx"})


class DocumentParseError(Exception):
    """Base error for any failure in the parsing pipeline."""


class UnsupportedDocumentTypeError(DocumentParseError):
    """The uploaded file's extension is not on the supported list."""


class DocumentParseTimeoutError(DocumentParseError):
    """Parsing exceeded the configured wall-clock budget."""


class DocumentTooLargeError(DocumentParseError):
    """Document exceeded the configured page-count guard."""


@dataclass(frozen=True)
class TextBlock:
    """A contiguous block of text with provenance.

    `char_start`/`char_end` are offsets into `ParsedDocument.full_text`.
    `bbox` is `(x0, y0, x1, y1)` in the page's native units (PDF points for
    PDFs); `None` when Docling does not surface coordinates (e.g. DOCX).
    """

    text: str
    page_number: int
    char_start: int
    char_end: int
    bbox: tuple[float, float, float, float] | None = None


@dataclass(frozen=True)
class ParsedPage:
    """One page of a parsed document.

    For DOCX, where there is no native page concept, the parser emits a single
    page covering the whole document.
    """

    page_number: int
    text: str
    char_start: int
    char_end: int
    blocks: tuple[TextBlock, ...]
    width: float | None = None
    height: float | None = None


@dataclass(frozen=True)
class ParsedDocument:
    """Result of parsing one uploaded document.

    Invariants (enforced by tests):
      - `full_text[page.char_start:page.char_end] == page.text` for every page
      - `full_text[block.char_start:block.char_end] == block.text` for every
        block on every page
      - `content_hash` is the sha256 of the original input bytes
    """

    full_text: str
    pages: tuple[ParsedPage, ...]
    page_count: int
    content_hash: str
    language: str | None = None


def parse_document(
    file_bytes: bytes,
    filename: str,
    timeout_seconds: int = DEFAULT_PARSE_TIMEOUT_SECONDS,
    max_pages: int = DEFAULT_MAX_PAGES,
) -> ParsedDocument:
    """Parse uploaded document bytes into a `ParsedDocument`.

    Only `.pdf` and `.docx` are accepted; anything else raises
    `UnsupportedDocumentTypeError`. Parsing runs in a spawned worker process
    bounded by `timeout_seconds`; on timeout the worker is terminated and
    `DocumentParseTimeoutError` is raised. Documents whose page count exceeds
    `max_pages` raise `DocumentTooLargeError`. Any Docling failure is wrapped
    in `DocumentParseError` (fail-closed).
    """
    raise NotImplementedError
