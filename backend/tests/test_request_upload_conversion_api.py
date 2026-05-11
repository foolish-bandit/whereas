"""API tests for the request -> contract upload-conversion endpoint (PR #65).

This is the third-party / counterparty-paper intake path: a user takes
an open ContractRequest and uploads an external agreement file
(``.pdf`` / ``.docx``) instead of generating from a template. The
uploaded file becomes the Contract's ``original_upload`` artifact and
the request is linked + completed in the same transaction.

Mirrors ``test_request_conversion_api.py``'s infrastructure (in-memory
SQLite or test-containers Postgres, ``FakeStorage`` stand-in for S3,
patched markdown converter) so both intake paths exercise the same
seams. No backend behavior outside the new endpoint is changed by
PR #65, so the lifecycle / approval-gate / DocuSeal-send tests in
sibling modules continue to apply unchanged.
"""
from __future__ import annotations

import io
import secrets
import subprocess
import uuid
import zipfile
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

from app.api import requests as requests_api  # noqa: E402
from app.core.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
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
from app.security.audit_log import AuditEvent  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402
from app.services.document_markdown import MarkdownConversionResult  # noqa: E402
from app.services.storage import StoredDocument  # noqa: E402

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)
_PDF_MIME = "application/pdf"
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
        return sync_url.replace(
            "postgresql+psycopg2://", "postgresql+asyncpg://", 1
        )
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
        engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:", echo=False
        )
        # Same minimal table set the sibling conversion test uses.
        # Includes the approval-policy tables because creating /
        # updating a request runs the policy matcher.
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


def _headers(user: User | uuid.UUID) -> dict[str, str]:
    user_id = user.id if isinstance(user, User) else user
    return {"X-Whereas-Dev-User": str(user_id)}


# A minimal valid PDF body — the contract upload validator checks for
# the ``%PDF-`` magic prefix and then hands bytes to ``parse_document``
# which is monkey-patched below. Keeping this short keeps the test
# focused on the API contract rather than PDF parser internals.
_PDF_BYTES = b"%PDF-1.4\n%fake test pdf body\n%%EOF\n"


