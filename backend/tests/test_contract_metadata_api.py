"""API tests for the user-confirmed contract metadata endpoint (PR #67).

After PR #66 lands extracted-metadata suggestions + duplicate
warnings on the upload responses, PR #67 lets a user confirm or
override the suggested values via:

    PATCH /api/contracts/{contract_id}/metadata
    GET   /api/contracts/{contract_id}/metadata

The endpoint deliberately does NOT migrate the Contract schema —
``title`` lives on the existing ``Contract.title`` column, and
``counterparty_name`` / ``contract_type`` / ``effective_date`` are
stored on the latest ``original_upload`` artifact's ``metadata_json``
(the same dict the request-upload conversion writes through). Other
artifacts and storage / encryption fields are not touched.

Test infrastructure mirrors the pattern other contract API tests use:
in-memory SQLite when Docker isn't available, ``FakeStorage`` stand-in
for S3, and the dev-user header for auth.
"""
from __future__ import annotations

import io
import secrets
import subprocess
import uuid
import zipfile
from collections.abc import AsyncIterator, Iterator
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

from app.api import contracts as contracts_api
from app.api import requests as requests_api
from app.core.database import Base, get_db
from app.main import app
from app.models import (
    AgreementTemplate,
    AgreementTemplateArtifact,
    AgreementTemplateMarkdownSnapshot,
    AgreementTemplateVariable,
    ApprovalPolicy,
    ApprovalStep,
    ApprovalWorkflowRun,
    ApprovalWorkflowTemplate,
    ApprovalWorkflowTemplateStep,
    Contract,
    ContractArtifact,
    ContractMarkdownSnapshot,
    ContractRequest,
    InboxItem,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent
from app.security.encryption import create_org_master_key
from app.services.document_markdown import MarkdownConversionResult
from app.services.storage import StoredDocument

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)
_PDF_MIME = "application/pdf"
_PDF_BYTES = b"%PDF-1.4\n%fake pdf body\n%%EOF\n"


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
            ContractArtifact.__table__,
            ContractMarkdownSnapshot.__table__,
            AgreementTemplate.__table__,
            AgreementTemplateArtifact.__table__,
            AgreementTemplateMarkdownSnapshot.__table__,
            AgreementTemplateVariable.__table__,
            ContractRequest.__table__,
            InboxItem.__table__,
            ApprovalWorkflowTemplate.__table__,
            ApprovalWorkflowTemplateStep.__table__,
            ApprovalWorkflowRun.__table__,
            ApprovalStep.__table__,
            ApprovalPolicy.__table__,
        ]
    else:
        engine = create_async_engine(_container_async_url(postgres_container), echo=False)
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


def _wrapped_org_key(org_id: uuid.UUID) -> bytes:
    return create_org_master_key(
        organization_id=str(org_id),
        instance_key=_INSTANCE_KEY,
    ).to_bytes()


async def _create_user_org(session: AsyncSession, *, email: str | None = None) -> tuple[Organization, User]:
    org = Organization(
        id=uuid.uuid4(),
        name=f"Org {uuid.uuid4()}",
        wrapped_master_key=_wrapped_org_key(uuid.uuid4()),
    )
    org.wrapped_master_key = _wrapped_org_key(org.id)
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=email or f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Test User",
        is_active=True,
    )
    session.add_all([org, user])
    await session.commit()
    return org, user


def _headers(user: User | uuid.UUID) -> dict[str, str]:
    user_id = user.id if isinstance(user, User) else user
    return {"X-Whereas-Dev-User": str(user_id)}


