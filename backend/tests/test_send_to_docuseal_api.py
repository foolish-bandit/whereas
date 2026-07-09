"""API tests for the contracts -> DocuSeal send-for-signature endpoint."""
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

from app.api import contracts as contracts_api
from app.core.database import Base, get_db
from app.main import app
from app.models import (
    AgreementTemplate,
    ApprovalPolicy,
    ApprovalStep,
    ApprovalWorkflowRun,
    ApprovalWorkflowTemplate,
    ApprovalWorkflowTemplateStep,
    Clause,
    Contract,
    ContractArtifact,
    ContractMarkdownSnapshot,
    ContractRequest,
    ContractStatus,
    ExtractedField,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent, AuditEventType
from app.security.encryption import create_org_master_key
from app.services.storage import StoredDocument

_PG_IMAGE = "pgvector/pgvector:pg16"
_DOCX_MIME = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
_INSTANCE_KEY = secrets.token_bytes(32)
_PDF_BYTES = b"%PDF-1.7\n% Whereas synthetic test PDF\n"
_DOCX_BYTES = b"PK\x03\x04 docx-bytes-pretend"


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
        # Approval-gate tables are required because PR #52 added a
        # gate check that looks up linked requests and policy-derived
        # workflows on every send. The send endpoint runs the gate
        # before any DocuSeal call.
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
    session: AsyncSession, *, email: str | None = None, is_admin: bool = False
) -> UserOrg:
    org = Organization(
        id=uuid.uuid4(),
        name=f"Org {uuid.uuid4()}",
        wrapped_master_key=None,
    )
    org.wrapped_master_key = _wrapped_org_key(org.id)
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=email or f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Test User",
        is_active=True,
        is_admin=is_admin,
    )
    session.add_all([org, user])
    await session.commit()
    return UserOrg(org=org, user=user)


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


async def _seed_contract(
    session: AsyncSession,
    *,
    user_org: UserOrg,
    s3_key: str,
    mime_type: str,
    title: str = "Test Contract",
) -> Contract:
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title=title,
        status=ContractStatus.READY.value,
        s3_key=s3_key,
        wrapped_dek=b"wrapped-dek",
        mime_type=mime_type,
        file_hash_sha256="b" * 64,
        page_count=1,
    )
    session.add(contract)
    await session.commit()
    return contract


async def _add_artifact(
    session: AsyncSession,
    *,
    contract: Contract,
    artifact_type: str,
    storage_key: str,
    mime_type: str,
    filename: str,
    is_official: bool = True,
    source: str = "user_upload",
) -> ContractArtifact:
    artifact = ContractArtifact(
        organization_id=contract.organization_id,
        contract_id=contract.id,
        artifact_type=artifact_type,
        storage_backend="s3",
        storage_key=storage_key,
        filename=filename,
        mime_type=mime_type,
        file_hash_sha256="c" * 64,
        size_bytes=4096,
        source=source,
        is_official=is_official,
    )
    session.add(artifact)
    await session.commit()
    return artifact


class FakeStorage:
    """Round-trip in-memory storage. Records retrieve calls."""

    blobs: dict[str, bytes] = {}
    retrieve_calls: list[dict[str, Any]] = []

    @classmethod
    def reset(cls) -> None:
        cls.blobs = {}
        cls.retrieve_calls = []

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
            wrapped_dek_bytes=b"wrapped-dek",
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
        FakeStorage.retrieve_calls.append(
            {
                "s3_key": s3_key,
                "document_id": document_id,
                "wrapped_dek_bytes": wrapped_dek_bytes,
            }
        )
        return FakeStorage.blobs[s3_key]


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

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def stub_docuseal(
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, Any]:
    """Patch the DocuSeal client so no real network call happens.

    Returns a recording dict so individual tests can inspect what the
    endpoint sent. ``response`` controls what the stub returns; tests
    can mutate it to simulate upstream errors.
    """
    state: dict[str, Any] = {
        "calls": [],
        "response": {
            "id": "demo-submission-1",
            "submission_id": "demo-submission-1",
            "submitters": [
                {"email": "signer@example.com", "embed_src": "https://docuseal.example/sign/abc"},
            ],
        },
        "raise_error": None,
    }

    async def fake_send(**kwargs: Any) -> dict[str, Any]:
        state["calls"].append(kwargs)
        if state["raise_error"] is not None:
            raise state["raise_error"]
        return state["response"]

    monkeypatch.setattr(contracts_api, "send_document_to_docuseal", fake_send)
    return state


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