def _minimal_docx_bytes() -> bytes:
    """A skeleton DOCX that satisfies ``_looks_like_docx``.

    A real .docx is a ZIP archive containing at least ``[Content_Types].xml``
    and ``word/document.xml``. We build the smallest possible one that
    passes the upload validator's structural check; the content is
    irrelevant because the parser is monkey-patched.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "[Content_Types].xml",
            "<?xml version=\"1.0\"?><Types/>",
        )
        zf.writestr(
            "word/document.xml",
            "<?xml version=\"1.0\"?><document/>",
        )
    return buf.getvalue()


_DOCX_BYTES = _minimal_docx_bytes()


class FakeStorage:
    """In-memory ``DocumentStorage`` stub. Same fake the sibling
    conversion test uses, kept duplicated here so the two test files
    can run independently.
    """

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
    """Drop-in replacement for ``ParsedDocument`` so the route's
    ``_parse_or_http`` call doesn't depend on a real PDF/DOCX parser.

    The conversion path only reads ``full_text`` (for the optional
    markdown fallback) and ``page_count`` (for the Contract row), so a
    minimal stub is enough.
    """

    full_text = "Counterparty paper sample text."
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

    monkeypatch.setattr(requests_api, "DocumentStorage", FakeStorage)

    # Patch ``parse_document`` at the contracts module — the requests
    # router calls ``_parse_or_http`` which lives there and reads the
    # patched name at call time. Also patch ``DocumentStorage`` on the
    # contracts module so the download round-trip in
    # ``test_uploaded_contract_is_downloadable_via_contracts_endpoint``
    # reads back from the same in-memory blob store the conversion
    # wrote to.
    from app.api import contracts as contracts_api

    monkeypatch.setattr(
        contracts_api,
        "parse_document",
        lambda file_bytes, filename: _StubParsed(),
    )
    monkeypatch.setattr(contracts_api, "DocumentStorage", FakeStorage)

    # Successful markdown conversion by default; individual tests can
    # override this to exercise the failure branch.
    def _ok_convert(
        *,
        file_bytes: bytes,
        mime_type: str,
        filename: str | None,
        fallback_plain_text: str | None,
    ) -> MarkdownConversionResult:
        return MarkdownConversionResult(
            status="ready",
            markdown_text="# Converted\n\nbody",
            converter_name="fake",
            converter_version="0.0.1",
            warnings=[],
        )

    from app.services import document_markdown

    monkeypatch.setattr(
        document_markdown, "convert_document_to_markdown", _ok_convert
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as c:
        yield c
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_request(
    client: httpx.AsyncClient,
    user: User,
    *,
    title: str = "NDA with Acme",
    counterparty_name: str | None = None,
    contract_type: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"title": title}
    if counterparty_name is not None:
        payload["counterparty_name"] = counterparty_name
    if contract_type is not None:
        payload["contract_type"] = contract_type
    response = await client.post(
        "/api/requests",
        headers=_headers(user),
        json=payload,
    )
    assert response.status_code == 201, response.text
    return response.json()


def _pdf_files(name: str = "counterparty.pdf") -> dict[str, Any]:
    return {"file": (name, _PDF_BYTES, _PDF_MIME)}


def _docx_files(name: str = "counterparty.docx") -> dict[str, Any]:
    return {"file": (name, _DOCX_BYTES, _DOCX_MIME)}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_convert_upload_creates_contract_and_links_back(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(
        client,
        user_org.user,
        counterparty_name="Acme Inc.",
        contract_type="NDA",
    )

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files(),
        data={
            "title": "Acme NDA — countersigned",
            "counterparty_name": "Acme Inc.",
            "contract_type": "NDA",
            "notes": "Received via email 2026-05-10.",
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()

    # Contract was created from the upload.
    assert body["contract"]["title"] == "Acme NDA — countersigned"
    assert body["contract"]["mime_type"] == _PDF_MIME
    assert body["contract"]["status"] == "ready"

    # original_upload artifact carries request_upload metadata.
    artifact = body["artifact"]
    assert artifact["artifact_type"] == "original_upload"
    assert artifact["source"] == "request_upload"
    assert artifact["is_official"] is True
    assert artifact["filename"] == "counterparty.pdf"
    assert artifact["mime_type"] == _PDF_MIME
    assert artifact["size_bytes"] == len(_PDF_BYTES)
    assert artifact["metadata_json"]["request_id"] == request_row["id"]
    assert (
        artifact["metadata_json"]["upload_source"] == "request_conversion"
    )
    assert artifact["metadata_json"]["counterparty_name"] == "Acme Inc."
    assert artifact["metadata_json"]["contract_type"] == "NDA"
    assert (
        artifact["metadata_json"]["notes"]
        == "Received via email 2026-05-10."
    )

    # Request was linked + completed and the inbox row was resolved,
    # all in the same transaction.
    assert body["request"]["status"] == "completed"
    assert body["request"]["linked_contract_id"] == body["contract"]["id"]

    request_id = uuid.UUID(request_row["id"])
    request = (
        await db_session.execute(
            select(ContractRequest).where(ContractRequest.id == request_id)
        )
    ).scalar_one()
    assert request.status == "completed"
    assert str(request.linked_contract_id) == body["contract"]["id"]

    inbox_items = (
        await db_session.execute(
            select(InboxItem).where(InboxItem.request_id == request_id)
        )
    ).scalars().all()
    assert len(inbox_items) == 1
    assert inbox_items[0].status == "completed"
    assert inbox_items[0].item_type == "request_review"


async def test_convert_upload_persists_original_artifact_row(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_docx_files(),
    )
    assert response.status_code == 201, response.text
    contract_id = uuid.UUID(response.json()["contract"]["id"])

    artifacts = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id
            )
        )
    ).scalars().all()
    assert len(artifacts) == 1
    artifact = artifacts[0]
    assert artifact.artifact_type == "original_upload"
    assert artifact.source == "request_upload"
    assert artifact.metadata_json["request_id"] == request_row["id"]
    assert artifact.metadata_json["upload_source"] == "request_conversion"


async def test_convert_upload_creates_markdown_snapshot(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files(),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["markdown_snapshot"] is not None
    assert body["markdown_snapshot"]["conversion_status"] == "ready"
    assert (
        body["markdown_snapshot"]["source_kind"] == "original_upload"
    )


async def test_convert_upload_markdown_failure_is_non_fatal(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A markdown conversion failure must NOT fail the conversion."""

    def _fail_convert(
        *,
        file_bytes: bytes,
        mime_type: str,
        filename: str | None,
        fallback_plain_text: str | None,
    ) -> MarkdownConversionResult:
        return MarkdownConversionResult(
            status="failed",
            markdown_text="",
            converter_name="fake",
            converter_version=None,
            warnings=["fake_failure"],
        )

    from app.services import document_markdown

    monkeypatch.setattr(
        document_markdown, "convert_document_to_markdown", _fail_convert
    )

    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files(),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["markdown_snapshot"] is None
    # The Contract + artifact still got created.
    assert body["contract"]["id"] is not None
    assert body["artifact"]["artifact_type"] == "original_upload"
    # And the request still flipped to completed.
    assert body["request"]["status"] == "completed"


