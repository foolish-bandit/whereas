"""API tests for the integrations router.

Covers the full provider list → connect-session → upsert → list →
manual sync → webhook → delete lifecycle. Nango is stubbed so no
network call leaves the test process.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

try:
    from testcontainers.postgres import PostgresContainer
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment,misc]

from app.api import integrations as integrations_api
from app.core.database import Base, get_db
from app.main import app
from app.models import (
    AgreementTemplate,
    Clause,
    Contract,
    ContractArtifact,
    ContractMarkdownSnapshot,
    ContractRequest,
    ExtractedField,
    InboxItem,
    IntegrationConnection,
    IntegrationImportedFile,
    IntegrationIngestMode,
    IntegrationProvider,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent
from app.security.encryption import create_org_master_key
from app.services import integration_ingest as ingest_service
from app.services import nango_client
from app.services.nango_client import ConnectSession, NangoFile
from app.services.storage import StoredDocument

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)
_NANGO_SECRET = "test-nango-secret-do-not-use-in-prod"  # noqa: S105
_NANGO_WEBHOOK_SECRET = "test-nango-webhook-secret-do-not-use-in-prod"  # noqa: S105
_PDF_BYTES = b"%PDF-1.7\n" + b"x" * 200


def _docker_available() -> bool:
    if PostgresContainer is None:
        return False
    try:
        result = subprocess.run(
            ["docker", "info"], capture_output=True, timeout=5, check=False
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _container_async_url(container: Any) -> str:
    sync_url = container.get_connection_url()
    if sync_url.startswith("postgresql+psycopg2://"):
        return sync_url.replace("postgresql+psycopg2://", "postgresql+asyncpg://", 1)
    if sync_url.startswith("postgresql://"):
        return sync_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return sync_url


@pytest.fixture(scope="module")
def postgres_container() -> Iterator[Any | None]:
    if not _docker_available() or PostgresContainer is None:
        yield None
        return
    container = PostgresContainer(_PG_IMAGE)
    container.start()
    try:
        yield container
    finally:
        container.stop()


@pytest.fixture
async def engine(postgres_container: Any | None) -> AsyncIterator[AsyncEngine]:
    if postgres_container is None:
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
            AgreementTemplate.__table__,
            ContractRequest.__table__,
            InboxItem.__table__,
            IntegrationConnection.__table__,
            IntegrationImportedFile.__table__,
        ]
    else:
        engine = create_async_engine(
            _container_async_url(postgres_container), echo=False
        )
        tables = list(Base.metadata.sorted_tables)

    if engine.dialect.name == "sqlite":
        from pgvector.sqlalchemy import Vector
        from sqlalchemy.ext.compiler import compiles

        @compiles(Vector, "sqlite")
        def _compile_vector_for_sqlite(_t: Any, _c: Any, **_kw: Any) -> str:
            return "BLOB"

        @event.listens_for(engine.sync_engine, "connect")
        def _enable_sqlite_fk(dbapi_connection: Any, _r: Any) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    async with engine.begin() as conn:
        if engine.dialect.name == "postgresql":
            await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")
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


@dataclass
class UserOrg:
    org: Organization
    admin: User
    member: User


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
    admin = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=f"admin-{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Admin",
        is_admin=True,
        is_active=True,
    )
    member = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=f"member-{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Member",
        is_admin=False,
        is_active=True,
    )
    session.add_all([org, admin, member])
    await session.commit()
    return UserOrg(org=org, admin=admin, member=member)


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


class FakeStorage:
    blobs: dict[str, bytes] = {}

    @classmethod
    def reset(cls) -> None:
        cls.blobs = {}

    def __init__(self, _settings: Any) -> None:
        pass

    async def store_encrypted(
        self,
        *,
        plaintext_bytes: bytes,
        document_id: str,
        org_master_key: bytes,
    ) -> StoredDocument:
        s3_key = f"documents/{document_id}.enc"
        FakeStorage.blobs[s3_key] = plaintext_bytes
        return StoredDocument(
            s3_key=s3_key,
            wrapped_dek_bytes=f"wrapped-dek-{document_id}".encode()[:32].ljust(32, b"x"),
            encrypted_blob_sha256="a" * 64,
            size_bytes=len(plaintext_bytes),
        )


@pytest.fixture
async def client(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[httpx.AsyncClient]:
    monkeypatch.setenv("WHEREAS_INSTANCE_KEY", _INSTANCE_KEY.hex())
    monkeypatch.setenv("NANGO_SECRET_KEY", _NANGO_SECRET)
    monkeypatch.setenv("NANGO_WEBHOOK_SECRET", _NANGO_WEBHOOK_SECRET)
    monkeypatch.setenv(
        "NANGO_ENABLED_PROVIDERS",
        "google-drive,microsoft-onedrive",
    )
    from app.core.config import get_settings

    get_settings.cache_clear()
    FakeStorage.reset()

    async def override_get_db() -> AsyncIterator[AsyncSession]:
        try:
            yield db_session
            await db_session.commit()
        except Exception:
            await db_session.rollback()
            raise

    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(ingest_service, "DocumentStorage", FakeStorage)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def _sign_webhook(body: bytes, *, ts: int) -> str:
    signed = f"{ts}.".encode("ascii") + body
    sig = hmac.new(
        _NANGO_WEBHOOK_SECRET.encode("utf-8"),
        signed,
        hashlib.sha256,
    ).hexdigest()
    return f"{ts}.{sig}"


# ---------------------------------------------------------------------------
# Providers + access control
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_providers_marks_enabled(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    users = await _create_user_org(db_session)
    response = await client.get(
        "/api/integrations/providers",
        headers=_headers(users.member),
    )
    assert response.status_code == 200
    by_key = {p["key"]: p for p in response.json()}
    assert by_key["google-drive"]["available"] is True
    assert by_key["microsoft-onedrive"]["available"] is True
    assert by_key["gmail"]["available"] is False


@pytest.mark.asyncio
async def test_create_connect_session_requires_admin(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    users = await _create_user_org(db_session)
    response = await client.post(
        "/api/integrations/connect-sessions",
        headers=_headers(users.member),
        json={"provider": "google-drive"},
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_create_connect_session_rejects_disabled_provider(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    users = await _create_user_org(db_session)
    response = await client.post(
        "/api/integrations/connect-sessions",
        headers=_headers(users.admin),
        json={"provider": "gmail"},
    )
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_create_connect_session_calls_nango(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    users = await _create_user_org(db_session)

    captured: dict[str, Any] = {}

    async def fake_create_connect_session(**kwargs: Any) -> ConnectSession:
        captured.update(kwargs)
        return ConnectSession(token="nango-session-abc", expires_at=None)

    monkeypatch.setattr(
        integrations_api.nango_client,
        "create_connect_session",
        fake_create_connect_session,
    )

    response = await client.post(
        "/api/integrations/connect-sessions",
        headers=_headers(users.admin),
        json={"provider": "google-drive"},
    )
    assert response.status_code == 201
    assert response.json()["token"] == "nango-session-abc"
    assert captured["provider"] == "google-drive"
    assert captured["organization_id"] == str(users.org.id)


# ---------------------------------------------------------------------------
# Upsert / list / update / delete
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upsert_connection_creates_then_refreshes(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    users = await _create_user_org(db_session)
    body = {
        "provider": "google-drive",
        "nango_connection_id": "conn_001",
        "display_name": "Sales Drive",
    }
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json=body,
    )
    assert create.status_code == 201
    first = create.json()
    assert first["display_name"] == "Sales Drive"
    assert first["ingest_mode"] == IntegrationIngestMode.INBOX_REVIEW.value

    # Re-upserting the same provider replaces the nango_connection_id and
    # keeps a single row (per-org unique).
    update = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={
            "provider": "google-drive",
            "nango_connection_id": "conn_002",
            "ingest_mode": "direct",
        },
    )
    assert update.status_code == 201
    second = update.json()
    assert second["id"] == first["id"]
    assert second["ingest_mode"] == IntegrationIngestMode.DIRECT.value

    listed = await client.get(
        "/api/integrations/connections",
        headers=_headers(users.admin),
    )
    assert len(listed.json()) == 1


@pytest.mark.asyncio
async def test_upsert_connection_rejects_unknown_provider(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    users = await _create_user_org(db_session)
    response = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={
            "provider": "facebook-marketplace",
            "nango_connection_id": "abc",
        },
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_upsert_connection_rejects_bad_ingest_mode(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    users = await _create_user_org(db_session)
    response = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={
            "provider": "google-drive",
            "nango_connection_id": "abc",
            "ingest_mode": "yolo",
        },
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_delete_connection_calls_nango(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    users = await _create_user_org(db_session)
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={"provider": "google-drive", "nango_connection_id": "conn_xyz"},
    )
    cid = create.json()["id"]

    called: dict[str, Any] = {}

    async def fake_delete(**kwargs: Any) -> None:
        called.update(kwargs)

    monkeypatch.setattr(
        integrations_api.nango_client, "delete_connection", fake_delete
    )
    response = await client.delete(
        f"/api/integrations/connections/{cid}",
        headers=_headers(users.admin),
    )
    assert response.status_code == 204
    assert called["connection_id"] == "conn_xyz"
    assert called["provider"] == "google-drive"

    remaining = await client.get(
        "/api/integrations/connections", headers=_headers(users.admin)
    )
    assert remaining.json() == []


# ---------------------------------------------------------------------------
# Manual sync
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_manual_sync_ingests_new_file_and_is_idempotent(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    users = await _create_user_org(db_session)
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={"provider": "google-drive", "nango_connection_id": "conn_drive"},
    )
    cid = create.json()["id"]

    file_record = NangoFile(
        provider_file_id="drive_file_1",
        filename="MSA.pdf",
        mime_type="application/pdf",
        size_bytes=len(_PDF_BYTES),
        revision="rev1",
        download_url="https://nango/proxy/drive_file_1",
        metadata={},
    )

    async def fake_list(**_kw: Any) -> tuple[list[NangoFile], str | None]:
        return [file_record], None

    async def fake_download(**_kw: Any) -> bytes:
        return _PDF_BYTES

    monkeypatch.setattr(integrations_api.nango_client, "list_files", fake_list)
    monkeypatch.setattr(nango_client, "download_file", fake_download)
    monkeypatch.setattr(ingest_service, "download_file", fake_download)
    _stub_parser_and_extraction(monkeypatch)

    first = await client.post(
        f"/api/integrations/connections/{cid}/sync",
        headers=_headers(users.admin),
    )
    assert first.status_code == 200
    payload = first.json()
    assert payload["contracts_created"] == 1
    assert payload["files_seen"] == 1

    # Idempotency: same file delivered again creates no new contract.
    second = await client.post(
        f"/api/integrations/connections/{cid}/sync",
        headers=_headers(users.admin),
    )
    assert second.status_code == 200
    assert second.json()["contracts_created"] == 0

    contracts = (
        await db_session.execute(
            select(Contract).where(Contract.organization_id == users.org.id)
        )
    ).scalars().all()
    assert len(contracts) == 1

    # Inbox-review mode emits an InboxItem so a human triages the file.
    items = (
        await db_session.execute(
            select(InboxItem).where(InboxItem.organization_id == users.org.id)
        )
    ).scalars().all()
    assert len(items) == 1
    assert items[0].item_type == "imported_document_review"


@pytest.mark.asyncio
async def test_manual_sync_skips_unsupported_extension(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    users = await _create_user_org(db_session)
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={"provider": "google-drive", "nango_connection_id": "conn_drive"},
    )
    cid = create.json()["id"]

    file_record = NangoFile(
        provider_file_id="img_1",
        filename="photo.jpg",
        mime_type="image/jpeg",
        size_bytes=100,
        revision=None,
        download_url="https://nango/proxy/img_1",
        metadata={},
    )

    async def fake_list(**_kw: Any) -> tuple[list[NangoFile], str | None]:
        return [file_record], None

    monkeypatch.setattr(integrations_api.nango_client, "list_files", fake_list)

    response = await client.post(
        f"/api/integrations/connections/{cid}/sync",
        headers=_headers(users.admin),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["contracts_created"] == 0
    assert body["skipped"] == 1

    # The skip is recorded on the idempotency row so a re-delivery
    # short-circuits without re-downloading.
    row = (
        await db_session.execute(
            select(IntegrationImportedFile).where(
                IntegrationImportedFile.provider_file_id == "img_1"
            )
        )
    ).scalar_one()
    assert row.error_message and "unsupported_extension" in row.error_message
    assert row.contract_id is None


# ---------------------------------------------------------------------------
# Webhook
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_webhook_rejects_invalid_signature(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    response = await client.post(
        "/api/integrations/webhook",
        headers={"X-Nango-Signature": "999.deadbeef"},
        content=b'{"connectionId":"conn"}',
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_webhook_triggers_ingest_for_known_connection(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    users = await _create_user_org(db_session)
    await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={"provider": "google-drive", "nango_connection_id": "conn_w"},
    )

    file_record = NangoFile(
        provider_file_id="drive_file_w",
        filename="NDA.pdf",
        mime_type="application/pdf",
        size_bytes=len(_PDF_BYTES),
        revision=None,
        download_url="https://nango/proxy/drive_file_w",
        metadata={},
    )

    async def fake_list(**_kw: Any) -> tuple[list[NangoFile], str | None]:
        return [file_record], None

    async def fake_download(**_kw: Any) -> bytes:
        return _PDF_BYTES

    monkeypatch.setattr(integrations_api.nango_client, "list_files", fake_list)
    monkeypatch.setattr(nango_client, "download_file", fake_download)
    monkeypatch.setattr(ingest_service, "download_file", fake_download)
    _stub_parser_and_extraction(monkeypatch)

    body = b'{"connectionId":"conn_w","providerConfigKey":"google-drive"}'
    ts = int(datetime.now(UTC).timestamp())
    response = await client.post(
        "/api/integrations/webhook",
        headers={"X-Nango-Signature": _sign_webhook(body, ts=ts)},
        content=body,
    )
    assert response.status_code == 202
    assert response.json() == {"status": "ok"}

    contracts = (
        await db_session.execute(
            select(Contract).where(Contract.organization_id == users.org.id)
        )
    ).scalars().all()
    assert len(contracts) == 1


@pytest.mark.asyncio
async def test_webhook_for_unknown_connection_is_no_op(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    body = b'{"connectionId":"never_seen","providerConfigKey":"google-drive"}'
    ts = int(datetime.now(UTC).timestamp())
    response = await client.post(
        "/api/integrations/webhook",
        headers={"X-Nango-Signature": _sign_webhook(body, ts=ts)},
        content=body,
    )
    assert response.status_code == 202
    assert response.json() == {"status": "ignored"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _stub_parser_and_extraction(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub the heavy parsing / extraction pipeline.

    The integration ingest service calls into the same parser /
    extractor as the upload route. The plumbing for those is tested
    elsewhere; here we just need them to return cheaply so the test
    can focus on the integration-specific behavior.
    """
    from app.services import (
        clause_segmentation,
        document_markdown,
        document_parser,
        extraction,
    )

    class _ParsedPage:
        def __init__(self, idx: int, text: str) -> None:
            self.page_index = idx
            self.text = text

    class _Parsed:
        def __init__(self) -> None:
            self.full_text = "Some contract body."
            self.page_count = 1
            self.pages = [_ParsedPage(0, "Some contract body.")]

    def fake_parse(_bytes: bytes, _filename: str) -> Any:
        return _Parsed()

    async def fake_extract(*_a: Any, **_kw: Any) -> list[Any]:
        return []

    async def fake_segment(*_a: Any, **_kw: Any) -> list[Any]:
        return []

    async def fake_markdown(*_a: Any, **_kw: Any) -> None:
        return None

    monkeypatch.setattr(ingest_service, "parse_document", fake_parse)
    monkeypatch.setattr(document_parser, "parse_document", fake_parse)
    monkeypatch.setattr(
        ingest_service, "extract_and_persist_metadata", fake_extract
    )
    monkeypatch.setattr(extraction, "extract_and_persist_metadata", fake_extract)
    monkeypatch.setattr(
        ingest_service, "segment_and_persist_clauses", fake_segment
    )
    monkeypatch.setattr(
        clause_segmentation, "segment_and_persist_clauses", fake_segment
    )
    monkeypatch.setattr(
        ingest_service,
        "create_markdown_snapshot_for_contract",
        fake_markdown,
    )
    monkeypatch.setattr(
        document_markdown,
        "create_markdown_snapshot_for_contract",
        fake_markdown,
    )