_VALID_SIGNERS = [{"email": "signer@example.com", "name": "Signer One"}]


async def test_send_to_docuseal_uses_generated_docx_for_generated_contract(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    """A contract whose only artifact is a ``generated_docx`` row sends
    that artifact's bytes (and filename) to DocuSeal."""
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract(
        db_session,
        user_org=user_org,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type=_DOCX_MIME,
        title="Acme NDA",
    )
    FakeStorage.blobs[contract.s3_key] = _DOCX_BYTES
    await _add_artifact(
        db_session,
        contract=contract,
        artifact_type="generated_docx",
        storage_key=contract.s3_key,
        mime_type=_DOCX_MIME,
        filename="acme-nda.docx",
        source="template_generation",
    )

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": _VALID_SIGNERS},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["artifact_type"] == "generated_docx"
    assert body["filename"] == "acme-nda.docx"
    assert body["submission_id"] == "demo-submission-1"
    assert body["status"] == ContractStatus.SENT_FOR_SIGNATURE.value
    assert body["embed_url"] == "https://docuseal.example/sign/abc"
    assert body["signer_count"] == 1

    # The DocuSeal client received the decrypted bytes + DOCX MIME.
    assert len(stub_docuseal["calls"]) == 1
    call = stub_docuseal["calls"][0]
    assert call["document_bytes"] == _DOCX_BYTES
    assert call["mime_type"] == _DOCX_MIME
    assert call["filename"] == "acme-nda.docx"
    assert call["submitters"] == [
        {"email": "signer@example.com", "name": "Signer One", "role": "signer"},
    ]

    # Contract was flipped and the submission id was persisted.
    refreshed = (
        await db_session.execute(select(Contract).where(Contract.id == contract.id))
    ).scalar_one()
    assert refreshed.status == ContractStatus.SENT_FOR_SIGNATURE.value
    assert refreshed.docuseal_submission_id == "demo-submission-1"


async def test_send_to_docuseal_uses_original_upload_for_uploaded_contract(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    """An uploaded contract (no generated_docx) sends its original_upload."""
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract(
        db_session,
        user_org=user_org,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type="application/pdf",
        title="Vendor MSA",
    )
    FakeStorage.blobs[contract.s3_key] = _PDF_BYTES
    await _add_artifact(
        db_session,
        contract=contract,
        artifact_type="original_upload",
        storage_key=contract.s3_key,
        mime_type="application/pdf",
        filename="vendor.pdf",
    )

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": _VALID_SIGNERS},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["artifact_type"] == "original_upload"
    assert body["filename"] == "vendor.pdf"
    assert stub_docuseal["calls"][0]["document_bytes"] == _PDF_BYTES
    assert stub_docuseal["calls"][0]["mime_type"] == "application/pdf"


async def test_send_to_docuseal_prefers_generated_docx_over_original_upload(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    """When both artifacts exist, the generated draft is the one sent."""
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract(
        db_session,
        user_org=user_org,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type=_DOCX_MIME,
    )
    FakeStorage.blobs[contract.s3_key] = _DOCX_BYTES
    await _add_artifact(
        db_session,
        contract=contract,
        artifact_type="original_upload",
        storage_key="documents/original.enc",
        mime_type="application/pdf",
        filename="original.pdf",
    )
    FakeStorage.blobs["documents/generated.enc"] = b"generated-docx-bytes"
    generated = await _add_artifact(
        db_session,
        contract=contract,
        artifact_type="generated_docx",
        storage_key="documents/generated.enc",
        mime_type=_DOCX_MIME,
        filename="generated.docx",
        source="template_generation",
    )

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": _VALID_SIGNERS},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["artifact_id"] == str(generated.id)
    assert body["artifact_type"] == "generated_docx"
    # The DocuSeal stub got the generated bytes, not the original.
    assert (
        stub_docuseal["calls"][0]["document_bytes"] == b"generated-docx-bytes"
    )
    assert stub_docuseal["calls"][0]["filename"] == "generated.docx"


async def test_send_to_docuseal_cross_org_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    owner = await _create_user_org(db_session, email="owner@example.com")
    other = await _create_user_org(db_session, email="other@example.com")
    contract = await _seed_contract(
        db_session,
        user_org=owner,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type=_DOCX_MIME,
    )
    FakeStorage.blobs[contract.s3_key] = _DOCX_BYTES
    await _add_artifact(
        db_session,
        contract=contract,
        artifact_type="generated_docx",
        storage_key=contract.s3_key,
        mime_type=_DOCX_MIME,
        filename="x.docx",
        source="template_generation",
    )

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(other.user),
        json={"signers": _VALID_SIGNERS},
    )
    assert response.status_code == 404
    assert stub_docuseal["calls"] == []


async def test_send_to_docuseal_missing_artifact_returns_409(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    """A contract with no downloadable artifact returns a clear 409."""
    user_org = await _create_user_org(db_session)
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Naked Contract",
        status=ContractStatus.READY.value,
        s3_key="pending",
        wrapped_dek=b"wrapped-dek",
        mime_type=_DOCX_MIME,
        file_hash_sha256="d" * 64,
    )
    db_session.add(contract)
    await db_session.commit()

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": _VALID_SIGNERS},
    )
    assert response.status_code == 409
    assert "downloadable artifact" in response.json()["detail"].lower()
    assert stub_docuseal["calls"] == []


async def test_send_to_docuseal_missing_wrapped_dek_returns_409(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    user_org = await _create_user_org(db_session)
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="No DEK",
        status=ContractStatus.READY.value,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        wrapped_dek=None,
        mime_type=_DOCX_MIME,
        file_hash_sha256="e" * 64,
    )
    db_session.add(contract)
    await db_session.commit()

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": _VALID_SIGNERS},
    )
    assert response.status_code == 409
    assert stub_docuseal["calls"] == []