async def test_convert_upload_cancelled_request_returns_409(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    user_id = user_org.user.id
    request_row = await _create_request(client, user_org.user)

    cancel = await client.delete(
        f"/api/requests/{request_row['id']}",
        headers=_headers(user_id),
    )
    assert cancel.status_code == 204

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_id),
        files=_pdf_files(),
    )
    assert response.status_code == 409
    assert "cancelled" in response.json()["detail"].lower()


async def test_convert_upload_already_converted_request_returns_409(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    user_id = user_org.user.id
    request_row = await _create_request(client, user_org.user)

    first = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_id),
        files=_pdf_files("first.pdf"),
    )
    assert first.status_code == 201

    second = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_id),
        files=_pdf_files("second.pdf"),
    )
    assert second.status_code == 409
    assert "already" in second.json()["detail"].lower()


async def test_convert_upload_cross_org_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    request_row = await _create_request(client, org_a.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(org_b.user),
        files=_pdf_files(),
    )
    assert response.status_code == 404


async def test_convert_upload_missing_file_returns_422(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        # Note: no ``files`` kwarg — FastAPI validates the multipart
        # form and returns 422 when the ``file`` part is missing.
    )
    assert response.status_code == 422


async def test_convert_upload_empty_file_returns_400(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files={"file": ("empty.pdf", b"", _PDF_MIME)},
    )
    assert response.status_code == 400
    assert "empty" in response.json()["detail"].lower()


async def test_convert_upload_unsupported_extension_returns_400(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files={"file": ("note.txt", b"hello world", "text/plain")},
    )
    assert response.status_code == 400
    assert "extension" in response.json()["detail"].lower()