# Suppress unused-import warnings for the enum kept available for callers.
_ = IntegrationProvider


# ---------------------------------------------------------------------------
# Folder picker
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_connection_persists_folder_picker_fields(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    users = await _create_user_org(db_session)
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={"provider": "google-drive", "nango_connection_id": "conn_drive"},
    )
    cid = create.json()["id"]
    assert create.json()["root_folder_id"] is None

    patch = await client.patch(
        f"/api/integrations/connections/{cid}",
        headers=_headers(users.admin),
        json={
            "root_folder_id": "drive_folder_abc",
            "root_folder_name": "Sales › 2026 Renewals",
        },
    )
    assert patch.status_code == 200, patch.text
    body = patch.json()
    assert body["root_folder_id"] == "drive_folder_abc"
    assert body["root_folder_name"] == "Sales › 2026 Renewals"

    # The picker fields survive a round-trip via GET /connections.
    listed = await client.get(
        "/api/integrations/connections", headers=_headers(users.admin)
    )
    assert listed.status_code == 200
    by_id = {c["id"]: c for c in listed.json()}
    assert by_id[cid]["root_folder_id"] == "drive_folder_abc"
    assert by_id[cid]["root_folder_name"] == "Sales › 2026 Renewals"


@pytest.mark.asyncio
async def test_update_connection_clears_folder_with_empty_string(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    users = await _create_user_org(db_session)
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={"provider": "google-drive", "nango_connection_id": "conn_drive"},
    )
    cid = create.json()["id"]
    await client.patch(
        f"/api/integrations/connections/{cid}",
        headers=_headers(users.admin),
        json={"root_folder_id": "f1", "root_folder_name": "Folder"},
    )
    # Sending an empty string clears both id and name.
    cleared = await client.patch(
        f"/api/integrations/connections/{cid}",
        headers=_headers(users.admin),
        json={"root_folder_id": ""},
    )
    assert cleared.status_code == 200
    assert cleared.json()["root_folder_id"] is None
    assert cleared.json()["root_folder_name"] is None


