from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app.services.document_preview import (
    ConversionFailedError,
    ConverterUnavailableError,
    convert_to_pdf_preview,
)

_PDF_MIME = "application/pdf"
_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def test_pdf_passthrough_does_not_invoke_converter(monkeypatch: pytest.MonkeyPatch) -> None:
    called = False

    def _boom(_name: str) -> str | None:
        nonlocal called
        called = True
        return None

    monkeypatch.setattr("app.services.document_preview.shutil.which", _boom)
    payload = b"%PDF-1.7\ninline\n"
    result = convert_to_pdf_preview(payload, _PDF_MIME)
    assert result.pdf_bytes == payload
    assert result.conversion_source == "pdf"
    assert called is False


def test_docx_success_invokes_libreoffice_with_safe_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    monkeypatch.setattr("app.services.document_preview.shutil.which", lambda _name: "/usr/bin/libreoffice")

    def _run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        seen["cmd"] = cmd
        seen["kwargs"] = kwargs
        in_path = Path(cmd[-1])
        outdir = Path(cmd[cmd.index("--outdir") + 1])
        assert in_path.name == "input.docx"
        assert in_path.parent == outdir
        assert in_path.read_bytes() == b"docx-bytes"
        (outdir / "input.pdf").write_bytes(b"%PDF-1.7\nconverted\n")
        return subprocess.CompletedProcess(cmd, returncode=0, stdout=b"ok", stderr=b"")

    monkeypatch.setattr("app.services.document_preview.subprocess.run", _run)

    result = convert_to_pdf_preview(b"docx-bytes", _DOCX_MIME)
    assert result.pdf_bytes == b"%PDF-1.7\nconverted\n"
    assert result.conversion_source == "docx"

    cmd = seen["cmd"]
    kwargs = seen["kwargs"]
    assert isinstance(cmd, list)
    assert "--headless" in cmd
    assert "--convert-to" in cmd
    assert "pdf" in cmd
    assert "--outdir" in cmd
    assert kwargs["shell"] is False
    assert kwargs["capture_output"] is True


def test_docx_missing_converter_raises_safe_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.services.document_preview.shutil.which", lambda _name: None)
    with pytest.raises(ConverterUnavailableError) as exc:
        convert_to_pdf_preview(b"docx", _DOCX_MIME)
    assert "LibreOffice" in str(exc.value)
    assert "storage_key" not in str(exc.value)


def test_docx_timeout_raises_safe_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.services.document_preview.shutil.which", lambda _name: "/usr/bin/soffice")

    def _run(_cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        raise subprocess.TimeoutExpired(cmd=["soffice"], timeout=20)

    monkeypatch.setattr("app.services.document_preview.subprocess.run", _run)
    with pytest.raises(ConversionFailedError) as exc:
        convert_to_pdf_preview(b"docx", _DOCX_MIME)
    assert str(exc.value) == "timeout"


def test_docx_nonzero_exit_raises_safe_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.services.document_preview.shutil.which", lambda _name: "/usr/bin/soffice")

    def _run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(cmd, returncode=1, stdout=b"private/path", stderr=b"error")

    monkeypatch.setattr("app.services.document_preview.subprocess.run", _run)
    with pytest.raises(ConversionFailedError) as exc:
        convert_to_pdf_preview(b"docx", _DOCX_MIME)
    assert str(exc.value) == "convert failed"


def test_tempdir_cleanup_occurs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    cleanup_state: dict[str, Path | None] = {"path": None}

    class _FakeTempDir:
        def __enter__(self) -> str:
            path = tmp_path / "preview-temp"
            path.mkdir()
            cleanup_state["path"] = path
            return str(path)

        def __exit__(self, exc_type, exc, tb) -> None:
            assert cleanup_state["path"] is not None
            for child in cleanup_state["path"].iterdir():
                child.unlink()
            cleanup_state["path"].rmdir()

    monkeypatch.setattr("app.services.document_preview.shutil.which", lambda _name: "/usr/bin/soffice")
    monkeypatch.setattr("app.services.document_preview.tempfile.TemporaryDirectory", lambda prefix: _FakeTempDir())

    def _run(cmd: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        outdir = Path(cmd[cmd.index("--outdir") + 1])
        (outdir / "input.pdf").write_bytes(b"%PDF")
        return subprocess.CompletedProcess(cmd, returncode=0, stdout=b"", stderr=b"")

    monkeypatch.setattr("app.services.document_preview.subprocess.run", _run)
    result = convert_to_pdf_preview(b"docx", _DOCX_MIME)
    assert result.pdf_bytes == b"%PDF"
    assert cleanup_state["path"] is not None
    assert not cleanup_state["path"].exists()
