"""Document → Markdown conversion service.

Whereas treats DOCX/PDF as the original legal artifact and stores a
lightweight Markdown working snapshot for fast preview, search, and
future local-first sync. This module is the seam between an uploaded
file and that snapshot.

Design notes:
- This abstraction must NOT pin the project to a single converter. The
  preferred path is Microsoft MarkItDown (MIT, no LLM dependency); when
  it isn't installed or fails on a particular input, we fall back to a
  plain-text representation derived from text the caller already
  produced (e.g., ``ParsedDocument.full_text`` from Docling).
- Conversion is non-fatal. The result type carries a ``status`` so the
  upload pipeline can persist a snapshot row when there is something
  useful to surface and skip persistence (without raising) otherwise.
- No network calls. No third-party LLM calls. Self-host parity is the
  default deployment.
"""
from __future__ import annotations

import logging
import os
import shutil
import tempfile
from dataclasses import dataclass, field
from typing import Literal

log = logging.getLogger(__name__)


CONVERTER_MARKITDOWN = "markitdown"
CONVERTER_FALLBACK_PLAIN_TEXT = "fallback_plain_text"
CONVERTER_NONE = "none"

ConversionStatus = Literal["ready", "failed"]


@dataclass(frozen=True)
class MarkdownConversionResult:
    """Outcome of a single conversion attempt.

    ``markdown_text`` is empty when ``status='failed'``. Callers should
    inspect ``status`` before persisting a snapshot row.
    """

    status: ConversionStatus
    markdown_text: str
    converter_name: str
    converter_version: str | None = None
    warnings: list[str] = field(default_factory=list)


def convert_document_to_markdown(
    file_bytes: bytes,
    mime_type: str,
    filename: str | None = None,
    *,
    fallback_plain_text: str | None = None,
) -> MarkdownConversionResult:
    """Convert an uploaded document's bytes into Markdown.

    Order of attempts:
      1. Microsoft MarkItDown, if importable and the input is non-empty.
      2. ``fallback_plain_text`` (typically ``ParsedDocument.full_text``)
         wrapped as a minimal Markdown document, if non-empty.
      3. A failed result. The caller decides whether to skip persistence.

    Conversion never raises: any underlying failure is caught and turned
    into a warning + the next fallback. Upload must not depend on this
    succeeding.
    """
    if not file_bytes:
        return _failed(
            CONVERTER_NONE,
            warnings=["empty_input"],
        )

    warnings: list[str] = []

    markitdown_result = _try_markitdown(file_bytes, mime_type, filename)
    if markitdown_result is not None:
        if markitdown_result.status == "ready":
            return markitdown_result
        # Carry the warnings forward so operators can see what happened.
        warnings.extend(markitdown_result.warnings)

    if fallback_plain_text and fallback_plain_text.strip():
        return MarkdownConversionResult(
            status="ready",
            markdown_text=_wrap_plain_text(fallback_plain_text),
            converter_name=CONVERTER_FALLBACK_PLAIN_TEXT,
            converter_version=None,
            warnings=warnings,
        )

    warnings.append("no_fallback_text_available")
    return _failed(CONVERTER_NONE, warnings=warnings)


