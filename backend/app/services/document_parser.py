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

import hashlib
import io
import logging
import multiprocessing
import os
import shutil
import tempfile
from dataclasses import dataclass

log = logging.getLogger(__name__)

DEFAULT_PARSE_TIMEOUT_SECONDS = 300
DEFAULT_MAX_PAGES = 1000

SUPPORTED_EXTENSIONS = frozenset({".pdf", ".docx"})

_PAGE_SEPARATOR = "\f"
_BLOCK_SEPARATOR = "\n"


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
    `bbox` is `(left, top, right, bottom)` in the page's native units (PDF
    points for PDFs), normalized to a top-left origin. It is `None` when
    Docling does not surface coordinates (e.g. DOCX) or when the page size
    needed for normalization is unavailable.
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
      - `content_hash` is the sha256 hex digest of the original input bytes
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
    `DocumentParseTimeoutError` is raised. PDFs whose page count exceeds
    `max_pages` raise `DocumentTooLargeError` (DOCX has no native page count
    so the cap is not enforced for that format). Any Docling failure is
    wrapped in `DocumentParseError` (fail-closed).
    """
    ext = _normalize_extension(filename)
    if ext not in SUPPORTED_EXTENSIONS:
        msg = (
            f"Unsupported document type {ext!r}. "
            "Whereas accepts .pdf and .docx. "
            "If this is a legacy .doc file, please re-save it as .docx."
        )
        raise UnsupportedDocumentTypeError(msg)

    if ext == ".pdf":
        page_count = _pdf_page_count(file_bytes)
        if page_count > max_pages:
            raise DocumentTooLargeError(
                f"PDF has {page_count} pages, exceeds the {max_pages}-page limit."
            )

    return _run_in_subprocess(file_bytes, ext, timeout_seconds)


def _normalize_extension(filename: str) -> str:
    """Return the lowercased extension including the leading dot.

    Defensive against Windows-style paths and stray separators in user input.
    """
    base = os.path.basename(filename.replace("\\", "/"))
    _, ext = os.path.splitext(base)
    return ext.lower()


def _pdf_page_count(file_bytes: bytes) -> int:
    """Cheap pre-pass: return PDF page count using pypdf's trailer parsing.

    Wraps any pypdf failure in `DocumentParseError` so a corrupt PDF never
    reaches the heavier Docling pipeline.
    """
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(file_bytes), strict=False)
        return len(reader.pages)
    except (PdfReadError, ValueError, OSError) as e:
        raise DocumentParseError(f"Could not read PDF metadata: {e}") from e


def _run_in_subprocess(
    file_bytes: bytes, ext: str, timeout_seconds: int
) -> ParsedDocument:
    """Run the Docling parse in a spawned worker process with a hard timeout."""
    ctx = multiprocessing.get_context("spawn")
    parent_conn, child_conn = ctx.Pipe(duplex=False)
    proc = ctx.Process(
        target=_worker_entry,
        args=(child_conn, file_bytes, ext),
        name="whereas-document-parser",
    )
    proc.start()
    child_conn.close()  # parent doesn't write
    try:
        proc.join(timeout=timeout_seconds)
        if proc.is_alive():
            log.warning(
                "Document parse exceeded timeout; terminating worker",
                extra={"timeout_seconds": timeout_seconds, "pid": proc.pid},
            )
            proc.terminate()
            proc.join(5)
            if proc.is_alive():
                proc.kill()
                proc.join()
            raise DocumentParseTimeoutError(
                f"Parsing exceeded {timeout_seconds}s budget."
            )

        try:
            payload = parent_conn.recv()
        except EOFError as e:
            raise DocumentParseError(
                f"Parser worker exited without producing a result (exitcode={proc.exitcode})"
            ) from e

        kind, data = payload
        if kind == "ok":
            return data
        if kind == "err":
            raise DocumentParseError(data)
        raise DocumentParseError(f"Unexpected payload kind from worker: {kind!r}")
    finally:
        parent_conn.close()
        if proc.is_alive():
            proc.kill()
            proc.join()


def _worker_entry(conn, file_bytes: bytes, ext: str) -> None:
    """Top-level worker entrypoint. Must be picklable for `spawn`."""
    try:
        result = _parse_bytes_in_worker(file_bytes, ext)
        conn.send(("ok", result))
    except Exception as e:
        conn.send(("err", f"{type(e).__name__}: {e}"))
    finally:
        conn.close()


def _parse_bytes_in_worker(file_bytes: bytes, ext: str) -> ParsedDocument:
    """The actual Docling parse. Runs only inside the worker process."""
    from docling.document_converter import DocumentConverter

    content_hash = hashlib.sha256(file_bytes).hexdigest()

    tmpdir = tempfile.mkdtemp(prefix="whereas-parse-")
    try:
        path = os.path.join(tmpdir, f"input{ext}")
        with open(path, "wb") as f:
            f.write(file_bytes)
        converter = DocumentConverter()
        result = converter.convert(path)
        doc = result.document
        return _docling_to_parsed_document(doc, content_hash)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _docling_to_parsed_document(doc, content_hash: str) -> ParsedDocument:
    """Build a `ParsedDocument` whose offsets are exact by construction.

    We iterate Docling's items in reading order, group them by page, and
    assemble `full_text` ourselves so that `full_text[block.char_start:
    block.char_end] == block.text` holds. This is the invariant the
    extraction layer relies on for span validation.
    """
    pages_in_order: list[int] = []
    by_page: dict[int, list[tuple[str, tuple[float, float, float, float] | None]]] = {}

    for item, _level in doc.iterate_items():
        text = getattr(item, "text", None) or ""
        if not text.strip():
            continue

        bbox: tuple[float, float, float, float] | None = None
        page_no = 1
        prov_list = getattr(item, "prov", None) or []
        if prov_list:
            pr = prov_list[0]
            page_no = pr.page_no
            bbox = _bbox_for(doc, pr)

        if page_no not in by_page:
            by_page[page_no] = []
            pages_in_order.append(page_no)
        by_page[page_no].append((text, bbox))

    # Synthesize one empty page if the document had no extractable text, so
    # downstream callers can still rely on `pages` being non-empty.
    if not pages_in_order:
        pages_in_order.append(1)
        by_page[1] = []

    parts: list[str] = []
    cursor = 0
    page_records: list[ParsedPage] = []

    for page_index, page_no in enumerate(pages_in_order):
        page_start = cursor
        block_records: list[TextBlock] = []

        for block_index, (block_text, bbox) in enumerate(by_page[page_no]):
            if block_index > 0:
                parts.append(_BLOCK_SEPARATOR)
                cursor += len(_BLOCK_SEPARATOR)
            block_start = cursor
            parts.append(block_text)
            cursor += len(block_text)
            block_records.append(
                TextBlock(
                    text=block_text,
                    page_number=page_no,
                    char_start=block_start,
                    char_end=cursor,
                    bbox=bbox,
                )
            )

        page_end = cursor
        width, height = _page_dimensions(doc, page_no)
        page_records.append(
            ParsedPage(
                page_number=page_no,
                text="",  # filled in once full_text is assembled
                char_start=page_start,
                char_end=page_end,
                blocks=tuple(block_records),
                width=width,
                height=height,
            )
        )

        if page_index + 1 < len(pages_in_order):
            parts.append(_PAGE_SEPARATOR)
            cursor += len(_PAGE_SEPARATOR)

    full_text = "".join(parts)
    pages_final = tuple(
        ParsedPage(
            page_number=p.page_number,
            text=full_text[p.char_start:p.char_end],
            char_start=p.char_start,
            char_end=p.char_end,
            blocks=p.blocks,
            width=p.width,
            height=p.height,
        )
        for p in page_records
    )

    docling_page_count = doc.num_pages() or 0
    page_count = max(docling_page_count, len(pages_final), 1)

    return ParsedDocument(
        full_text=full_text,
        pages=pages_final,
        page_count=page_count,
        content_hash=content_hash,
        language=None,
    )


def _bbox_for(doc, prov) -> tuple[float, float, float, float] | None:
    """Normalize a Docling bbox to (left, top, right, bottom) in TOPLEFT coords."""
    page = (doc.pages or {}).get(prov.page_no)
    page_height = getattr(getattr(page, "size", None), "height", None)
    if page_height is None:
        return None
    try:
        normalized = prov.bbox.to_top_left_origin(page_height)
        left, top, right, bottom = normalized.as_tuple()
        return (float(left), float(top), float(right), float(bottom))
    except (AttributeError, ValueError):
        return None


def _page_dimensions(doc, page_no: int) -> tuple[float | None, float | None]:
    page = (doc.pages or {}).get(page_no)
    size = getattr(page, "size", None)
    if size is None:
        return None, None
    return getattr(size, "width", None), getattr(size, "height", None)
