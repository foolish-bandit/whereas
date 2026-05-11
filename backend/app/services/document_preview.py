from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

_PDF_MIME = "application/pdf"
_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class DocumentPreviewError(Exception):
    """Base exception for preview conversion failures."""


class ConverterUnavailableError(DocumentPreviewError):
    """No LibreOffice/soffice binary available."""


class ConversionFailedError(DocumentPreviewError):
    """LibreOffice failed to convert the document."""


@dataclass(frozen=True)
class PreviewResult:
    pdf_bytes: bytes
    conversion_source: str


def convert_to_pdf_preview(content: bytes, mime_type: str, *, timeout_seconds: int = 20) -> PreviewResult:
    """Return PDF preview bytes from PDF or DOCX bytes.

    - PDF input is returned unchanged (no converter invocation).
    - DOCX conversion is performed in an ephemeral temp directory.
    - User-controlled names are never used for filesystem paths.
    """
    if mime_type == _PDF_MIME:
        return PreviewResult(pdf_bytes=content, conversion_source="pdf")
    if mime_type != _DOCX_MIME:
        raise ConversionFailedError("unsupported")

    binary = shutil.which("libreoffice") or shutil.which("soffice")
    if not binary:
        raise ConverterUnavailableError("LibreOffice is unavailable")

    with tempfile.TemporaryDirectory(prefix="preview-") as tmpdir:
        tmp_path = Path(tmpdir).resolve()
        input_path = (tmp_path / "input.docx").resolve()
        output_path = (tmp_path / "input.pdf").resolve()
        if input_path.parent != tmp_path or output_path.parent != tmp_path:
            raise ConversionFailedError("invalid temp path")

        input_path.write_bytes(content)
        try:
            completed = subprocess.run(
                [
                    binary,
                    "--headless",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(tmp_path),
                    str(input_path),
                ],
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
                text=False,
                shell=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ConversionFailedError("timeout") from exc

        if completed.returncode != 0 or not output_path.exists():
            raise ConversionFailedError("convert failed")

        return PreviewResult(pdf_bytes=output_path.read_bytes(), conversion_source="docx")