async def test_send_to_docuseal_response_does_not_expose_storage_internals(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract(
        db_session,
        user_org=user_org,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type=_DOCX_MIME,
    )
    FakeStorage.blobs[contract.s3_key] = _DOCX_BYTES
    await _add_artifact(
        db_session,
        contract=contract,
        artifact_type="generated_docx",
        storage_key=contract.s3_key,
        mime_type=_DOCX_MIME,
        filename="x.docx",
        source="template_generation",
    )

    # If DocuSeal accidentally surfaces a token-shaped field, the
    # endpoint must scrub it from ``raw``.
    stub_docuseal["response"] = {
        "id": "demo-submission-2",
        "token": "should-not-be-echoed",
        "embed_url": "https://docuseal.example/sign/abc",
    }

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": _VALID_SIGNERS},
    )

    assert response.status_code == 201
    text = response.text
    assert "storage_key" not in text
    assert "wrapped_dek" not in text
    assert "wrapped_master_key" not in text
    assert "should-not-be-echoed" not in text
    body = response.json()
    assert body["raw"] is not None
    assert "token" not in body["raw"]


async def test_send_to_docuseal_audit_log_contains_no_storage_internals(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract(
        db_session,
        user_org=user_org,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type=_DOCX_MIME,
    )
    FakeStorage.blobs[contract.s3_key] = _DOCX_BYTES
    artifact = await _add_artifact(
        db_session,
        contract=contract,
        artifact_type="generated_docx",
        storage_key=contract.s3_key,
        mime_type=_DOCX_MIME,
        filename="acme.docx",
        source="template_generation",
    )

    # A unique signer to act as a sentinel: if anything in the audit
    # log surfaces signer PII, this token shows up.
    sentinel_email = "audit-sentinel@example.com"
    sentinel_name = "Audit Sentinel Counterparty"
    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={
            "signers": [
                {"email": sentinel_email, "name": sentinel_name},
            ],
        },
    )
    assert response.status_code == 201

    events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.event_type
                == AuditEventType.CONTRACT_SENT_FOR_SIGNATURE.value
            )
        )
    ).scalars().all()
    assert len(events) == 1
    details = events[0].details
    assert details["contract_id"] == str(contract.id)
    assert details["artifact_id"] == str(artifact.id)
    assert details["filename"] == "acme.docx"
    assert details["signer_count"] == 1
    assert details["submission_id"] == "demo-submission-1"
    raw = str(details)
    assert "storage_key" not in raw
    assert "wrapped_dek" not in raw
    assert contract.s3_key not in raw
    # Signer PII must not be persisted into the audit log: signer_count
    # alone is enough, and the full submitter list lives in DocuSeal.
    assert sentinel_email not in raw
    assert sentinel_name not in raw


