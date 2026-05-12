"""API tests for the agreement template routes."""
from __future__ import annotations

import secrets
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
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

from app.api import agreement_templates as agreement_templates_api  # noqa: E402
from app.core.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    AgreementTemplate,
    AgreementTemplateArtifact,
    AgreementTemplateMarkdownSnapshot,
    AgreementTemplateVariable,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent, AuditEventType  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402
from app.services.document_markdown import MarkdownConversionResult  # noqa: E402
from app.services.storage import StoredDocument  # noqa: E402

_PG_IMAGE = "pgvector/pgvector:pg16"
_PDF_BYTES = b"%PDF-1.7\n% Whereas synthetic test PDF\n"
_INSTANCE_KEY = secrets.token_bytes(32)


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
            AgreementTemplate.__table__,
            AgreementTemplateArtifact.__table__,
            AgreementTemplateMarkdownSnapshot.__table__,
            AgreementTemplateVariable.__table__,
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


@pytest.fixture
async def client(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[httpx.AsyncClient]:
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


async def _create_user_org(
    session: AsyncSession,
    *,
    email: str | None = None,
) -> UserOrg:
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
    return UserOrg(org=org, user=user)


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


def _file_tuple(
    name: str = "nda.pdf",
    content: bytes = _PDF_BYTES,
    mime: str = "application/pdf",
) -> dict[str, tuple[str, bytes, str]]:
    return {"file": (name, content, mime)}


class FakeStorage:
    """Captures store_encrypted calls without doing real S3 work."""

    # ``stored_blobs`` lets ``retrieve_decrypted`` return the exact
    # bytes that were uploaded (PR #103 — download endpoint tests).
    stored_blobs: dict[str, bytes] = {}
    retrieve_calls: list[dict[str, Any]] = []

    def __init__(self, _settings: Any) -> None:
        self.__class__.stored_blobs = getattr(
            self.__class__, "stored_blobs", {}
        )
        self.__class__.retrieve_calls = getattr(
            self.__class__, "retrieve_calls", []
        )

    async def store_encrypted(
        self,
        *,
        plaintext_bytes: bytes,
        document_id: str,
        org_master_key: bytes,
    ) -> StoredDocument:
        s3_key = f"templates/{document_id}.enc"
        self.__class__.stored_blobs[s3_key] = plaintext_bytes
        return StoredDocument(
            s3_key=s3_key,
            wrapped_dek_bytes=b"wrapped-dek",
            encrypted_blob_sha256="a" * 64,
            size_bytes=len(plaintext_bytes) + 28,
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
        self.__class__.retrieve_calls.append(
            {
                "s3_key": s3_key,
                "document_id": document_id,
                "wrapped_dek_bytes": wrapped_dek_bytes,
            }
        )
        return self.__class__.stored_blobs.get(s3_key, b"")


@pytest.fixture(autouse=True)
def patch_heavy_seams(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(agreement_templates_api, "DocumentStorage", FakeStorage)

    # Default to a successful conversion. Tests that exercise the failure
    # path override this fixture-level patch with their own monkeypatch.
    def _ok_convert(
        *, file_bytes: bytes, mime_type: str, filename: str | None, fallback_plain_text: str | None
    ) -> MarkdownConversionResult:
        return MarkdownConversionResult(
            status="ready",
            markdown_text="# Template\n\nbody",
            converter_name="fake",
            converter_version="0.0.1",
            warnings=[],
        )

    monkeypatch.setattr(
        agreement_templates_api, "convert_document_to_markdown", _ok_convert
    )

    # The parser is best-effort and only used as a fallback text source.
    # Stub it so tests don't need a real PDF/DOCX parser.
    class _StubParsed:
        full_text = "Template plain text fallback"

    monkeypatch.setattr(
        agreement_templates_api,
        "parse_document",
        lambda file_bytes, filename: _StubParsed(),
    )


# ---------------------------------------------------------------------------
# Template CRUD
# ---------------------------------------------------------------------------


async def test_create_and_get_template(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)

    response = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "Mutual NDA", "template_type": "NDA", "description": "Standard NDA"},
    )
    assert response.status_code == 201
    payload = response.json()
    assert payload["name"] == "Mutual NDA"
    assert payload["template_type"] == "NDA"
    assert payload["status"] == "active"
    template_id = payload["id"]

    got = await client.get(
        f"/api/agreement-templates/{template_id}",
        headers=_headers(user_org.user),
    )
    assert got.status_code == 200
    assert got.json()["id"] == template_id


async def test_list_templates_excludes_archived_by_default(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    active = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "Active"},
    )
    archived = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "To archive"},
    )
    archived_id = archived.json()["id"]

    delete = await client.delete(
        f"/api/agreement-templates/{archived_id}",
        headers=_headers(user_org.user),
    )
    assert delete.status_code == 204

    listed = await client.get(
        "/api/agreement-templates", headers=_headers(user_org.user)
    )
    ids = [r["id"] for r in listed.json()]
    assert active.json()["id"] in ids
    assert archived_id not in ids

    listed_all = await client.get(
        "/api/agreement-templates?include_archived=true",
        headers=_headers(user_org.user),
    )
    ids_all = {r["id"] for r in listed_all.json()}
    assert archived_id in ids_all