class FakeStorage:
    _blobs: dict[str, bytes] = {}

    def __init__(self, _settings: Any) -> None:
        pass

    @classmethod
    def reset(cls) -> None:
        cls._blobs.clear()

    async def store_encrypted(
        self,
        *,
        plaintext_bytes: bytes,
        document_id: str,
        org_master_key: bytes,
    ) -> StoredDocument:
        s3_key = f"documents/{document_id}.enc"
        FakeStorage._blobs[s3_key] = plaintext_bytes
        return StoredDocument(
            s3_key=s3_key,
            wrapped_dek_bytes=b"wrapped-dek-" + document_id.encode()[:16],
            encrypted_blob_sha256="a" * 64,
            size_bytes=len(plaintext_bytes),
        )

    async def retrieve_decrypted(
        self,
        *,
        s3_key: str,
        document_id: str,
        wrapped_dek_bytes: bytes,
        org_master_key: bytes,
        expected_blob_sha256: str | None = None,
    ) -> bytes:
        return FakeStorage._blobs[s3_key]


class _StubParsed:
    full_text = "Sample contract body."
    page_count = 1


@pytest.fixture
async def client(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[httpx.AsyncClient]:
    monkeypatch.setenv("WHEREAS_INSTANCE_KEY", _INSTANCE_KEY.hex())
    FakeStorage.reset()

    async def override_get_db() -> AsyncIterator[AsyncSession]:
        try:
            yield db_session
            await db_session.commit()
        except Exception:
            await db_session.rollback()
            raise

    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(contracts_api, "DocumentStorage", FakeStorage)
    monkeypatch.setattr(requests_api, "DocumentStorage", FakeStorage)
    monkeypatch.setattr(
        contracts_api,
        "parse_document",
        lambda file_bytes, filename: _StubParsed(),
    )

    def _ok_convert(**_kwargs: Any) -> MarkdownConversionResult:
        return MarkdownConversionResult(
            status="ready",
            markdown_text="# Body",
            converter_name="fake",
            converter_version="0.0.1",
            warnings=[],
        )

    from app.services import document_markdown

    monkeypatch.setattr(
        document_markdown, "convert_document_to_markdown", _ok_convert
    )

    # Skip the LLM extraction call wired into /api/contracts/upload —
    # this PR's tests don't need it and the unstubbed version makes
    # a network call.
    async def _no_extract(session: AsyncSession, *, contract: Contract, actor_user_id: Any = None) -> list[Any]:
        return []

    monkeypatch.setattr(contracts_api, "extract_and_persist_metadata", _no_extract)
    # Same posture for clause segmentation.
    async def _no_segment(_session: AsyncSession, _contract: Contract) -> list[Any]:
        return []

    monkeypatch.setattr(contracts_api, "segment_and_persist_clauses", _no_segment)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


def _docx_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<?xml version=\"1.0\"?><Types/>")
        zf.writestr("word/document.xml", "<?xml version=\"1.0\"?><document/>")
    return buf.getvalue()


async def _upload_contract(
    client: httpx.AsyncClient,
    user: User,
    *,
    title: str = "Mutual NDA Acme",
    filename: str = "Mutual_NDA_Acme.pdf",
    content: bytes | None = None,
    mime: str = _PDF_MIME,
) -> dict[str, Any]:
    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user),
        data={"title": title},
        files={"file": (filename, content or _PDF_BYTES, mime)},
    )
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_get_metadata_returns_current_title_and_artifact_fields(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user, title="NDA Acme")
    contract_id = contract["id"]

    # Seed the artifact metadata_json so we have non-title fields to
    # round-trip.
    contract_uuid = uuid.UUID(contract_id)
    artifact_row = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_uuid
            )
        )
    ).scalars().first()
    assert artifact_row is not None
    artifact_row.metadata_json = {
        "counterparty_name": "Acme Inc.",
        "contract_type": "NDA",
        "effective_date": "2026-05-01",
    }
    await db_session.commit()

    response = await client.get(
        f"/api/contracts/{contract_id}/metadata",
        headers=_headers(user),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["contract_id"] == contract_id
    assert body["title"] == "NDA Acme"
    assert body["counterparty_name"] == "Acme Inc."
    assert body["contract_type"] == "NDA"
    assert body["effective_date"] == "2026-05-01"
    assert body["changed_fields"] == []


async def test_patch_updates_title_and_returns_changed_fields(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user, title="Original Title")
    response = await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={"title": "Confirmed Title"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["title"] == "Confirmed Title"
    assert body["changed_fields"] == ["title"]

    # Verify in DB that the title persisted.
    row = (
        await db_session.execute(
            select(Contract).where(Contract.id == uuid.UUID(contract["id"]))
        )
    ).scalar_one()
    assert row.title == "Confirmed Title"


async def test_patch_persists_counterparty_contract_type_and_effective_date_on_artifact(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user)
    response = await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={
            "counterparty_name": "Acme Inc.",
            "contract_type": "NDA",
            "effective_date": "2026-05-01",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["counterparty_name"] == "Acme Inc."
    assert body["contract_type"] == "NDA"
    assert body["effective_date"] == "2026-05-01"
    assert sorted(body["changed_fields"]) == sorted(
        ["counterparty_name", "contract_type", "effective_date"]
    )

    # Reflected on the original_upload artifact row.
    contract_uuid = uuid.UUID(contract["id"])
    artifact = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_uuid,
                ContractArtifact.artifact_type == "original_upload",
            )
        )
    ).scalars().first()
    assert artifact is not None
    assert artifact.metadata_json["counterparty_name"] == "Acme Inc."
    assert artifact.metadata_json["contract_type"] == "NDA"
    assert artifact.metadata_json["effective_date"] == "2026-05-01"