async def test_send_to_docuseal_validates_signer_payload(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract(
        db_session,
        user_org=user_org,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type=_DOCX_MIME,
    )
    FakeStorage.blobs[contract.s3_key] = _DOCX_BYTES
    await _add_artifact(
        db_session,
        contract=contract,
        artifact_type="generated_docx",
        storage_key=contract.s3_key,
        mime_type=_DOCX_MIME,
        filename="x.docx",
        source="template_generation",
    )

    # Missing signers.
    empty = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": []},
    )
    assert empty.status_code == 422
    assert stub_docuseal["calls"] == []

    # Malformed email.
    bad = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": [{"email": "not-an-email", "name": "X"}]},
    )
    assert bad.status_code == 422
    assert stub_docuseal["calls"] == []


async def test_send_to_docuseal_propagates_upstream_error(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    """An upstream DocuSeal failure surfaces as 502 and leaves the
    contract row untouched: no status flip, no submission id, no
    audit event. The request-scoped session rolls back on the
    exception (see ``app.core.database.get_db``), so even partial
    state mutated before the error gets discarded."""
    from app.services.docuseal_bridge import DocuSealError

    user_org = await _create_user_org(db_session)
    contract = await _seed_contract(
        db_session,
        user_org=user_org,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type=_DOCX_MIME,
    )
    FakeStorage.blobs[contract.s3_key] = _DOCX_BYTES
    await _add_artifact(
        db_session,
        contract=contract,
        artifact_type="generated_docx",
        storage_key=contract.s3_key,
        mime_type=_DOCX_MIME,
        filename="x.docx",
        source="template_generation",
    )

    stub_docuseal["raise_error"] = DocuSealError("DocuSeal exploded")

    # Capture the id before the request so the post-rollback ORM state
    # of ``contract`` doesn't matter for the assertion query.
    contract_id = contract.id

    response = await client.post(
        f"/api/contracts/{contract_id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": _VALID_SIGNERS},
    )
    assert response.status_code == 502
    assert "DocuSeal" in response.json()["detail"]

    # Contract state must not have been mutated by the failed send.
    refreshed = await db_session.get(Contract, contract_id)
    assert refreshed is not None
    assert refreshed.status == ContractStatus.READY.value
    assert refreshed.docuseal_submission_id is None

    # No audit event written for a failed send.
    events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.event_type
                == AuditEventType.CONTRACT_SENT_FOR_SIGNATURE.value,
                AuditEvent.target_id == str(contract_id),
            )
        )
    ).scalars().all()
    assert events == []


