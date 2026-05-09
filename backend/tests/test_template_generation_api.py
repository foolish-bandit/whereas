"""API tests for the agreement template generation endpoint.

These exercise the end-to-end DOCX generation flow at the HTTP
boundary: variable validation, Contract + ContractArtifact creation,
markdown snapshot, error paths, and storage-key scrubbing in
responses.

Storage and the DOCX render seam are stubbed via monkeypatch so the
suite does not depend on S3 or a real DOCX template on disk; the
template bytes the service "decrypts" are the same bytes used for
rendering.
"""
from __future__ import annotations

import io
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
    Contract,
    ContractArtifact,
    ContractMarkdownSnapshot,
    ContractStatus,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402
from app.services import template_generation as tg  # noqa: E402
from app.services.document_markdown import MarkdownConversionResult  # noqa: E402
from app.services.storage import StoredDocument  # noqa: E402

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)
_DOCX_MIME = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


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


# ---------------------------------------------------------------------------
# Real DOCX fixture builder
# ---------------------------------------------------------------------------


def _build_docx_with_placeholders(text: str) -> bytes:
    """Build a minimal real DOCX containing the given paragraph text.

    docxtpl reads via python-docx, so the bytes have to be a valid
    .docx ZIP. The renderer walks runs and replaces ``{{ key }}``
    placeholders in place, so the test template's prose is what
    actually gets rendered out the other side.
    """
    from docx import Document

    doc = Document()
    for line in text.splitlines():
        doc.add_paragraph(line)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


# ---------------------------------------------------------------------------
# Storage shim
#
# The real DocumentStorage talks to S3 and runs AES-GCM. For tests we
# substitute a class that records and returns plaintext bytes keyed by
# the s3_key. Both the upload route and the generation service look up
# DocumentStorage from their own modules, so we patch both.
# ---------------------------------------------------------------------------


class FakeStorage:
    """In-memory storage that round-trips bytes by s3_key."""

    blobs: dict[str, bytes] = {}

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
            wrapped_dek_bytes=b"wrapped-dek-" + document_id.encode()[:32],
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
    ) -> bytes:
        try:
            return FakeStorage.blobs[s3_key]
        except KeyError as exc:
            raise RuntimeError(f"unknown s3 key {s3_key}") from exc


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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