async def test_patch_template_updates_fields(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "Old", "template_type": "NDA"},
    )
    template_id = created.json()["id"]

    patched = await client.patch(
        f"/api/agreement-templates/{template_id}",
        headers=_headers(user_org.user),
        json={"name": "New", "template_type": "MSA", "description": "updated"},
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["name"] == "New"
    assert body["template_type"] == "MSA"
    assert body["description"] == "updated"


async def test_patch_template_rejects_invalid_status(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "Status check"},
    )
    template_id = created.json()["id"]

    response = await client.patch(
        f"/api/agreement-templates/{template_id}",
        headers=_headers(user_org.user),
        json={"status": "deleted"},
    )
    assert response.status_code == 422


async def test_cross_org_template_access_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")

    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(org_a.user),
        json={"name": "Org A only"},
    )
    template_id = created.json()["id"]

    response = await client.get(
        f"/api/agreement-templates/{template_id}",
        headers=_headers(org_b.user),
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Upload / artifacts / markdown
# ---------------------------------------------------------------------------


async def test_upload_creates_artifact_and_markdown_snapshot(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "NDA"},
    )
    template_id = uuid.UUID(created.json()["id"])

    upload = await client.post(
        f"/api/agreement-templates/{template_id}/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    assert upload.status_code == 201, upload.text
    artifact = upload.json()
    assert artifact["artifact_type"] == "original_upload"
    assert artifact["is_official"] is True
    assert artifact["source"] == "user_upload"
    assert artifact["filename"] == "nda.pdf"
    assert artifact["mime_type"] == "application/pdf"
    assert "storage_key" not in artifact

    rows = (
        await db_session.execute(
            select(AgreementTemplateArtifact).where(
                AgreementTemplateArtifact.template_id == template_id
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].storage_key.startswith("templates/template-")

    snaps = (
        await db_session.execute(
            select(AgreementTemplateMarkdownSnapshot).where(
                AgreementTemplateMarkdownSnapshot.template_id == template_id
            )
        )
    ).scalars().all()
    assert len(snaps) == 1
    assert snaps[0].conversion_status == "ready"


async def test_upload_succeeds_when_conversion_fails(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "MSA"},
    )
    template_id = uuid.UUID(created.json()["id"])

    def _fail_convert(**_kwargs: Any) -> MarkdownConversionResult:
        return MarkdownConversionResult(
            status="failed",
            markdown_text="",
            converter_name="none",
            converter_version=None,
            warnings=["nope"],
        )

    monkeypatch.setattr(
        agreement_templates_api, "convert_document_to_markdown", _fail_convert
    )

    response = await client.post(
        f"/api/agreement-templates/{template_id}/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    assert response.status_code == 201

    snaps = (
        await db_session.execute(
            select(AgreementTemplateMarkdownSnapshot).where(
                AgreementTemplateMarkdownSnapshot.template_id == template_id
            )
        )
    ).scalars().all()
    assert snaps == []

    artifacts = (
        await db_session.execute(
            select(AgreementTemplateArtifact).where(
                AgreementTemplateArtifact.template_id == template_id
            )
        )
    ).scalars().all()
    assert len(artifacts) == 1


async def test_get_markdown_returns_latest_ready_snapshot(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "NDA"},
    )
    template_id = uuid.UUID(created.json()["id"])

    upload = await client.post(
        f"/api/agreement-templates/{template_id}/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    assert upload.status_code == 201

    response = await client.get(
        f"/api/agreement-templates/{template_id}/markdown",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    assert response.json()["markdown_text"] == "# Template\n\nbody"


async def test_get_markdown_404_when_no_ready_snapshot(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "NDA"},
    )
    template_id = created.json()["id"]

    response = await client.get(
        f"/api/agreement-templates/{template_id}/markdown",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 404


async def test_artifacts_listing_does_not_expose_storage_key(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "NDA"},
    )
    template_id = created.json()["id"]
    await client.post(
        f"/api/agreement-templates/{template_id}/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )

    response = await client.get(
        f"/api/agreement-templates/{template_id}/artifacts",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1
    assert "storage_key" not in rows[0]
    assert "storage_key" not in response.text


# ---------------------------------------------------------------------------
# PR #103 — per-version download of AgreementTemplateArtifact
# ---------------------------------------------------------------------------


async def _make_template_with_upload(
    client: httpx.AsyncClient, user_org: UserOrg, *, content: bytes
) -> tuple[str, str]:
    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(user_org.user),
        json={"name": "NDA"},
    )
    template_id = created.json()["id"]
    upload = await client.post(
        f"/api/agreement-templates/{template_id}/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(content=content),
    )
    assert upload.status_code == 201, upload.text
    return template_id, upload.json()["id"]


async def test_download_artifact_returns_bytes_and_audits(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    body = b"%PDF-1.4\nTEMPLATE-CONTENTS-A"
    template_id, artifact_id = await _make_template_with_upload(
        client, user_org, content=body
    )

    response = await client.get(
        f"/api/agreement-templates/{template_id}/artifacts/{artifact_id}/download",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200, response.text
    assert response.content == body
    assert response.headers["content-type"].startswith("application/pdf")
    assert "attachment;" in response.headers["content-disposition"]

    # Audit event is emitted with allowlisted details only.
    audit_events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.event_type
                == AuditEventType.AGREEMENT_TEMPLATE_ARTIFACT_DOWNLOADED.value
            )
        )
    ).scalars().all()
    assert len(audit_events) == 1
    details = audit_events[0].details
    assert details["agreement_template_id"] == template_id
    assert details["artifact_id"] == artifact_id
    assert details["artifact_type"] == "original_upload"
    assert details["mime_type"] == "application/pdf"
    assert "filename" in details
    text_blob = str(details)
    for forbidden in (
        "storage_key",
        "wrapped_dek",
        "s3_key",
        "private_url",
        "presigned",
        "variable",
    ):
        assert forbidden not in text_blob
    assert body.hex() not in text_blob


async def test_download_artifact_cross_org_template_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(
        db_session, email="dl-cross-tmpl-a@example.com"
    )
    org_b = await _create_user_org(
        db_session, email="dl-cross-tmpl-b@example.com"
    )
    template_id, artifact_id = await _make_template_with_upload(
        client, org_a, content=b"%PDF-1.4\nA",
    )
    response = await client.get(
        f"/api/agreement-templates/{template_id}/artifacts/{artifact_id}/download",
        headers=_headers(org_b.user),
    )
    assert response.status_code == 404


async def test_download_artifact_cross_org_artifact_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A second org's artifact id passed against the first org's template
    must return 404 (same opaque shape as a missing artifact)."""
    org_a = await _create_user_org(db_session, email="dl-x-art-a@example.com")
    org_b = await _create_user_org(db_session, email="dl-x-art-b@example.com")
    template_a_id, _ = await _make_template_with_upload(
        client, org_a, content=b"%PDF-1.4\nA",
    )
    _, artifact_b_id = await _make_template_with_upload(
        client, org_b, content=b"%PDF-1.4\nB",
    )
    response = await client.get(
        f"/api/agreement-templates/{template_a_id}/artifacts/{artifact_b_id}/download",
        headers=_headers(org_a.user),
    )
    assert response.status_code == 404


async def test_download_artifact_from_different_template_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    _, artifact_a_id = await _make_template_with_upload(
        client, user_org, content=b"%PDF-1.4\nA",
    )
    template_b_id, _ = await _make_template_with_upload(
        client, user_org, content=b"%PDF-1.4\nB",
    )
    response = await client.get(
        f"/api/agreement-templates/{template_b_id}/artifacts/{artifact_a_id}/download",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 404


async def test_download_artifact_missing_artifact_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id, _ = await _make_template_with_upload(
        client, user_org, content=b"%PDF-1.4\nA",
    )
    bogus = "00000000-0000-4000-8000-000000000000"
    response = await client.get(
        f"/api/agreement-templates/{template_id}/artifacts/{bogus}/download",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 404


async def test_download_artifact_missing_storage_returns_409(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id, artifact_id = await _make_template_with_upload(
        client, user_org, content=b"%PDF-1.4\nA",
    )
    # Wipe storage_key on the row to simulate a stuck/failed upload.
    artifact = await db_session.get(
        AgreementTemplateArtifact, uuid.UUID(artifact_id)
    )
    assert artifact is not None
    artifact.storage_key = None
    await db_session.commit()
    response = await client.get(
        f"/api/agreement-templates/{template_id}/artifacts/{artifact_id}/download",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 409


async def test_download_artifact_response_does_not_expose_storage_internals(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id, artifact_id = await _make_template_with_upload(
        client, user_org, content=b"%PDF-1.4\nA",
    )
    response = await client.get(
        f"/api/agreement-templates/{template_id}/artifacts/{artifact_id}/download",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    # Body is raw bytes — JSON shape entirely absent.
    headers_text = " ".join(f"{k}: {v}" for k, v in response.headers.items())
    for forbidden in (
        "storage_key",
        "wrapped_dek",
        "s3_key",
        "private_url",
        "presigned",
        "metadata_json",
    ):
        assert forbidden not in headers_text


# ---------------------------------------------------------------------------
# Variables CRUD
# ---------------------------------------------------------------------------


async def _create_template(client: httpx.AsyncClient, user: User) -> str:
    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(user),
        json={"name": "Variables host"},
    )
    return created.json()["id"]


async def test_variables_crud(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id = await _create_template(client, user_org.user)

    create = await client.post(
        f"/api/agreement-templates/{template_id}/variables",
        headers=_headers(user_org.user),
        json={
            "key": "counterparty_name",
            "label": "Counterparty Name",
            "variable_type": "text",
            "required": True,
            "sort_order": 1,
        },
    )
    assert create.status_code == 201
    var_id = create.json()["id"]

    listed = await client.get(
        f"/api/agreement-templates/{template_id}/variables",
        headers=_headers(user_org.user),
    )
    assert listed.status_code == 200
    assert [v["key"] for v in listed.json()] == ["counterparty_name"]

    patched = await client.patch(
        f"/api/agreement-templates/{template_id}/variables/{var_id}",
        headers=_headers(user_org.user),
        json={"label": "Counterparty Legal Name", "required": False},
    )
    assert patched.status_code == 200
    assert patched.json()["label"] == "Counterparty Legal Name"
    assert patched.json()["required"] is False

    deleted = await client.delete(
        f"/api/agreement-templates/{template_id}/variables/{var_id}",
        headers=_headers(user_org.user),
    )
    assert deleted.status_code == 204

    listed_after = await client.get(
        f"/api/agreement-templates/{template_id}/variables",
        headers=_headers(user_org.user),
    )
    assert listed_after.json() == []


async def test_variable_key_unique_per_template(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id = await _create_template(client, user_org.user)

    first = await client.post(
        f"/api/agreement-templates/{template_id}/variables",
        headers=_headers(user_org.user),
        json={"key": "effective_date", "label": "Effective Date", "variable_type": "date"},
    )
    assert first.status_code == 201

    duplicate = await client.post(
        f"/api/agreement-templates/{template_id}/variables",
        headers=_headers(user_org.user),
        json={"key": "effective_date", "label": "Effective Date 2", "variable_type": "date"},
    )
    assert duplicate.status_code == 409


async def test_variables_sorted_by_sort_order_then_created_at(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id = await _create_template(client, user_org.user)

    await client.post(
        f"/api/agreement-templates/{template_id}/variables",
        headers=_headers(user_org.user),
        json={"key": "second", "label": "Second", "variable_type": "text", "sort_order": 2},
    )
    await client.post(
        f"/api/agreement-templates/{template_id}/variables",
        headers=_headers(user_org.user),
        json={"key": "first", "label": "First", "variable_type": "text", "sort_order": 1},
    )
    await client.post(
        f"/api/agreement-templates/{template_id}/variables",
        headers=_headers(user_org.user),
        json={"key": "third", "label": "Third", "variable_type": "text", "sort_order": 3},
    )

    listed = await client.get(
        f"/api/agreement-templates/{template_id}/variables",
        headers=_headers(user_org.user),
    )
    assert [v["key"] for v in listed.json()] == ["first", "second", "third"]


async def test_cross_org_variable_access_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    template_id = await _create_template(client, org_a.user)

    var = await client.post(
        f"/api/agreement-templates/{template_id}/variables",
        headers=_headers(org_a.user),
        json={"key": "x", "label": "X", "variable_type": "text"},
    )
    var_id = var.json()["id"]

    response = await client.delete(
        f"/api/agreement-templates/{template_id}/variables/{var_id}",
        headers=_headers(org_b.user),
    )
    assert response.status_code == 404