async def test_send_document_to_docuseal_retries_on_5xx_only() -> None:
    """The retry policy must NOT burn attempts on 4xx responses.

    A 4xx from DocuSeal means the request itself was malformed (bad
    template, malformed submitter shape, expired token); retrying
    won't fix it. A 5xx or transport error is the legitimate retry
    surface. This is verified at the service layer with a fake
    transport so we can assert call counts.
    """
    from app.services import docuseal_bridge as service

    fivehundred_calls = {"n": 0}

    def fake_transport_5xx(request: httpx.Request) -> httpx.Response:
        fivehundred_calls["n"] += 1
        return httpx.Response(503, json={"error": "down"})

    fourhundred_calls = {"n": 0}

    def fake_transport_4xx(request: httpx.Request) -> httpx.Response:
        fourhundred_calls["n"] += 1
        return httpx.Response(400, json={"error": "bad"})

    class StubAsyncClient:
        def __init__(self, transport: Any) -> None:
            self._transport = transport

        async def __aenter__(self) -> Any:
            class Inner:
                def __init__(self, transport: Any) -> None:
                    self._transport = transport

                async def post(
                    self,
                    url: str,
                    *,
                    headers: dict[str, str],
                    json: dict[str, Any],
                ) -> httpx.Response:
                    request = httpx.Request("POST", url, headers=headers, json=json)
                    return self._transport(request)

            return Inner(self._transport)

        async def __aexit__(self, *args: Any) -> None:
            pass

    import contextlib

    @contextlib.contextmanager
    def patch_async_client(transport: Any) -> Any:
        original = service.httpx.AsyncClient
        service.httpx.AsyncClient = lambda *a, **kw: StubAsyncClient(transport)  # type: ignore[assignment]
        try:
            yield
        finally:
            service.httpx.AsyncClient = original  # type: ignore[assignment]

    # Speed up the retry waits so the test stays fast.
    service.send_document_to_docuseal.retry.wait = lambda *a, **kw: 0  # type: ignore[attr-defined]

    common_kwargs: dict[str, Any] = {
        "filename": "x.docx",
        "mime_type": _DOCX_MIME,
        "submitters": [{"email": "a@example.com", "name": "A", "role": "signer"}],
        "user_id": uuid.uuid4(),
        "user_email": "u@example.com",
        "organization_id": uuid.uuid4(),
        "document_bytes": b"x",
    }

    with patch_async_client(fake_transport_5xx), pytest.raises(service.RetryableDocuSealError):
        await service.send_document_to_docuseal(**common_kwargs)
    assert fivehundred_calls["n"] == 3, "5xx should be retried 3x"

    with patch_async_client(fake_transport_4xx):
        with pytest.raises(service.DocuSealError) as excinfo:
            await service.send_document_to_docuseal(**common_kwargs)
        # Plain DocuSealError (not RetryableDocuSealError) — terminal.
        assert not isinstance(excinfo.value, service.RetryableDocuSealError)
    assert fourhundred_calls["n"] == 1, "4xx must NOT be retried"