async def test_patch_empty_strings_clear_fields(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """Empty strings normalize to null for the non-title fields."""
    _org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user)
    # Set values first.
    await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={
            "counterparty_name": "Acme Inc.",
            "contract_type": "NDA",
        },
    )
    # Now clear them with empty strings.
    response = await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={
            "counterparty_name": "",
            "contract_type": "",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["counterparty_name"] is None
    assert body["contract_type"] is None
    assert sorted(body["changed_fields"]) == sorted(
        ["counterparty_name", "contract_type"]
    )


async def test_patch_explicit_null_clears_effective_date(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user)
    await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={"effective_date": "2026-05-01"},
    )
    response = await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={"effective_date": None},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["effective_date"] is None
    assert body["changed_fields"] == ["effective_date"]


async def test_patch_no_changes_emits_no_audit_event(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """Patching the same value twice should not flood the audit log."""
    org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user, title="Stable Title")
    # Same value as already stored — no diff.
    response = await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={"title": "Stable Title"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["changed_fields"] == []

    events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.organization_id == org.id,
                AuditEvent.event_type == "contract.metadata.updated",
            )
        )
    ).scalars().all()
    assert events == []


async def test_patch_emits_audit_event_with_changed_fields_only(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user, title="Original")
    response = await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={
            "title": "Confirmed",
            "counterparty_name": "Acme Inc.",
        },
    )
    assert response.status_code == 200, response.text

    events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.organization_id == org.id,
                AuditEvent.event_type == "contract.metadata.updated",
            )
        )
    ).scalars().all()
    assert len(events) == 1
    details = events[0].details
    assert details["contract_id"] == contract["id"]
    assert sorted(details["changed_fields"]) == sorted(
        ["title", "counterparty_name"]
    )
    # No old/new values — the audit row carries only field names.
    assert "old_title" not in details
    assert "new_title" not in details
    assert "Confirmed" not in str(details)
    assert "Acme Inc." not in str(details)
    # Storage internals never reach the audit row.
    assert "storage_key" not in str(details)
    assert "wrapped_dek" not in str(details)


async def test_patch_cross_org_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _org_a, user_a = await _create_user_org(db_session, email="a@example.com")
    _org_b, user_b = await _create_user_org(db_session, email="b@example.com")
    contract = await _upload_contract(client, user_a)

    response = await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user_b),
        json={"title": "Hijack attempt"},
    )
    assert response.status_code == 404


async def test_patch_response_does_not_leak_storage_internals(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user)
    response = await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={"title": "X"},
    )
    assert response.status_code == 200
    text = response.text
    assert "storage_key" not in text
    assert "wrapped_dek" not in text
    assert "s3_key" not in text