async def test_convert_upload_storage_failure_does_not_mutate_request(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A storage layer failure must leave the request unchanged.

    Mirrors ``test_convert_failure_leaves_request_and_inbox_unchanged``
    in the template-conversion suite: the route mutates the request
    after the storage step, so we monkey-patch the storage to raise
    and assert no partial state survives.
    """
    user_org = await _create_user_org(db_session)
    # Capture the user / org / request ids eagerly: after the storage
    # failure the override_get_db rollback expires every attached ORM
    # instance, and a later ``user_org.org.id`` access would trigger a
    # lazy reload outside an async-greenlet context.
    org_id = user_org.org.id
    user_id = user_org.user.id
    request_row = await _create_request(client, user_org.user)
    request_id = uuid.UUID(request_row["id"])

    class _BoomStorage(FakeStorage):
        async def store_encrypted(
            self,
            *,
            plaintext_bytes: bytes,
            document_id: str,
            org_master_key: bytes,
        ) -> StoredDocument:
            raise RuntimeError("simulated S3 failure")

    monkeypatch.setattr(requests_api, "DocumentStorage", _BoomStorage)

    response = await client.post(
        f"/api/requests/{request_id}/convert-upload",
        headers=_headers(user_id),
        files=_pdf_files(),
    )
    assert response.status_code == 500

    # ``override_get_db`` rolled the session back; reset our test view
    # of it before reading.
    await db_session.rollback()
    request = (
        await db_session.execute(
            select(ContractRequest).where(ContractRequest.id == request_id)
        )
    ).scalar_one()
    assert request.status == "open"
    assert request.linked_contract_id is None

    # The Contract row inserted before the storage call must have been
    # rolled back along with the failed transaction.
    contracts = (
        await db_session.execute(
            select(Contract).where(Contract.organization_id == org_id)
        )
    ).scalars().all()
    assert contracts == []

    artifacts = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.organization_id == org_id
            )
        )
    ).scalars().all()
    assert artifacts == []

    inbox = (
        await db_session.execute(
            select(InboxItem).where(InboxItem.request_id == request_id)
        )
    ).scalars().all()
    assert len(inbox) == 1
    assert inbox[0].status == "open"


async def test_convert_upload_response_does_not_leak_storage_internals(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files(),
    )
    assert response.status_code == 201, response.text
    text = response.text
    assert "storage_key" not in text
    assert "wrapped_dek" not in text
    body = response.json()
    assert "storage_key" not in body["artifact"]
    assert "wrapped_dek" not in body["artifact"]
    assert "storage_key" not in body["contract"]


async def test_convert_upload_emits_audit_event(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files(),
    )
    assert response.status_code == 201, response.text
    body = response.json()

    events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.organization_id == user_org.org.id,
                AuditEvent.event_type == "request.converted_by_upload",
            )
        )
    ).scalars().all()
    assert len(events) == 1
    event = events[0]
    assert event.target_type == "request"
    assert event.target_id == request_row["id"]
    assert event.details["request_id"] == request_row["id"]
    assert event.details["contract_id"] == body["contract"]["id"]
    assert event.details["artifact_id"] == body["artifact"]["id"]
    assert event.details["filename"] == "counterparty.pdf"
    # Storage internals never make it into the audit row.
    assert "storage_key" not in event.details
    assert "wrapped_dek" not in event.details


async def test_convert_upload_event_surfaces_on_request_activity_timeline(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """The new ``request.converted_by_upload`` event should appear on the
    request's activity timeline so users see how the request got linked.

    The timeline projection is server-rendered; this asserts on the
    title shape and the safe-detail fields rather than any raw audit
    blob. PR #65 doesn't surface the event on the contract timeline yet
    (the contract event-type bucket only covers DocuSeal send /
    completion). That's tracked as follow-up.
    """
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files(),
    )
    assert response.status_code == 201, response.text

    timeline = await client.get(
        f"/api/requests/{request_row['id']}/activity",
        headers=_headers(user_org.user),
    )
    assert timeline.status_code == 200, timeline.text
    items = timeline.json()["items"]
    upload_events = [
        item
        for item in items
        if item["event_type"] == "request.converted_by_upload"
    ]
    assert len(upload_events) == 1
    event = upload_events[0]
    assert "counterparty.pdf" in event["title"]
    assert event["request_id"] == request_row["id"]
    assert event["contract_id"] == response.json()["contract"]["id"]
    # Storage internals never reach the timeline projection.
    body_text = timeline.text
    assert "storage_key" not in body_text
    assert "wrapped_dek" not in body_text


async def test_convert_upload_returns_extracted_metadata(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """PR #66 — the convert-upload response carries an
    ``extracted_metadata`` block with deterministic suggestions
    derived from the filename and parsed body text.
    """
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files={
            "file": (
                "Mutual_NDA_Acme.pdf",
                _PDF_BYTES,
                _PDF_MIME,
            )
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    extracted = body["extracted_metadata"]
    assert extracted is not None
    assert extracted["suggested_title"] == "Mutual NDA Acme"
    assert extracted["likely_contract_type"] == "NDA"
    # The fixture's _StubParsed.full_text doesn't carry effective-date
    # text, so we don't expect a date here.
    assert extracted["effective_date"] is None
    # Counterparty isn't surfaced from the filename alone here because
    # "Acme" comes before the file extension and the body text gives
    # no "between X and Y" signal. The warning explains why.
    assert "counterparty_unknown" not in extracted["warnings"] or (
        extracted["possible_counterparty_name"] is not None
    )


async def test_convert_upload_returns_duplicate_warning_for_existing_hash(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """Uploading a second file with the same hash returns a warning in
    ``duplicate_candidates`` — the upload still succeeds (warning-only).
    """
    user_org = await _create_user_org(db_session)
    # First upload — registers the hash.
    first_request = await _create_request(
        client, user_org.user, title="First request"
    )
    first = await client.post(
        f"/api/requests/{first_request['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files("first.pdf"),
    )
    assert first.status_code == 201, first.text
    first_contract_id = first.json()["contract"]["id"]

    # Second upload on a different request, same bytes → same hash.
    second_request = await _create_request(
        client, user_org.user, title="Second request"
    )
    second = await client.post(
        f"/api/requests/{second_request['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files("second.pdf"),
    )
    assert second.status_code == 201, second.text
    candidates = second.json()["duplicate_candidates"]
    assert len(candidates) >= 1
    assert any(c["contract_id"] == first_contract_id for c in candidates)
    # The new contract never appears on its own candidate list.
    new_contract_id = second.json()["contract"]["id"]
    assert all(c["contract_id"] != new_contract_id for c in candidates)
    assert all(c["reason"] == "exact_file_hash" for c in candidates)
    # Storage internals never reach the response.
    text = second.text
    assert "storage_key" not in text
    assert "wrapped_dek" not in text


async def test_convert_upload_no_duplicates_yields_empty_list(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)
    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files(),
    )
    assert response.status_code == 201, response.text
    assert response.json()["duplicate_candidates"] == []


async def test_convert_upload_keeps_explicit_title_over_extracted(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)
    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        data={"title": "Operator Override"},
        files=_pdf_files("MSA_Acme_2026.pdf"),
    )
    assert response.status_code == 201, response.text
    body = response.json()
    # The user's explicit title wins; the extractor's suggestion shows
    # in ``extracted_metadata`` but does NOT replace ``contract.title``.
    assert body["contract"]["title"] == "Operator Override"
    assert body["extracted_metadata"]["suggested_title"] == "MSA Acme 2026"
    # Same precedence rule for counterparty: request.counterparty_name
    # is preserved when the form doesn't override it.
    assert (
        body["artifact"]["metadata_json"].get("counterparty_name")
        != "MSA"  # extractor should never overwrite a request's value
    )


async def test_convert_upload_metadata_failure_does_not_fail_upload(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A defective extractor raises — the upload must still succeed.

    The safe wrapper around ``extract_basic_contract_metadata`` is
    expected to catch the exception and return the empty-suggestion
    sentinel; the route never sees the raise.
    """
    from app.api import contracts as contracts_api

    def _boom(**_kwargs):
        raise RuntimeError("simulated extractor failure")

    monkeypatch.setattr(
        contracts_api, "extract_basic_contract_metadata", _boom
    )

    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files(),
    )
    assert response.status_code == 201, response.text
    em = response.json()["extracted_metadata"]
    assert em["suggested_title"] is None
    assert "extractor_error" in em["warnings"]