@pytest.mark.asyncio
async def test_update_connection_partial_patch_preserves_folder(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A PATCH that doesn't mention the folder fields leaves them alone."""
    users = await _create_user_org(db_session)
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={"provider": "google-drive", "nango_connection_id": "conn_drive"},
    )
    cid = create.json()["id"]
    await client.patch(
        f"/api/integrations/connections/{cid}",
        headers=_headers(users.admin),
        json={"root_folder_id": "f1", "root_folder_name": "Folder One"},
    )
    bumped = await client.patch(
        f"/api/integrations/connections/{cid}",
        headers=_headers(users.admin),
        json={"ingest_mode": "direct"},
    )
    assert bumped.status_code == 200
    assert bumped.json()["root_folder_id"] == "f1"
    assert bumped.json()["root_folder_name"] == "Folder One"
    assert bumped.json()["ingest_mode"] == "direct"


@pytest.mark.asyncio
async def test_list_folders_requires_admin(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    users = await _create_user_org(db_session)
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={"provider": "google-drive", "nango_connection_id": "conn_drive"},
    )
    cid = create.json()["id"]
    forbidden = await client.post(
        f"/api/integrations/connections/{cid}/list-folders",
        headers=_headers(users.member),
        json={},
    )
    assert forbidden.status_code == 403


