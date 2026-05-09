"""API tests for the DocuSeal webhook endpoint.

Covers:
  * verification — DocuSeal-format ``X-Docuseal-Signature`` (timestamp +
    HMAC over ``"{ts}.{body}"`` with stale-timestamp rejection),
    interim shared-secret header, malformed/missing signature
  * irrelevant events return 202 without mutating state
  * unknown submission ids return 202 without mutating state
  * completion event creates a signed_pdf artifact and flips status
  * duplicate webhook is idempotent
  * audit event excludes secrets
  * download resolution prefers signed_pdf
  * no real DocuSeal network call
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import subprocess
import time
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
    Clause,
    Contract,
    ContractArtifact,
    ContractMarkdownSnapshot,
    ContractStatus,
    ExtractedField,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent, AuditEventType
from app.security.encryption import create_org_master_key
from app.services import docuseal_completion as completion_service
from app.services.storage import StoredDocument

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)
_WEBHOOK_SECRET = "test-docuseal-webhook-secret-do-not-use-in-prod"  # noqa: S105
_PDF_BYTES = b"%PDF-1.7\n% Whereas synthetic signed PDF\nx"


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
    session: AsyncSession, *, email: str | None = None
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
    )
    session.add_all([org, user])
    await session.commit()
    return UserOrg(org=org, user=user)


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


async def _seed_sent_contract(
    session: AsyncSession,
    *,
    user_org: UserOrg,
    docuseal_submission_id: str,
    title: str = "NDA awaiting signature",
) -> Contract:
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title=title,
        status=ContractStatus.SENT_FOR_SIGNATURE.value,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        wrapped_dek=b"wrapped-dek-pretend",
        mime_type="application/pdf",
        file_hash_sha256="b" * 64,
        page_count=1,
        docuseal_submission_id=docuseal_submission_id,
    )
    session.add(contract)
    await session.commit()
    return contract


class FakeStorage:
    """In-memory round-trip storage. Records what was stored where."""

    blobs: dict[str, bytes] = {}
    store_calls: list[dict[str, Any]] = []
    retrieve_calls: list[dict[str, Any]] = []

    @classmethod
    def reset(cls) -> None:
        cls.blobs = {}
        cls.store_calls = []
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
        FakeStorage.store_calls.append(
            {
                "document_id": document_id,
                "s3_key": s3_key,
                "plaintext_bytes": plaintext_bytes,
            }
        )
        return StoredDocument(
            s3_key=s3_key,
            wrapped_dek_bytes=f"wrapped-dek-{document_id}".encode()[:32].ljust(32, b"x"),
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
    monkeypatch.setenv("DOCUSEAL_WEBHOOK_SECRET", _WEBHOOK_SECRET)
    # The verifier captures Settings at import time via a module-level
    # cache. Drop the cache so the env override takes effect.
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
    monkeypatch.setattr(contracts_api, "DocumentStorage", FakeStorage)
    monkeypatch.setattr(completion_service, "DocumentStorage", FakeStorage)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()
    get_settings.cache_clear()


@pytest.fixture
def stub_docuseal_fetch(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Patch the signed-document fetch so no network call happens."""
    state: dict[str, Any] = {
        "calls": [],
        "response_bytes": _PDF_BYTES,
        "raise_error": None,
    }

    async def fake_fetch(**kwargs: Any) -> bytes:
        state["calls"].append(kwargs)
        if state["raise_error"] is not None:
            raise state["raise_error"]
        return state["response_bytes"]

    monkeypatch.setattr(
        completion_service,
        "get_signed_document_from_docuseal",
        fake_fetch,
    )
    return state


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _docuseal_signature_header(body: bytes, *, timestamp: int | None = None) -> str:
    """Build a valid ``X-Docuseal-Signature`` header for testing.

    DocuSeal signs ``"{timestamp}.{raw_body}"`` and emits
    ``"{timestamp}.{hex_signature}"``. The verifier rejects both
    malformed shapes and stale timestamps; this helper produces a
    well-formed, fresh value so tests can assert the happy path.
    """
    ts = timestamp if timestamp is not None else int(time.time())
    payload = f"{ts}.".encode("ascii") + body
    sig = hmac.new(
        _WEBHOOK_SECRET.encode("utf-8"), payload, hashlib.sha256
    ).hexdigest()
    return f"{ts}.{sig}"