async def test_convert_upload_duplicate_failure_does_not_fail_upload(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A defective duplicate detector must not fail the upload."""
    from app.api import contracts as contracts_api

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("simulated duplicate-lookup failure")

    # ``_safe_find_duplicates`` catches the exception and returns [].
    monkeypatch.setattr(
        contracts_api,
        "find_possible_duplicate_contracts",
        _boom,
    )

    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)
    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files(),
    )
    assert response.status_code == 201, response.text
    assert response.json()["duplicate_candidates"] == []


async def test_uploaded_contract_is_downloadable_via_contracts_endpoint(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """End-to-end: after conversion, the new contract resolves through
    the existing ``/api/contracts/{id}/download`` path.

    The fake storage round-trips the bytes verbatim, so this is a
    direct check that the artifact row + storage key + AAD are wired
    up so the existing download resolver can find the encrypted blob
    and decrypt it.
    """
    user_org = await _create_user_org(db_session)
    request_row = await _create_request(client, user_org.user)

    response = await client.post(
        f"/api/requests/{request_row['id']}/convert-upload",
        headers=_headers(user_org.user),
        files=_pdf_files(),
    )
    assert response.status_code == 201, response.text
    contract_id = response.json()["contract"]["id"]

    download = await client.get(
        f"/api/contracts/{contract_id}/download",
        headers=_headers(user_org.user),
    )
    assert download.status_code == 200, download.text
    assert download.content == _PDF_BYTES
    # The Content-Disposition uses the uploaded filename.
    disposition = download.headers.get("content-disposition", "")
    assert "counterparty.pdf" in disposition