@pytest.mark.asyncio
async def test_list_folders_google_drive(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    users = await _create_user_org(db_session)
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={"provider": "google-drive", "nango_connection_id": "conn_drive"},
    )
    cid = create.json()["id"]

    captured: dict[str, Any] = {}

    async def fake_proxy_get(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return {
            "files": [
                {"id": "folder_a", "name": "Sales", "parents": ["root"]},
                {"id": "folder_b", "name": "Legal", "parents": ["root"]},
                {"id": "folder_c", "name": "junk", "parents": ["root"]},
            ]
        }

    monkeypatch.setattr(nango_client, "_proxy_get", fake_proxy_get)

    response = await client.post(
        f"/api/integrations/connections/{cid}/list-folders",
        headers=_headers(users.admin),
        json={"parent_id": "root"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["parent_id"] == "root"
    names = [f["name"] for f in body["folders"]]
    assert names == ["Sales", "Legal", "junk"]
    assert all(f["has_children"] is True for f in body["folders"])
    # The Nango proxy was called with a folders-only `q`.
    assert captured["provider"] == "google-drive"
    assert captured["path"] == "drive/v3/files"
    assert (
        "mimeType = 'application/vnd.google-apps.folder'"
        in captured["params"]["q"]
    )
    assert "'root' in parents" in captured["params"]["q"]


@pytest.mark.asyncio
async def test_list_folders_onedrive_rejects_unsafe_parent_id(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    users = await _create_user_org(db_session)
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={
            "provider": "microsoft-onedrive",
            "nango_connection_id": "conn_od",
        },
    )
    cid = create.json()["id"]

    async def fake_proxy_get(**_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("proxy should not be called for an invalid id")

    monkeypatch.setattr(nango_client, "_proxy_get", fake_proxy_get)

    response = await client.post(
        f"/api/integrations/connections/{cid}/list-folders",
        headers=_headers(users.admin),
        json={"parent_id": "../../etc/passwd"},
    )
    assert response.status_code == 400
    assert "Invalid OneDrive folder id" in response.json()["detail"]


@pytest.mark.asyncio
async def test_list_folders_unsupported_provider_returns_400(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    users = await _create_user_org(db_session)
    # Drop a connection for an unsupported provider directly so we can
    # exercise the dispatch error without needing the provider in the
    # enabled-list.
    connection = IntegrationConnection(
        organization_id=users.org.id,
        provider="gmail",
        nango_connection_id="conn_gmail",
        status="active",
        ingest_mode=IntegrationIngestMode.INBOX_REVIEW.value,
        created_by=users.admin.id,
    )
    db_session.add(connection)
    await db_session.commit()

    response = await client.post(
        f"/api/integrations/connections/{connection.id}/list-folders",
        headers=_headers(users.admin),
        json={},
    )
    assert response.status_code == 400
    assert "not implemented" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_manual_sync_filters_to_root_folder(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A scoped connection ingests only files inside the picked folder."""
    users = await _create_user_org(db_session)
    create = await client.post(
        "/api/integrations/connections",
        headers=_headers(users.admin),
        json={"provider": "google-drive", "nango_connection_id": "conn_drive"},
    )
    cid = create.json()["id"]

    # Scope to a specific folder via PATCH.
    await client.patch(
        f"/api/integrations/connections/{cid}",
        headers=_headers(users.admin),
        json={
            "root_folder_id": "folder_inside",
            "root_folder_name": "Inside",
        },
    )

    inside = NangoFile(
        provider_file_id="file_inside",
        filename="inside.pdf",
        mime_type="application/pdf",
        size_bytes=len(_PDF_BYTES),
        revision="r1",
        download_url="https://nango/proxy/file_inside",
        metadata={"parents": ["folder_inside"]},
    )
    outside = NangoFile(
        provider_file_id="file_outside",
        filename="outside.pdf",
        mime_type="application/pdf",
        size_bytes=len(_PDF_BYTES),
        revision="r1",
        download_url="https://nango/proxy/file_outside",
        metadata={"parents": ["folder_elsewhere"]},
    )

    async def fake_list(**_kw: Any) -> tuple[list[NangoFile], str | None]:
        return [inside, outside], None

    async def fake_download(**_kw: Any) -> bytes:
        return _PDF_BYTES

    monkeypatch.setattr(integrations_api.nango_client, "list_files", fake_list)
    monkeypatch.setattr(nango_client, "download_file", fake_download)
    monkeypatch.setattr(ingest_service, "download_file", fake_download)
    _stub_parser_and_extraction(monkeypatch)

    response = await client.post(
        f"/api/integrations/connections/{cid}/sync",
        headers=_headers(users.admin),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["files_seen"] == 2
    assert body["contracts_created"] == 1
    assert body["skipped"] == 1

    contracts = (
        await db_session.execute(
            select(Contract).where(Contract.organization_id == users.org.id)
        )
    ).scalars().all()
    assert len(contracts) == 1
    assert contracts[0].title == "inside.pdf"


def test_file_is_under_folder_handles_common_shapes() -> None:
    """The metadata filter accepts the shapes Nango sync templates emit."""
    drive = NangoFile(
        provider_file_id="x",
        filename="x.pdf",
        mime_type=None,
        size_bytes=None,
        revision=None,
        download_url=None,
        metadata={"parents": ["pick_me"]},
    )
    onedrive = NangoFile(
        provider_file_id="y",
        filename="y.pdf",
        mime_type=None,
        size_bytes=None,
        revision=None,
        download_url=None,
        metadata={"parentReference": {"id": "pick_me"}},
    )
    elsewhere = NangoFile(
        provider_file_id="z",
        filename="z.pdf",
        mime_type=None,
        size_bytes=None,
        revision=None,
        download_url=None,
        metadata={"parents": ["other"]},
    )
    no_parent_info = NangoFile(
        provider_file_id="w",
        filename="w.pdf",
        mime_type=None,
        size_bytes=None,
        revision=None,
        download_url=None,
        metadata={},
    )

    assert nango_client.file_is_under_folder(drive, "pick_me") is True
    assert nango_client.file_is_under_folder(onedrive, "pick_me") is True
    assert nango_client.file_is_under_folder(elsewhere, "pick_me") is False
    # Empty/None scope → always allow.
    assert nango_client.file_is_under_folder(drive, None) is True
    assert nango_client.file_is_under_folder(drive, "") is True
    # No parent info → default-allow (don't silently drop).
    assert nango_client.file_is_under_folder(no_parent_info, "pick_me") is True