async def test_send_to_docuseal_legacy_contract_falls_back_to_s3_key(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    """Legacy contracts (no ContractArtifact rows) still send via Contract.s3_key.

    The fallback exists for contracts uploaded before the artifact
    model landed and not yet backfilled. Callers do not need to know
    about the legacy path; the response carries no artifact_id.
    """
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract(
        db_session,
        user_org=user_org,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type="application/pdf",
        title="Legacy Contract",
    )
    FakeStorage.blobs[contract.s3_key] = _PDF_BYTES

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": _VALID_SIGNERS},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["artifact_id"] is None
    assert body["artifact_type"] is None
    # Filename comes from the contract title sanitization.
    assert body["filename"] is not None
    assert stub_docuseal["calls"][0]["document_bytes"] == _PDF_BYTES
    assert stub_docuseal["calls"][0]["mime_type"] == "application/pdf"


# ---------------------------------------------------------------------------
# Authorization: approval_override is admin-only
# ---------------------------------------------------------------------------


async def _create_blocking_policy(
    session: AsyncSession, *, org_id: uuid.UUID
) -> ApprovalPolicy:
    """A required, unmet ``ApprovalPolicy`` so ``can_send_contract_to_docuseal``
    returns ``allowed=False`` (mirrors ``test_contract_approval_gate_api.py``'s
    ``_create_policy`` helper)."""
    template = ApprovalWorkflowTemplate(
        organization_id=org_id,
        name=f"Template {uuid.uuid4().hex[:8]}",
        status="active",
    )
    session.add(template)
    await session.flush()
    session.add(
        ApprovalWorkflowTemplateStep(
            organization_id=org_id,
            workflow_template_id=template.id,
            step_order=1,
            title="Legal review",
        )
    )
    await session.flush()
    policy = ApprovalPolicy(
        organization_id=org_id,
        name="Standard Legal Review",
        status="active",
        workflow_template_id=template.id,
        request_type="new_contract",
        contract_type="NDA",
        priority="high",
        applies_to_generated_contracts=True,
        auto_attach=True,
    )
    session.add(policy)
    await session.commit()
    return policy


async def _seed_blocked_contract(
    session: AsyncSession, *, user_org: UserOrg
) -> Contract:
    """A contract whose approval gate is blocked: linked to a
    ``ContractRequest`` that matches a required, unmet ``ApprovalPolicy``."""
    await _create_blocking_policy(session, org_id=user_org.org.id)
    contract = await _seed_contract(
        session,
        user_org=user_org,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type="application/pdf",
        title="NDA with Acme",
    )
    FakeStorage.blobs[contract.s3_key] = _PDF_BYTES
    request = ContractRequest(
        organization_id=user_org.org.id,
        title="NDA with Acme",
        request_type="new_contract",
        contract_type="NDA",
        priority="high",
        linked_contract_id=contract.id,
    )
    session.add(request)
    await session.commit()
    return contract


async def test_send_to_docuseal_override_by_non_admin_returns_403(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    """A non-admin cannot use ``approval_override``, even on a contract
    whose gate is blocked and even with a reason supplied."""
    user_org = await _create_user_org(db_session, is_admin=False)
    contract = await _seed_blocked_contract(db_session, user_org=user_org)

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={
            "signers": _VALID_SIGNERS,
            "approval_override": True,
            "approval_override_reason": "Deal closes today.",
        },
    )
    assert response.status_code == 403
    assert stub_docuseal["calls"] == []


async def test_send_to_docuseal_override_by_admin_succeeds_when_gate_blocked(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    """An org admin CAN override a blocked gate, given a reason."""
    user_org = await _create_user_org(db_session, is_admin=True)
    contract = await _seed_blocked_contract(db_session, user_org=user_org)

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={
            "signers": _VALID_SIGNERS,
            "approval_override": True,
            "approval_override_reason": "Deal closes today.",
        },
    )
    assert response.status_code == 201, response.text
    assert len(stub_docuseal["calls"]) == 1


async def test_send_to_docuseal_blocked_gate_without_override_returns_409_for_admin_too(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal: dict[str, Any],
) -> None:
    """Being an admin doesn't bypass the gate on its own — the override
    flag must still be explicitly set."""
    user_org = await _create_user_org(db_session, is_admin=True)
    contract = await _seed_blocked_contract(db_session, user_org=user_org)

    response = await client.post(
        f"/api/contracts/{contract.id}/send-to-docuseal",
        headers=_headers(user_org.user),
        json={"signers": _VALID_SIGNERS},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "approval_required"
    assert stub_docuseal["calls"] == []
