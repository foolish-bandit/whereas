"""Decompression-bomb guard for DOCX (OOXML zip) handling.

Three sites open uploaded/rendered DOCX bytes as zip archives:
  * ``app.api.contracts._looks_like_docx`` (upload validation)
  * ``app.services.integration_ingest._looks_like_docx`` (Nango ingest)
  * ``app.services.template_generation._extract_plain_text_for_fallback``
    (markdown-fallback text extraction from a freshly rendered DOCX)

All three now sum ``ZipInfo.file_size`` (the archive's *declared*
uncompressed size) across every member and reject the file once that
total exceeds ``Settings.DOCX_MAX_UNCOMPRESSED_BYTES``, before any
downstream code actually inflates the member. This guards against a
small, highly-compressible zip that declares (truthfully — no metadata
is forged) a huge uncompressed payload.

Tests lower the cap via monkeypatching the cached ``Settings`` singleton
so the "bomb" member can stay small enough to keep the test fast and
light on memory, while still exceeding the (lowered) cap.
"""
from __future__ import annotations

import zipfile
from io import BytesIO

import pytest

from app.api import contracts as contracts_api
from app.core.config import get_settings
from app.services import integration_ingest
from app.services import template_generation as template_generation_service


def _make_zip(members: dict[str, bytes]) -> bytes:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in members.items():
            zf.writestr(name, content)
    return buf.getvalue()


def _valid_docx_bytes(body: bytes = b"<w:document/>") -> bytes:
    return _make_zip(
        {
            "[Content_Types].xml": b"<Types/>",
            "word/document.xml": body,
        }
    )


def _bomb_docx_bytes(uncompressed_size: int) -> bytes:
    # All-zero payload: legitimately declares ``uncompressed_size`` bytes
    # (ZipInfo.file_size is truthful) while compressing to a few dozen
    # bytes, so the test file itself stays tiny.
    return _valid_docx_bytes(body=b"\x00" * uncompressed_size)


@pytest.fixture(autouse=True)
def _lower_cap(monkeypatch: pytest.MonkeyPatch) -> int:
    """Lower ``DOCX_MAX_UNCOMPRESSED_BYTES`` to a test-friendly size.

    ``get_settings()`` is an ``lru_cache``d singleton; mutating its
    attribute directly (rather than swapping the function) keeps every
    other setting real and reverts automatically via monkeypatch's
    teardown.
    """
    cap = 100_000  # 100 KB
    monkeypatch.setattr(get_settings(), "DOCX_MAX_UNCOMPRESSED_BYTES", cap)
    return cap


# ---------------------------------------------------------------------------
# app.api.contracts._looks_like_docx
# ---------------------------------------------------------------------------


def test_contracts_looks_like_docx_accepts_normal_file(_lower_cap: int) -> None:
    assert contracts_api._looks_like_docx(_valid_docx_bytes()) is True


def test_contracts_looks_like_docx_rejects_declared_oversized_member(_lower_cap: int) -> None:
    bomb = _bomb_docx_bytes(_lower_cap * 10)
    assert contracts_api._looks_like_docx(bomb) is False


def test_contracts_looks_like_docx_accepts_member_just_under_cap(_lower_cap: int) -> None:
    # Leave headroom for the other small member + zip overhead.
    under_cap = _valid_docx_bytes(body=b"\x00" * (_lower_cap - 1000))
    assert contracts_api._looks_like_docx(under_cap) is True


# ---------------------------------------------------------------------------
# app.services.integration_ingest._looks_like_docx
# ---------------------------------------------------------------------------


def test_integration_ingest_looks_like_docx_accepts_normal_file(_lower_cap: int) -> None:
    assert integration_ingest._looks_like_docx(_valid_docx_bytes()) is True


def test_integration_ingest_looks_like_docx_rejects_declared_oversized_member(
    _lower_cap: int,
) -> None:
    bomb = _bomb_docx_bytes(_lower_cap * 10)
    assert integration_ingest._looks_like_docx(bomb) is False


# ---------------------------------------------------------------------------
# app.services.template_generation._extract_plain_text_for_fallback
# ---------------------------------------------------------------------------


def test_template_generation_extract_plain_text_returns_none_for_bomb(_lower_cap: int) -> None:
    bomb = _bomb_docx_bytes(_lower_cap * 10)
    assert template_generation_service._extract_plain_text_for_fallback(bomb) is None


def test_template_generation_extract_plain_text_still_works_for_normal_docx(
    _lower_cap: int,
) -> None:
    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = (
        f'<w:document xmlns:w="{ns}"><w:body><w:p><w:r>'
        "<w:t>Hello contract world</w:t>"
        "</w:r></w:p></w:body></w:document>"
    ).encode()
    text = template_generation_service._extract_plain_text_for_fallback(
        _valid_docx_bytes(body=body)
    )
    assert text == "Hello contract world"


# ---------------------------------------------------------------------------
# Upload endpoint end-to-end rejection (contracts.py's caller of
# ``_looks_like_docx`` via ``_validate_upload``)
# ---------------------------------------------------------------------------


def test_validate_upload_rejects_docx_zip_bomb(_lower_cap: int) -> None:
    from fastapi import HTTPException

    bomb = _bomb_docx_bytes(_lower_cap * 10)
    with pytest.raises(HTTPException) as excinfo:
        contracts_api._validate_upload(
            filename="bomb.docx",
            content_type=(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ),
            file_bytes=bomb,
            max_bytes=get_settings().CONTRACT_UPLOAD_MAX_BYTES,
        )
    assert excinfo.value.status_code == 400
    assert "not a valid DOCX" in excinfo.value.detail