async def create_markdown_snapshot_for_contract(
    session,
    *,
    contract,
    file_bytes: bytes,
    fallback_plain_text: str | None,
    actor_user_id=None,
    source_kind: str = "original_upload",
) -> object | None:
    """Run conversion and persist a snapshot row when there is one.

    Returns the persisted ``ContractMarkdownSnapshot`` (already added
    to the session and flushed) or ``None`` when conversion produced no
    usable output. Never raises — the upload pipeline must not depend
    on markdown conversion succeeding.
    """
    from app.models import ContractMarkdownSnapshot

    try:
        result = convert_document_to_markdown(
            file_bytes=file_bytes,
            mime_type=contract.mime_type,
            filename=None,
            fallback_plain_text=fallback_plain_text,
        )
    except Exception:  # pragma: no cover - defensive
        log.exception(
            "Markdown conversion raised unexpectedly; upload continues",
            extra={"contract_id": str(contract.id)},
        )
        return None

    if result.status != "ready" or not result.markdown_text:
        log.info(
            "No markdown snapshot persisted for contract",
            extra={
                "contract_id": str(contract.id),
                "converter_name": result.converter_name,
                "warnings": result.warnings,
            },
        )
        return None

    snapshot = ContractMarkdownSnapshot(
        contract_id=contract.id,
        organization_id=contract.organization_id,
        markdown_text=result.markdown_text,
        source_kind=source_kind,
        converter_name=result.converter_name,
        converter_version=result.converter_version,
        conversion_status=result.status,
        conversion_warnings=list(result.warnings) if result.warnings else None,
        created_by=actor_user_id,
    )
    session.add(snapshot)
    try:
        await session.flush()
    except Exception:  # pragma: no cover - defensive
        log.exception(
            "Failed to persist markdown snapshot; upload continues",
            extra={"contract_id": str(contract.id)},
        )
        return None
    return snapshot


def _try_markitdown(
    file_bytes: bytes,
    mime_type: str,
    filename: str | None,
) -> MarkdownConversionResult | None:
    """Best-effort MarkItDown conversion.

    Returns ``None`` if MarkItDown is not installed (so the caller can
    silently fall through). Returns a failed result if it is installed
    but raised — that case is interesting enough to warn on.
    """
    try:
        from markitdown import MarkItDown  # type: ignore[import-not-found]
    except ImportError:
        return None

    version = _safe_module_version("markitdown")

    suffix = _suffix_for(mime_type, filename)
    tmpdir = tempfile.mkdtemp(prefix="whereas-md-")
    try:
        path = os.path.join(tmpdir, f"input{suffix}")
        with open(path, "wb") as f:
            f.write(file_bytes)
        try:
            md = MarkItDown()
            converted = md.convert(path)
        except Exception as exc:  # pragma: no cover - defensive
            log.warning(
                "MarkItDown conversion raised; falling through",
                extra={
                    "mime_type": mime_type,
                    "input_filename": filename,
                    "error": f"{type(exc).__name__}: {exc}",
                },
            )
            return _failed(
                CONVERTER_MARKITDOWN,
                converter_version=version,
                warnings=[f"markitdown_error:{type(exc).__name__}"],
            )

        text = (getattr(converted, "text_content", None) or "").strip()
        if not text:
            return _failed(
                CONVERTER_MARKITDOWN,
                converter_version=version,
                warnings=["markitdown_empty_output"],
            )
        return MarkdownConversionResult(
            status="ready",
            markdown_text=text,
            converter_name=CONVERTER_MARKITDOWN,
            converter_version=version,
            warnings=[],
        )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _failed(
    converter_name: str,
    *,
    converter_version: str | None = None,
    warnings: list[str] | None = None,
) -> MarkdownConversionResult:
    return MarkdownConversionResult(
        status="failed",
        markdown_text="",
        converter_name=converter_name,
        converter_version=converter_version,
        warnings=list(warnings or []),
    )


def _wrap_plain_text(text: str) -> str:
    """Render plain text as a minimal valid Markdown document.

    Markdown is a superset of plain text, but normalizing line endings
    keeps later diff/merge work simpler.
    """
    return text.replace("\r\n", "\n").replace("\r", "\n").strip() + "\n"


_MIME_SUFFIX_MAP = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/msword": ".doc",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/html": ".html",
}


def _suffix_for(mime_type: str, filename: str | None) -> str:
    """Pick a file extension MarkItDown can dispatch on.

    Most converters key off the extension rather than sniffing bytes.
    Falls back to whatever extension the original filename carried, then
    to ``.bin`` so the temp file is at least syntactically valid.
    """
    suffix = _MIME_SUFFIX_MAP.get(mime_type)
    if suffix:
        return suffix
    if filename:
        _, ext = os.path.splitext(filename)
        if ext:
            return ext.lower()
    return ".bin"


def _safe_module_version(name: str) -> str | None:
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version(name)
        except PackageNotFoundError:
            return None
    except Exception:  # pragma: no cover - defensive
        return None