def _completion_payload(submission_id: str, *, event_id: str | None = "evt-1") -> dict[str, Any]:
    payload: dict[str, Any] = {
        "event_type": "submission.completed",
        "data": {
            "submission_id": submission_id,
            "completed_at": "2026-05-09T10:00:00Z",
        },
    }
    if event_id is not None:
        payload["event_id"] = event_id
    return payload


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


async def test_webhook_rejects_missing_signature(
    client: httpx.AsyncClient,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    body = json.dumps(_completion_payload("sub-x")).encode()
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 401
    # No signed-document fetch attempted on a rejected request.
    assert stub_docuseal_fetch["calls"] == []


async def test_webhook_rejects_invalid_signature(
    client: httpx.AsyncClient,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    """A well-formed-shape header with a wrong HMAC must fail."""
    body = json.dumps(_completion_payload("sub-x")).encode()
    ts = int(time.time())
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": f"{ts}.{'0' * 64}",
        },
    )
    assert response.status_code == 401
    assert stub_docuseal_fetch["calls"] == []


async def test_webhook_rejects_unsigned_body_with_only_hex_signature(
    client: httpx.AsyncClient,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    """Pre-fix shape (raw HMAC, no timestamp prefix) must be rejected.

    Guards the regression where the verifier accepted a bare hex
    HMAC of the raw body (the format Whereas shipped before this
    fix); DocuSeal's documented format is ``timestamp.signature`` over
    ``timestamp.body``, and the verifier must require the prefix.
    """
    body = json.dumps(_completion_payload("sub-x")).encode()
    bare_hmac = hmac.new(
        _WEBHOOK_SECRET.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": bare_hmac,
        },
    )
    assert response.status_code == 401
    assert stub_docuseal_fetch["calls"] == []


async def test_webhook_rejects_stale_timestamp(
    client: httpx.AsyncClient,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    """A signature whose embedded timestamp is older than the
    tolerance window is rejected even when the HMAC itself is valid
    against that timestamp. Closes the replay window."""
    body = json.dumps(_completion_payload("sub-stale")).encode()
    stale_ts = int(time.time()) - (10 * 60)  # 10 minutes old; tolerance is 5
    header = _docuseal_signature_header(body, timestamp=stale_ts)
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": header,
        },
    )
    assert response.status_code == 401
    assert stub_docuseal_fetch["calls"] == []


async def test_webhook_rejects_future_timestamp_outside_tolerance(
    client: httpx.AsyncClient,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    """Symmetric to the stale case: a far-future timestamp also
    rejects, so a clock-skewed attacker can't claim freshness by
    advancing the clock arbitrarily."""
    body = json.dumps(_completion_payload("sub-future")).encode()
    future_ts = int(time.time()) + (10 * 60)
    header = _docuseal_signature_header(body, timestamp=future_ts)
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": header,
        },
    )
    assert response.status_code == 401
    assert stub_docuseal_fetch["calls"] == []


async def test_webhook_rejects_malformed_signature_header(
    client: httpx.AsyncClient,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    """Headers that aren't ``timestamp.signature`` are rejected."""
    body = json.dumps(_completion_payload("sub-malformed")).encode()
    cases = [
        "",                       # empty
        ".",                      # both halves empty
        "abc.def",                # non-numeric timestamp
        f"{int(time.time())}.",   # missing signature
        f".{'a' * 64}",           # missing timestamp
    ]
    for bad in cases:
        response = await client.post(
            "/api/docuseal/webhook",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Docuseal-Signature": bad,
            },
        )
        assert response.status_code == 401, f"expected 401 for {bad!r}"
    assert stub_docuseal_fetch["calls"] == []


