"""Tests for ``app.security.rate_limit`` and its wiring into the app.

Covers:
  * the ``limiter`` singleton's static configuration (key function,
    storage backend, default limits) and the documented limit-string
    constants,
  * ``get_remote_address`` key-function behavior,
  * a functional end-to-end test that exceeding the upload endpoint's
    configured rate limit (``UPLOAD_RATE_LIMIT``, wired onto
    ``POST /api/contracts/upload`` in ``app/api/contracts.py``) returns
    429, and that the 429 response still carries the security headers
    (they must apply to every response, including rate-limited ones).
"""
from __future__ import annotations

import secrets
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from slowapi.util import get_remote_address
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from starlette.requests import Request

from app.api import contracts as contracts_api
from app.core.database import Base, get_db
from app.main import app
from app.models import (
    Clause,
    Contract,
    ContractArtifact,
    ContractMarkdownSnapshot,
    ExtractedField,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent
from app.security.encryption import create_org_master_key
from app.security.rate_limit import (
    DEFAULT_API_RATE_LIMIT,
    LOGIN_RATE_LIMIT,
    PASSWORD_RESET_RATE_LIMIT,
    UPLOAD_RATE_LIMIT,
    limiter,
)
from app.services.document_parser import ParsedDocument, ParsedPage
from app.services.storage import StoredDocument

_INSTANCE_KEY = secrets.token_bytes(32)
_PDF_BYTES = b"%PDF-1.7\n% Whereas synthetic test PDF\n"


# ---------------------------------------------------------------------------
# Static configuration
# ---------------------------------------------------------------------------


def test_limit_string_constants_are_the_documented_values() -> None:
    assert LOGIN_RATE_LIMIT == "5/15 minutes"
    assert PASSWORD_RESET_RATE_LIMIT == "3/hour"
    assert DEFAULT_API_RATE_LIMIT == "300/minute"
    assert UPLOAD_RATE_LIMIT == "30/minute"


def test_limiter_uses_remote_address_key_func() -> None:
    assert limiter._key_func is get_remote_address


def test_limiter_uses_in_memory_storage() -> None:
    assert limiter._storage_uri == "memory://"


def test_limiter_default_limits_include_default_api_rate_limit() -> None:
    # ``_default_limits`` is a list of ``LimitGroup`` objects; each is
    # iterable and yields ``Limit`` namedtuples with a ``.limit`` attr
    # whose string form matches what it was configured with.
    rendered = [str(limit.limit) for group in limiter._default_limits for limit in group]
    assert any(DEFAULT_API_RATE_LIMIT.split("/")[0] in r for r in rendered)


# ---------------------------------------------------------------------------
# Key function behavior
# ---------------------------------------------------------------------------


def _fake_request(*, client_host: str | None, forwarded_for: str | None = None) -> Request:
    headers = []
    if forwarded_for is not None:
        headers.append((b"x-forwarded-for", forwarded_for.encode()))
    scope: dict[str, Any] = {
        "type": "http",
        "headers": headers,
        "client": (client_host, 1234) if client_host is not None else None,
    }
    return Request(scope)


def test_get_remote_address_returns_client_host() -> None:
    request = _fake_request(client_host="203.0.113.5")
    assert get_remote_address(request) == "203.0.113.5"


def test_get_remote_address_falls_back_to_loopback_when_no_client() -> None:
    request = _fake_request(client_host=None)
    assert get_remote_address(request) == "127.0.0.1"


def test_get_remote_address_ignores_x_forwarded_for() -> None:
    """``get_remote_address`` (unlike ``get_ipaddr``) always reads the
    immediate peer; per the module's own docstring, honoring a forwarded
    header requires an explicit wrapper the module does not ship."""
    request = _fake_request(client_host="203.0.113.5", forwarded_for="9.9.9.9")
    assert get_remote_address(request) == "203.0.113.5"


# ---------------------------------------------------------------------------
# Functional: exceeding the upload limit returns 429
# ---------------------------------------------------------------------------


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    tables = [
        Organization.__table__,
        User.__table__,
        AuditEvent.__table__,
        Contract.__table__,
        ExtractedField.__table__,
        Clause.__table__,
        ContractMarkdownSnapshot.__table__,
        ContractArtifact.__table__,
    ]

    from pgvector.sqlalchemy import Vector
    from sqlalchemy.ext.compiler import compiles

    @compiles(Vector, "sqlite")
    def _compile_vector_for_sqlite(_type: Any, _compiler: Any, **_kw: Any) -> str:
        return "BLOB"

    @event.listens_for(engine.sync_engine, "connect")
    def _enable_sqlite_foreign_keys(dbapi_connection: Any, _connection_record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all, tables=tables)
        await conn.run_sync(Base.metadata.create_all, tables=tables)
    try:
        yield engine
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all, tables=tables)
        await engine.dispose()