async def test_patch_does_not_mutate_other_artifacts(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """Patching contract metadata must only touch the original_upload
    artifact's metadata_json. Other artifact rows (e.g. a signed_pdf
    from DocuSeal) stay untouched.
    """
    org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user)
    contract_uuid = uuid.UUID(contract["id"])

    # Seed an unrelated artifact row so we can check it stays put.
    signed = ContractArtifact(
        organization_id=org.id,
        contract_id=contract_uuid,
        artifact_type="signed_pdf",
        storage_backend="s3",
        storage_key="documents/signed.enc",
        filename="signed.pdf",
        mime_type=_PDF_MIME,
        file_hash_sha256="b" * 64,
        size_bytes=100,
        source="docuseal",
        is_official=True,
        created_by=user.id,
        metadata_json={"source_doc": "preserve_me"},
    )
    db_session.add(signed)
    await db_session.commit()
    await db_session.refresh(signed)
    signed_id = signed.id

    await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={"counterparty_name": "Acme Inc."},
    )

    fresh = (
        await db_session.execute(
            select(ContractArtifact).where(ContractArtifact.id == signed_id)
        )
    ).scalar_one()
    assert fresh.metadata_json == {"source_doc": "preserve_me"}
    assert fresh.artifact_type == "signed_pdf"


async def test_patch_does_not_change_contract_status_or_storage_pointer(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user, title="Original")
    contract_uuid = uuid.UUID(contract["id"])

    before = (
        await db_session.execute(
            select(Contract).where(Contract.id == contract_uuid)
        )
    ).scalar_one()
    before_status = before.status
    before_s3 = before.s3_key
    before_dek = before.wrapped_dek

    await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={"title": "Updated"},
    )

    after = (
        await db_session.execute(
            select(Contract).where(Contract.id == contract_uuid)
        )
    ).scalar_one()
    assert after.status == before_status
    assert after.s3_key == before_s3
    assert after.wrapped_dek == before_dek


async def test_get_metadata_cross_org_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _org_a, user_a = await _create_user_org(db_session, email="a@example.com")
    _org_b, user_b = await _create_user_org(db_session, email="b@example.com")
    contract = await _upload_contract(client, user_a)
    response = await client.get(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user_b),
    )
    assert response.status_code == 404


async def test_patch_unknown_field_returns_422(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """extra='forbid' — unknown payload fields are 422, not silently dropped."""
    _org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user)
    response = await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={
            "title": "Ok",
            "wrapped_dek": "leak",  # not a valid field
        },
    )
    assert response.status_code == 422


async def test_patch_title_too_long_returns_422(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    _org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user)
    response = await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={"title": "x" * 1000},
    )
    assert response.status_code == 422


async def test_patch_only_writes_to_latest_original_upload_artifact(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """When multiple original_upload artifacts exist (rare backfill), the
    patch should target the newest one so the response reflects what
    the user just edited.
    """
    org, user = await _create_user_org(db_session)
    contract = await _upload_contract(client, user)
    contract_uuid = uuid.UUID(contract["id"])

    # Insert an older original_upload artifact so we can verify the
    # patch targets the newest one (which the upload route already
    # created).
    older = ContractArtifact(
        organization_id=org.id,
        contract_id=contract_uuid,
        artifact_type="original_upload",
        storage_backend="s3",
        storage_key="documents/older.enc",
        filename="older.pdf",
        mime_type=_PDF_MIME,
        file_hash_sha256="c" * 64,
        size_bytes=10,
        source="user_upload",
        is_official=True,
        created_by=user.id,
        metadata_json={"counterparty_name": "old value"},
    )
    db_session.add(older)
    await db_session.commit()
    older_id = older.id

    await client.patch(
        f"/api/contracts/{contract['id']}/metadata",
        headers=_headers(user),
        json={"counterparty_name": "Updated Acme"},
    )

    # The older artifact's metadata_json is untouched.
    fresh = (
        await db_session.execute(
            select(ContractArtifact).where(ContractArtifact.id == older_id)
        )
    ).scalar_one()
    assert fresh.metadata_json == {"counterparty_name": "old value"}