async def test_webhook_signature_header_is_case_insensitive(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    """DocuSeal's documented header spelling is ``X-Docuseal-Signature``;
    other casings (``X-DocuSeal-Signature``, all-lower) must work too,
    matching HTTP header case-insensitivity."""
    user_org = await _create_user_org(db_session)
    submission_id = "sub-case-1"
    await _seed_sent_contract(
        db_session, user_org=user_org, docuseal_submission_id=submission_id
    )
    body = json.dumps(_completion_payload(submission_id)).encode()
    header = _docuseal_signature_header(body)
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "x-docuseal-signature": header,
        },
    )
    assert response.status_code == 202


async def test_webhook_shared_secret_path_does_not_override_invalid_hmac(
    client: httpx.AsyncClient,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    """A request that includes BOTH a (bad) HMAC header and the shared
    secret must be rejected on the bad HMAC; the shared-secret path
    is only consulted when the documented signature header is absent.
    Otherwise an attacker who learned the shared secret could bypass
    HMAC validation entirely."""
    body = json.dumps(_completion_payload("sub-mix")).encode()
    ts = int(time.time())
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": f"{ts}.{'0' * 64}",
            "X-Whereas-Docuseal-Webhook-Secret": _WEBHOOK_SECRET,
        },
    )
    assert response.status_code == 401
    assert stub_docuseal_fetch["calls"] == []


async def test_webhook_accepts_shared_secret_header(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    """Operators on older DocuSeal versions can configure the interim
    shared-secret header instead of HMAC signing."""
    user_org = await _create_user_org(db_session)
    submission_id = "sub-shared-1"
    contract = await _seed_sent_contract(
        db_session, user_org=user_org, docuseal_submission_id=submission_id
    )
    body = json.dumps(_completion_payload(submission_id)).encode()
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Whereas-Docuseal-Webhook-Secret": _WEBHOOK_SECRET,
        },
    )
    assert response.status_code == 202
    body_json = response.json()
    assert body_json["status"] == "created"
    assert body_json["contract_id"] == str(contract.id)


# ---------------------------------------------------------------------------
# Event handling
# ---------------------------------------------------------------------------


async def test_webhook_completion_creates_signed_pdf_artifact(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    user_org = await _create_user_org(db_session)
    submission_id = "sub-completion-1"
    contract = await _seed_sent_contract(
        db_session, user_org=user_org, docuseal_submission_id=submission_id
    )
    contract_id = contract.id
    body = json.dumps(_completion_payload(submission_id)).encode()
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": _docuseal_signature_header(body),
        },
    )
    assert response.status_code == 202, response.text
    out = response.json()
    assert out["status"] == "created"
    assert out["contract_id"] == str(contract_id)
    assert out["artifact_id"] is not None

    # Signed PDF was retrieved from the (stubbed) DocuSeal client.
    assert len(stub_docuseal_fetch["calls"]) == 1
    assert stub_docuseal_fetch["calls"][0]["submission_id"] == submission_id

    # Artifact row exists with the right shape.
    artifacts = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id
            )
        )
    ).scalars().all()
    assert len(artifacts) == 1
    art = artifacts[0]
    assert art.artifact_type == "signed_pdf"
    assert art.is_official is True
    assert art.source == "docuseal"
    assert art.mime_type == "application/pdf"
    assert art.filename and art.filename.endswith(".signed.pdf")
    assert art.file_hash_sha256 == hashlib.sha256(_PDF_BYTES).hexdigest()
    assert art.size_bytes == len(_PDF_BYTES)
    assert art.wrapped_dek is not None
    meta = art.metadata_json
    assert meta is not None
    assert meta["docuseal_submission_id"] == submission_id
    assert meta["docuseal_event_id"] == "evt-1"
    assert meta["signed_at"] == "2026-05-09T10:00:00Z"

    # Contract status flipped to EXECUTED.
    refreshed = await db_session.get(Contract, contract_id)
    assert refreshed is not None
    assert refreshed.status == ContractStatus.EXECUTED.value

    # Audit event written with safe fields only.
    audit = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.event_type == AuditEventType.CONTRACT_EXECUTED.value
            )
        )
    ).scalars().all()
    assert len(audit) == 1
    details = audit[0].details
    assert details["contract_id"] == str(contract_id)
    assert details["artifact_id"] == str(art.id)
    assert details["filename"].endswith(".signed.pdf")
    assert details["docuseal_submission_id"] == submission_id
    audit_blob = str(details)
    assert "storage_key" not in audit_blob
    assert "wrapped_dek" not in audit_blob