@pytest.fixture
async def db_session(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    async with maker() as session:
        yield session


@pytest.fixture
async def client(db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[httpx.AsyncClient]:
    monkeypatch.setenv("WHEREAS_INSTANCE_KEY", _INSTANCE_KEY.hex())

    async def override_get_db() -> AsyncIterator[AsyncSession]:
        try:
            yield db_session
            await db_session.commit()
        except Exception:
            await db_session.rollback()
            raise

    app.dependency_overrides[get_db] = override_get_db
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@dataclass
class UserOrg:
    org: Organization
    user: User


def _wrapped_org_key(org_id: uuid.UUID) -> bytes:
    return create_org_master_key(
        organization_id=str(org_id),
        instance_key=_INSTANCE_KEY,
    ).to_bytes()


async def _create_user_org(session: AsyncSession) -> UserOrg:
    org = Organization(
        id=uuid.uuid4(),
        name=f"Org {uuid.uuid4()}",
        wrapped_master_key=None,
    )
    org.wrapped_master_key = _wrapped_org_key(org.id)
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Test User",
        is_active=True,
    )
    session.add_all([org, user])
    await session.commit()
    return UserOrg(org=org, user=user)


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


class FakeStorage:
    def __init__(self, _settings: Any) -> None:
        pass

    async def store_encrypted(
        self, *, plaintext_bytes: bytes, document_id: str, org_master_key: bytes
    ) -> StoredDocument:
        return StoredDocument(
            s3_key=f"documents/{document_id}.enc",
            wrapped_dek_bytes=b"wrapped-dek",
            encrypted_blob_sha256="a" * 64,
            size_bytes=len(plaintext_bytes) + 28,
        )


def _parsed_document() -> ParsedDocument:
    text = "Effective Date: 2026-05-06."
    return ParsedDocument(
        full_text=text,
        pages=(ParsedPage(page_number=1, text=text, char_start=0, char_end=len(text), blocks=()),),
        page_count=1,
        content_hash="0" * 64,
    )


@pytest.fixture(autouse=True)
def patch_heavy_seams(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mock every expensive upload-pipeline seam so many rapid uploads
    (needed to trip the rate limit) stay fast and deterministic."""
    monkeypatch.setattr(contracts_api, "DocumentStorage", FakeStorage)
    monkeypatch.setattr(
        contracts_api, "parse_document", lambda file_bytes, filename: _parsed_document()
    )

    async def fake_extract(
        session: AsyncSession, *, contract: Contract, actor_user_id: uuid.UUID | None = None
    ) -> list[ExtractedField]:
        return []

    monkeypatch.setattr(contracts_api, "extract_and_persist_metadata", fake_extract)

    async def fake_snapshot(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(contracts_api, "create_markdown_snapshot_for_contract", fake_snapshot)

    async def fake_segment(*_args: Any, **_kwargs: Any) -> list[Any]:
        return []

    monkeypatch.setattr(contracts_api, "segment_and_persist_clauses", fake_segment)


def _file_tuple(name: str = "contract.pdf") -> dict[str, tuple[str, bytes, str]]:
    return {"file": (name, _PDF_BYTES, "application/pdf")}


async def test_upload_within_limit_succeeds(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    response = await client.post(
        "/api/contracts/upload", headers=_headers(user_org.user), files=_file_tuple()
    )
    assert response.status_code == 201


async def test_exceeding_upload_rate_limit_returns_429(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """``UPLOAD_RATE_LIMIT`` is "30/minute" per client IP. The 31st upload
    from the same client within the window must be rejected with 429,
    and earlier ones must succeed."""
    user_org = await _create_user_org(db_session)
    upload_limit = int(UPLOAD_RATE_LIMIT.split("/")[0])

    responses = []
    for _ in range(upload_limit):
        responses.append(
            await client.post(
                "/api/contracts/upload",
                headers=_headers(user_org.user),
                files=_file_tuple(),
            )
        )
    assert all(r.status_code == 201 for r in responses), [r.text for r in responses]

    over_limit = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    assert over_limit.status_code == 429

    # The 429 response is still processed by SecurityHeadersMiddleware —
    # every response gets the security headers, rate-limited ones included.
    assert over_limit.headers["Content-Security-Policy"]
    assert over_limit.headers["X-Frame-Options"] == "DENY"


async def test_rate_limit_is_scoped_per_client_ip(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """The rate limiter keys on remote address; since the ASGI test
    transport reports the same client for every request, this test
    documents that scoping rather than asserting cross-IP isolation
    (which the in-process test transport cannot exercise)."""
    user_org = await _create_user_org(db_session)
    response = await client.post(
        "/api/contracts/upload", headers=_headers(user_org.user), files=_file_tuple()
    )
    assert response.status_code == 201
    # Same key function is used regardless of which user/org is calling —
    # confirmed directly against the limiter's configured key func.
    assert limiter._key_func is get_remote_address