@pytest.fixture(autouse=True)
def patch_seams(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub storage on both seams and stub the markdown converter.

    The markdown stub behaves differently for original-template uploads
    (always succeeds) and generated-DOCX rendering (overridable per
    test). The default for generation is "ready" so the snapshot path
    is exercised by the happy-path tests.
    """
    FakeStorage.blobs.clear()
    monkeypatch.setattr(agreement_templates_api, "DocumentStorage", FakeStorage)
    monkeypatch.setattr(tg, "DocumentStorage", FakeStorage)

    def _ok_convert_template(**_kwargs: Any) -> MarkdownConversionResult:
        return MarkdownConversionResult(
            status="ready",
            markdown_text="# Template\n\nbody",
            converter_name="fake",
            converter_version="0.0.1",
            warnings=[],
        )

    def _ok_convert_generated(**_kwargs: Any) -> MarkdownConversionResult:
        return MarkdownConversionResult(
            status="ready",
            markdown_text="# Generated\n\nfilled body",
            converter_name="fake",
            converter_version="0.0.1",
            warnings=[],
        )

    monkeypatch.setattr(
        agreement_templates_api,
        "convert_document_to_markdown",
        _ok_convert_template,
    )
    monkeypatch.setattr(tg, "convert_document_to_markdown", _ok_convert_generated)

    class _StubParsed:
        full_text = "Template plain text fallback"

    monkeypatch.setattr(
        agreement_templates_api,
        "parse_document",
        lambda file_bytes, filename: _StubParsed(),
    )


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


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


async def _create_template_with_variables(
    client: httpx.AsyncClient,
    user: User,
    *,
    variables: list[dict[str, Any]] | None = None,
    template_name: str = "Mutual NDA",
) -> str:
    created = await client.post(
        "/api/agreement-templates",
        headers=_headers(user),
        json={"name": template_name, "template_type": "NDA"},
    )
    assert created.status_code == 201, created.text
    template_id = created.json()["id"]
    for var in variables or []:
        resp = await client.post(
            f"/api/agreement-templates/{template_id}/variables",
            headers=_headers(user),
            json=var,
        )
        assert resp.status_code == 201, resp.text
    return template_id


async def _upload_docx_template(
    client: httpx.AsyncClient,
    user: User,
    template_id: str,
    *,
    body_text: str,
    filename: str = "nda.docx",
    mime_override: str | None = None,
) -> None:
    """Upload a real DOCX as the template's original artifact."""
    docx_bytes = _build_docx_with_placeholders(body_text)
    files = {
        "file": (
            filename,
            docx_bytes,
            mime_override or _DOCX_MIME,
        )
    }
    resp = await client.post(
        f"/api/agreement-templates/{template_id}/upload",
        headers=_headers(user),
        files=files,
    )
    assert resp.status_code == 201, resp.text


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


async def test_generate_creates_contract_and_generated_docx_artifact(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id = await _create_template_with_variables(
        client,
        user_org.user,
        variables=[
            {
                "key": "counterparty_name",
                "label": "Counterparty",
                "variable_type": "text",
                "required": True,
            },
            {
                "key": "effective_date",
                "label": "Effective Date",
                "variable_type": "date",
                "required": True,
            },
        ],
    )
    await _upload_docx_template(
        client,
        user_org.user,
        template_id,
        body_text=(
            "This NDA is between Whereas and {{counterparty_name}}.\n"
            "It is effective on {{effective_date}}."
        ),
    )

    response = await client.post(
        f"/api/agreement-templates/{template_id}/generate",
        headers=_headers(user_org.user),
        json={
            "title": "Acme NDA",
            "variable_values": {
                "counterparty_name": "Acme Inc.",
                "effective_date": "2026-05-08",
            },
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["contract"]["title"] == "Acme NDA"
    assert body["contract"]["status"] == ContractStatus.DRAFT.value
    assert body["artifact"]["artifact_type"] == "generated_docx"
    assert body["artifact"]["source"] == "template_generation"
    assert body["artifact"]["is_official"] is True
    assert "storage_key" not in body["artifact"]
    assert body["markdown_snapshot"] is not None
    assert body["markdown_snapshot"]["source_kind"] == "generated"

    contract_id = body["contract"]["id"]

    artifacts = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == uuid.UUID(contract_id)
            )
        )
    ).scalars().all()
    assert len(artifacts) == 1
    artifact = artifacts[0]
    assert artifact.metadata_json is not None
    assert artifact.metadata_json["template_id"] == template_id
    assert artifact.metadata_json["template_name"] == "Mutual NDA"
    assert sorted(artifact.metadata_json["variable_keys"]) == [
        "counterparty_name",
        "effective_date",
    ]


async def test_generated_docx_contains_filled_variable_values(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """Round-trip the rendered DOCX out of FakeStorage and read it.

    The generated DOCX is the legal record, so end-to-end content
    assertion guards against silent placeholder leakage.
    """
    from docx import Document

    user_org = await _create_user_org(db_session)
    template_id = await _create_template_with_variables(
        client,
        user_org.user,
        variables=[
            {
                "key": "counterparty_name",
                "label": "Counterparty",
                "variable_type": "text",
                "required": True,
            },
        ],
    )
    await _upload_docx_template(
        client,
        user_org.user,
        template_id,
        body_text="Counterparty is {{counterparty_name}}.",
    )

    response = await client.post(
        f"/api/agreement-templates/{template_id}/generate",
        headers=_headers(user_org.user),
        json={"variable_values": {"counterparty_name": "Acme Inc."}},
    )
    assert response.status_code == 201, response.text

    contract_id = response.json()["contract"]["id"]
    contract = (
        await db_session.execute(
            select(Contract).where(Contract.id == uuid.UUID(contract_id))
        )
    ).scalar_one()
    rendered_bytes = FakeStorage.blobs[contract.s3_key]
    doc = Document(io.BytesIO(rendered_bytes))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Acme Inc." in text
    assert "{{counterparty_name}}" not in text


async def test_generated_contract_gets_markdown_snapshot(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id = await _create_template_with_variables(
        client, user_org.user, variables=[]
    )
    await _upload_docx_template(
        client,
        user_org.user,
        template_id,
        body_text="No variables here.",
    )

    response = await client.post(
        f"/api/agreement-templates/{template_id}/generate",
        headers=_headers(user_org.user),
        json={"title": "Empty draft", "variable_values": {}},
    )
    assert response.status_code == 201
    contract_id = response.json()["contract"]["id"]

    snaps = (
        await db_session.execute(
            select(ContractMarkdownSnapshot).where(
                ContractMarkdownSnapshot.contract_id == uuid.UUID(contract_id)
            )
        )
    ).scalars().all()
    assert len(snaps) == 1
    assert snaps[0].source_kind == "generated"
    assert snaps[0].conversion_status == "ready"


async def test_generation_succeeds_when_markdown_conversion_fails(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_org = await _create_user_org(db_session)
    template_id = await _create_template_with_variables(
        client, user_org.user, variables=[]
    )
    await _upload_docx_template(
        client, user_org.user, template_id, body_text="Body."
    )

    def _fail_convert(**_kwargs: Any) -> MarkdownConversionResult:
        return MarkdownConversionResult(
            status="failed",
            markdown_text="",
            converter_name="none",
            converter_version=None,
            warnings=["nope"],
        )

    monkeypatch.setattr(tg, "convert_document_to_markdown", _fail_convert)

    response = await client.post(
        f"/api/agreement-templates/{template_id}/generate",
        headers=_headers(user_org.user),
        json={"variable_values": {}},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["markdown_snapshot"] is None

    contract_id = body["contract"]["id"]
    snaps = (
        await db_session.execute(
            select(ContractMarkdownSnapshot).where(
                ContractMarkdownSnapshot.contract_id == uuid.UUID(contract_id)
            )
        )
    ).scalars().all()
    assert snaps == []


# ---------------------------------------------------------------------------
# Validation errors
# ---------------------------------------------------------------------------


async def test_required_variable_missing_returns_400(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id = await _create_template_with_variables(
        client,
        user_org.user,
        variables=[
            {
                "key": "counterparty_name",
                "label": "Counterparty",
                "variable_type": "text",
                "required": True,
            }
        ],
    )
    await _upload_docx_template(
        client,
        user_org.user,
        template_id,
        body_text="Counterparty is {{counterparty_name}}.",
    )

    response = await client.post(
        f"/api/agreement-templates/{template_id}/generate",
        headers=_headers(user_org.user),
        json={"variable_values": {}},
    )
    assert response.status_code == 400
    assert "counterparty_name" in response.json()["detail"]


async def test_unknown_variable_returns_400(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id = await _create_template_with_variables(
        client,
        user_org.user,
        variables=[
            {
                "key": "counterparty_name",
                "label": "Counterparty",
                "variable_type": "text",
                "required": True,
            }
        ],
    )
    await _upload_docx_template(
        client,
        user_org.user,
        template_id,
        body_text="Counterparty is {{counterparty_name}}.",
    )

    response = await client.post(
        f"/api/agreement-templates/{template_id}/generate",
        headers=_headers(user_org.user),
        json={
            "variable_values": {
                "counterparty_name": "Acme Inc.",
                "not_a_real_variable": "boom",
            }
        },
    )
    assert response.status_code == 400
    assert "not_a_real_variable" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Source-template error paths
# ---------------------------------------------------------------------------


async def test_no_original_upload_returns_400(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id = await _create_template_with_variables(
        client, user_org.user, variables=[]
    )

    response = await client.post(
        f"/api/agreement-templates/{template_id}/generate",
        headers=_headers(user_org.user),
        json={"variable_values": {}},
    )
    assert response.status_code == 400
    assert "Upload" in response.json()["detail"]


async def test_non_docx_template_returns_400(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A PDF template is uploadable but cannot be used to generate."""
    user_org = await _create_user_org(db_session)
    template_id = await _create_template_with_variables(
        client, user_org.user, variables=[]
    )
    pdf_bytes = b"%PDF-1.7\n% Whereas synthetic test PDF\n"
    files = {"file": ("nda.pdf", pdf_bytes, "application/pdf")}
    resp = await client.post(
        f"/api/agreement-templates/{template_id}/upload",
        headers=_headers(user_org.user),
        files=files,
    )
    assert resp.status_code == 201, resp.text

    response = await client.post(
        f"/api/agreement-templates/{template_id}/generate",
        headers=_headers(user_org.user),
        json={"variable_values": {}},
    )
    assert response.status_code == 400
    assert "DOCX" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Authorization
# ---------------------------------------------------------------------------


async def test_cross_org_generation_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")

    template_id = await _create_template_with_variables(
        client, org_a.user, variables=[]
    )
    await _upload_docx_template(
        client, org_a.user, template_id, body_text="Body."
    )

    response = await client.post(
        f"/api/agreement-templates/{template_id}/generate",
        headers=_headers(org_b.user),
        json={"variable_values": {}},
    )
    assert response.status_code == 404


async def test_response_does_not_expose_storage_key(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    template_id = await _create_template_with_variables(
        client, user_org.user, variables=[]
    )
    await _upload_docx_template(
        client, user_org.user, template_id, body_text="Body."
    )

    response = await client.post(
        f"/api/agreement-templates/{template_id}/generate",
        headers=_headers(user_org.user),
        json={"variable_values": {}},
    )
    assert response.status_code == 201
    assert "storage_key" not in response.text
    assert "wrapped_dek" not in response.text