async def test_webhook_irrelevant_event_returns_202_without_writes(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _seed_sent_contract(
        db_session, user_org=user_org, docuseal_submission_id="sub-z"
    )
    payload = {
        "event_type": "submission.viewed",
        "data": {"submission_id": "sub-z"},
    }
    body = json.dumps(payload).encode()
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": _docuseal_signature_header(body),
        },
    )
    assert response.status_code == 202
    assert response.json()["status"] == "ignored"
    # Contract status unchanged; no artifact created.
    refreshed = await db_session.get(Contract, contract.id)
    assert refreshed is not None
    assert refreshed.status == ContractStatus.SENT_FOR_SIGNATURE.value
    artifacts = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract.id
            )
        )
    ).scalars().all()
    assert artifacts == []
    assert stub_docuseal_fetch["calls"] == []


async def test_webhook_unknown_submission_returns_202_unknown(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    body = json.dumps(_completion_payload("sub-not-here")).encode()
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": _docuseal_signature_header(body),
        },
    )
    assert response.status_code == 202
    assert response.json()["status"] == "unknown"
    assert stub_docuseal_fetch["calls"] == []


async def test_webhook_duplicate_completion_is_idempotent(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    user_org = await _create_user_org(db_session)
    submission_id = "sub-dup-1"
    contract = await _seed_sent_contract(
        db_session, user_org=user_org, docuseal_submission_id=submission_id
    )
    contract_id = contract.id
    body = json.dumps(_completion_payload(submission_id)).encode()
    headers = {
        "Content-Type": "application/json",
        "X-Docuseal-Signature": _docuseal_signature_header(body),
    }
    first = await client.post(
        "/api/docuseal/webhook", content=body, headers=headers
    )
    assert first.status_code == 202
    first_artifact_id = first.json()["artifact_id"]
    second = await client.post(
        "/api/docuseal/webhook", content=body, headers=headers
    )
    assert second.status_code == 202
    assert second.json()["status"] == "duplicate"
    assert second.json()["artifact_id"] == first_artifact_id

    artifacts = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id,
                ContractArtifact.artifact_type == "signed_pdf",
            )
        )
    ).scalars().all()
    assert len(artifacts) == 1
    # No second DocuSeal fetch.
    assert len(stub_docuseal_fetch["calls"]) == 1


async def test_webhook_response_has_no_storage_internals(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    user_org = await _create_user_org(db_session)
    submission_id = "sub-no-leak"
    await _seed_sent_contract(
        db_session, user_org=user_org, docuseal_submission_id=submission_id
    )
    body = json.dumps(_completion_payload(submission_id)).encode()
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": _docuseal_signature_header(body),
        },
    )
    assert response.status_code == 202
    text = response.text
    assert "storage_key" not in text
    assert "wrapped_dek" not in text


async def test_webhook_malformed_json_returns_400(
    client: httpx.AsyncClient,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    body = b"this-is-not-json"
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": _docuseal_signature_header(body),
        },
    )
    assert response.status_code == 400
    assert stub_docuseal_fetch["calls"] == []


async def test_webhook_propagates_docuseal_fetch_failure_as_502(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    from app.services.docuseal_bridge import DocuSealError

    user_org = await _create_user_org(db_session)
    submission_id = "sub-fetch-fail"
    contract = await _seed_sent_contract(
        db_session, user_org=user_org, docuseal_submission_id=submission_id
    )
    contract_id = contract.id
    stub_docuseal_fetch["raise_error"] = DocuSealError("DocuSeal exploded")
    body = json.dumps(_completion_payload(submission_id)).encode()
    response = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": _docuseal_signature_header(body),
        },
    )
    assert response.status_code == 502
    # Contract status unchanged on fetch failure.
    refreshed = await db_session.get(Contract, contract_id)
    assert refreshed is not None
    assert refreshed.status == ContractStatus.SENT_FOR_SIGNATURE.value
    artifacts = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id
            )
        )
    ).scalars().all()
    assert artifacts == []


# ---------------------------------------------------------------------------
# Download integration
# ---------------------------------------------------------------------------


async def test_signed_pdf_is_preferred_in_download_resolution(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_docuseal_fetch: dict[str, Any],
) -> None:
    """After completion, the contract download endpoint serves the
    signed_pdf, not the prior generated_docx / original_upload."""
    user_org = await _create_user_org(db_session)
    submission_id = "sub-download-1"
    contract = await _seed_sent_contract(
        db_session, user_org=user_org, docuseal_submission_id=submission_id
    )
    contract_id = contract.id

    # Pre-existing "generated_docx" artifact under contract.s3_key,
    # encrypted under contract.wrapped_dek (legacy path: artifact.wrapped_dek
    # left NULL).
    FakeStorage.blobs[contract.s3_key] = b"pre-signature draft bytes"
    db_session.add(
        ContractArtifact(
            organization_id=user_org.org.id,
            contract_id=contract_id,
            artifact_type="generated_docx",
            storage_backend="s3",
            storage_key=contract.s3_key,
            filename="draft.docx",
            mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            file_hash_sha256="d" * 64,
            size_bytes=24,
            source="template_generation",
            is_official=True,
        )
    )
    await db_session.commit()

    body = json.dumps(_completion_payload(submission_id)).encode()
    completion = await client.post(
        "/api/docuseal/webhook",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Docuseal-Signature": _docuseal_signature_header(body),
        },
    )
    assert completion.status_code == 202

    download = await client.get(
        f"/api/contracts/{contract_id}/download",
        headers=_headers(user_org.user),
    )
    assert download.status_code == 200, download.text
    assert download.headers["content-type"] == "application/pdf"
    assert ".signed.pdf" in download.headers["content-disposition"]
    # The bytes returned are the signed PDF, not the prior draft.
    assert download.content == _PDF_BYTES
    assert b"pre-signature draft bytes" not in download.content


# ---------------------------------------------------------------------------
# Verifier dev escape hatch
# ---------------------------------------------------------------------------


async def test_webhook_rejects_when_secret_unset_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No webhook secret configured + not development -> reject.

    This is a service-level test; we don't go through the route
    because the route's settings are cached at import time and we
    want to assert on the verifier directly.
    """
    from app.core.config import Settings, get_settings
    from app.services.docuseal_bridge import (
        WebhookVerificationError,
        verify_docuseal_webhook,
    )

    # Build a fresh Settings with no webhook secret + production env.
    fresh = Settings(  # type: ignore[call-arg]
        SECRET_KEY="x",
        DATABASE_URL="postgresql+asyncpg://x/x",
        S3_ENDPOINT="x",
        S3_ACCESS_KEY="x",
        S3_SECRET_KEY="x",
        DOCUSEAL_AUTH_BRIDGE_SECRET="x",
        ENVIRONMENT="production",
        DOCUSEAL_WEBHOOK_SECRET=None,
    )
    with pytest.raises(WebhookVerificationError):
        verify_docuseal_webhook(headers={}, body=b"{}", settings=fresh)
    get_settings.cache_clear()


async def test_webhook_dev_escape_hatch_allows_unsigned_when_secret_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Development with no secret configured: silent accept (logged warning).

    This keeps the local dev loop ergonomic while production stays
    locked down (see the prior test).
    """
    from app.core.config import Settings, get_settings
    from app.services.docuseal_bridge import verify_docuseal_webhook

    fresh = Settings(  # type: ignore[call-arg]
        SECRET_KEY="x",
        DATABASE_URL="postgresql+asyncpg://x/x",
        S3_ENDPOINT="x",
        S3_ACCESS_KEY="x",
        S3_SECRET_KEY="x",
        DOCUSEAL_AUTH_BRIDGE_SECRET="x",
        ENVIRONMENT="development",
        DOCUSEAL_WEBHOOK_SECRET=None,
    )
    # Should not raise.
    verify_docuseal_webhook(headers={}, body=b"{}", settings=fresh)
    get_settings.cache_clear()
