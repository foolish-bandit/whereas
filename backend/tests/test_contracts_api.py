"""API tests for contract upload/list/detail/download routes."""
from __future__ import annotations

import hashlib
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
except ImportError:  # pragma: no cover - exercised when testcontainers is absent
    PostgresContainer = None  # type: ignore[assignment,misc]

from app.api import contracts as contracts_api  # noqa: E402
from app.core.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    Clause,
    Contract,
    ContractStatus,
    ExtractedField,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent, AuditEventType  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402
from app.services.document_parser import (  # noqa: E402
    DocumentParseError,
    ParsedDocument,
    ParsedPage,
)
from app.services.extraction import ExtractionError  # noqa: E402
from app.services.storage import StoredDocument  # noqa: E402

_PG_IMAGE = "pgvector/pgvector:pg16"
_PDF_BYTES = b"%PDF-1.7\n% Whereas synthetic test PDF\n"
_INSTANCE_KEY = secrets.token_bytes(32)


def _docker_available() -> bool:
    if PostgresContainer is None:
        return False
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=5,
            check=False,
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
        ]
    else:
        engine = create_async_engine(_container_async_url(postgres_container), echo=False)
        tables = list(Base.metadata.sorted_tables)

    if engine.dialect.name == "sqlite":
        # SQLite has no native pgvector type. Compile clauses.embedding to a
        # BLOB so create_table succeeds on the in-memory test DB; we never
        # write a non-NULL embedding from the test path.
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


async def _create_user_org(
    session: AsyncSession,
    *,
    wrapped_key: bool = True,
    active: bool = True,
    email: str | None = None,
) -> UserOrg:
    org = Organization(
        id=uuid.uuid4(),
        name=f"Org {uuid.uuid4()}",
        wrapped_master_key=None,
    )
    if wrapped_key:
        org.wrapped_master_key = _wrapped_org_key(org.id)
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=email or f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Test User",
        is_active=active,
    )
    session.add_all([org, user])
    await session.commit()
    return UserOrg(org=org, user=user)


def _parsed_document(file_bytes: bytes = _PDF_BYTES, text: str = "Effective Date: 2026-05-06.") -> ParsedDocument:
    return ParsedDocument(
        full_text=text,
        pages=(ParsedPage(page_number=1, text=text, char_start=0, char_end=len(text), blocks=()),),
        page_count=1,
        content_hash=hashlib.sha256(file_bytes).hexdigest(),
    )


class FakeStorage:
    store_calls: list[dict[str, Any]]
    retrieve_calls: list[dict[str, Any]]
    retrieved_bytes: bytes = _PDF_BYTES

    def __init__(self, _settings: Any) -> None:
        self.__class__.store_calls = getattr(self.__class__, "store_calls", [])
        self.__class__.retrieve_calls = getattr(self.__class__, "retrieve_calls", [])

    async def store_encrypted(
        self,
        *,
        plaintext_bytes: bytes,
        document_id: str,
        org_master_key: bytes,
    ) -> StoredDocument:
        self.__class__.store_calls.append(
            {
                "plaintext_bytes": plaintext_bytes,
                "document_id": document_id,
                "org_master_key": org_master_key,
            }
        )
        return StoredDocument(
            s3_key=f"documents/{document_id}.enc",
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
                "org_master_key": org_master_key,
                "expected_blob_sha256": expected_blob_sha256,
            }
        )
        return self.__class__.retrieved_bytes


@pytest.fixture(autouse=True)
def patch_heavy_seams(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeStorage.store_calls = []
    FakeStorage.retrieve_calls = []
    FakeStorage.retrieved_bytes = _PDF_BYTES
    monkeypatch.setattr(contracts_api, "DocumentStorage", FakeStorage)
    monkeypatch.setattr(
        contracts_api,
        "parse_document",
        lambda file_bytes, filename: _parsed_document(file_bytes=file_bytes),
    )

    async def fake_extract(
        session: AsyncSession,
        *,
        contract: Contract,
        actor_user_id: uuid.UUID | None = None,
    ) -> list[ExtractedField]:
        field = ExtractedField(
            contract_id=contract.id,
            field_name="effective_date",
            value_json="2026-05-06",
            span_start=16,
            span_end=26,
            span_text="2026-05-06",
            confidence=0.95,
            model_name="test-model",
            prompt_version="test-v1",
        )
        session.add(field)
        await session.flush()
        return [field]

    monkeypatch.setattr(contracts_api, "extract_and_persist_metadata", fake_extract)


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


def _file_tuple(name: str = "contract.pdf", content: bytes = _PDF_BYTES, mime: str = "application/pdf") -> dict[str, tuple[str, bytes, str]]:
    return {"file": (name, content, mime)}


def _assert_no_secrets(payload: Any) -> None:
    text = str(payload)
    assert "s3_key" not in text
    assert "wrapped_dek" not in text
    assert "wrapped_master_key" not in text
    assert _INSTANCE_KEY.hex() not in text
    assert "org_master_key" not in text
    # Clause responses must not surface storage internals either.
    assert "embedding" not in text


async def test_upload_happy_path_persists_contract_fields_and_audit(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session)

    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
        data={"title": "Vendor MSA"},
    )

    assert response.status_code == 201
    body = response.json()
    _assert_no_secrets(body)
    assert body["title"] == "Vendor MSA"
    assert body["status"] == ContractStatus.READY.value
    assert body["mime_type"] == "application/pdf"
    assert body["file_hash_sha256"] == hashlib.sha256(_PDF_BYTES).hexdigest()
    assert body["page_count"] == 1
    assert body["extracted_fields"][0]["field_name"] == "effective_date"

    contract_id = uuid.UUID(body["id"])
    contract = await db_session.get(Contract, contract_id)
    assert contract is not None
    assert contract.s3_key == f"documents/{contract_id}.enc"
    assert contract.wrapped_dek == b"wrapped-dek"
    assert contract.full_text == "Effective Date: 2026-05-06."
    assert FakeStorage.store_calls[0]["document_id"] == str(contract_id)
    assert FakeStorage.store_calls[0]["plaintext_bytes"] == _PDF_BYTES

    audit_events = (
        await db_session.execute(
            select(AuditEvent).where(AuditEvent.event_type == AuditEventType.CONTRACT_UPLOADED.value)
        )
    ).scalars().all()
    assert len(audit_events) == 1
    assert audit_events[0].details["contract_id"] == str(contract_id)
    assert "wrapped_dek" not in str(audit_events[0].details)


async def test_missing_dev_user_header_returns_401(client: httpx.AsyncClient) -> None:
    response = await client.post("/api/contracts/upload", files=_file_tuple())
    assert response.status_code == 401


async def test_missing_and_inactive_users_are_rejected(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    missing_response = await client.post(
        "/api/contracts/upload",
        headers={"X-Whereas-Dev-User": str(uuid.uuid4())},
        files=_file_tuple(),
    )
    assert missing_response.status_code == 401

    user_org = await _create_user_org(db_session, active=False)
    inactive_response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    assert inactive_response.status_code == 403


async def test_missing_org_wrapped_master_key_returns_409_without_storage(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session, wrapped_key=False)

    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )

    assert response.status_code == 409
    assert FakeStorage.store_calls == []
    assert (await db_session.execute(select(Contract))).scalars().all() == []


async def test_duplicate_upload_same_org_rejected_but_other_org_allowed(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    first = await _create_user_org(db_session, email="first@example.com")
    second = await _create_user_org(db_session, email="second@example.com")
    first_headers = _headers(first.user)
    second_headers = _headers(second.user)

    first_response = await client.post(
        "/api/contracts/upload",
        headers=first_headers,
        files=_file_tuple(),
    )
    assert first_response.status_code == 201

    duplicate_response = await client.post(
        "/api/contracts/upload",
        headers=first_headers,
        files=_file_tuple(),
    )
    assert duplicate_response.status_code == 409
    assert duplicate_response.json()["detail"]["existing_contract_id"] == first_response.json()["id"]

    other_org_response = await client.post(
        "/api/contracts/upload",
        headers=second_headers,
        files=_file_tuple(),
    )
    assert other_org_response.status_code == 201


async def test_parser_failure_returns_400_and_persists_no_contract(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_org = await _create_user_org(db_session)

    def fail_parse(file_bytes: bytes, filename: str) -> ParsedDocument:
        raise DocumentParseError("parser failed")

    monkeypatch.setattr(contracts_api, "parse_document", fail_parse)

    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )

    assert response.status_code == 400
    assert (await db_session.execute(select(Contract))).scalars().all() == []
    assert FakeStorage.store_calls == []


async def test_extraction_failure_after_storage_persists_failed_contract(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_org = await _create_user_org(db_session)

    async def fail_extract(
        session: AsyncSession,
        *,
        contract: Contract,
        actor_user_id: uuid.UUID | None = None,
    ) -> list[ExtractedField]:
        raise ExtractionError("llm unavailable")

    monkeypatch.setattr(contracts_api, "extract_and_persist_metadata", fail_extract)

    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == ContractStatus.FAILED.value
    assert body["message"] == "metadata_extraction_failed"
    assert body["extracted_fields"] == []
    contract = await db_session.get(Contract, uuid.UUID(body["id"]))
    assert contract is not None
    assert contract.status == ContractStatus.FAILED.value
    assert contract.s3_key == f"documents/{body['id']}.enc"


async def test_list_endpoint_scopes_to_user_org(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    first = await _create_user_org(db_session, email="list-a@example.com")
    second = await _create_user_org(db_session, email="list-b@example.com")
    await client.post("/api/contracts/upload", headers=_headers(first.user), files=_file_tuple("a.pdf"))
    await client.post("/api/contracts/upload", headers=_headers(second.user), files=_file_tuple("b.pdf", b"%PDF-1.7\nother"))

    response = await client.get("/api/contracts", headers=_headers(first.user))

    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1
    assert rows[0]["file_hash_sha256"] == hashlib.sha256(_PDF_BYTES).hexdigest()
    _assert_no_secrets(rows)


async def test_detail_endpoint_scopes_to_user_org(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    first = await _create_user_org(db_session, email="detail-a@example.com")
    second = await _create_user_org(db_session, email="detail-b@example.com")
    own = await client.post("/api/contracts/upload", headers=_headers(first.user), files=_file_tuple())
    other = await client.post(
        "/api/contracts/upload",
        headers=_headers(second.user),
        files=_file_tuple("other.pdf", b"%PDF-1.7\nother"),
    )

    own_response = await client.get(f"/api/contracts/{own.json()['id']}", headers=_headers(first.user))
    assert own_response.status_code == 200
    assert own_response.json()["full_text"] == "Effective Date: 2026-05-06."
    assert own_response.json()["extracted_fields"][0]["field_name"] == "effective_date"
    _assert_no_secrets(own_response.json())

    other_response = await client.get(f"/api/contracts/{other.json()['id']}", headers=_headers(first.user))
    assert other_response.status_code == 404


async def test_download_returns_original_bytes_and_audits(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session)
    upload = await client.post("/api/contracts/upload", headers=_headers(user_org.user), files=_file_tuple())
    contract_id = upload.json()["id"]

    response = await client.get(f"/api/contracts/{contract_id}/download", headers=_headers(user_org.user))

    assert response.status_code == 200
    assert response.content == _PDF_BYTES
    assert response.headers["content-type"].startswith("application/pdf")
    assert "attachment;" in response.headers["content-disposition"]
    assert FakeStorage.retrieve_calls[0]["s3_key"] == f"documents/{contract_id}.enc"
    assert FakeStorage.retrieve_calls[0]["document_id"] == contract_id
    assert FakeStorage.retrieve_calls[0]["wrapped_dek_bytes"] == b"wrapped-dek"

    audit_events = (
        await db_session.execute(
            select(AuditEvent).where(AuditEvent.event_type == AuditEventType.CONTRACT_DOWNLOADED.value)
        )
    ).scalars().all()
    assert len(audit_events) == 1
    assert audit_events[0].details["contract_id"] == contract_id
    assert "wrapped_dek" not in str(audit_events[0].details)


async def test_download_missing_wrapped_dek_returns_409(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session)
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Legacy",
        status=ContractStatus.READY.value,
        s3_key="documents/legacy.enc",
        wrapped_dek=None,
        mime_type="application/pdf",
        file_hash_sha256="b" * 64,
        page_count=1,
        full_text="text",
    )
    db_session.add(contract)
    await db_session.commit()

    response = await client.get(f"/api/contracts/{contract.id}/download", headers=_headers(user_org.user))

    assert response.status_code == 409
    assert FakeStorage.retrieve_calls == []


async def test_rejects_unknown_file_type(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session)

    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple("bad.txt", b"hello", "text/plain"),
    )

    assert response.status_code == 400
    assert FakeStorage.store_calls == []


# --------------------------------------------------------------------------
# Clause integration: upload runs segmentation, detail/clauses endpoints
# return scrubbed clause responses, and segmentation failure is non-fatal.
# --------------------------------------------------------------------------


_CLAUSE_DOC_TEXT = (
    "1. Purpose. The Parties wish to explore a potential business "
    "relationship and may exchange Confidential Information for that "
    "purpose.\n\n"
    "2. Term. This Agreement remains in effect for twenty-four (24) months "
    "from the Effective Date.\n\n"
    "3. Confidentiality. Each Party shall hold the other Party's "
    "Confidential Information in strict confidence and use it only for the "
    "Purpose described above.\n\n"
    "4. Governing Law. This Agreement is governed by the laws of the State "
    "of Delaware, without regard to conflict of laws principles.\n"
)


async def test_upload_persists_clauses_and_returns_them(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy path: real segmenter runs against a small structured doc."""
    user_org = await _create_user_org(db_session)
    monkeypatch.setattr(
        contracts_api,
        "parse_document",
        lambda file_bytes, filename: _parsed_document(
            file_bytes=file_bytes, text=_CLAUSE_DOC_TEXT
        ),
    )

    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )

    assert response.status_code == 201
    body = response.json()
    _assert_no_secrets(body)
    clauses = body["clauses"]
    assert len(clauses) >= 2
    # Stable ordinals starting at 0.
    assert [c["ordinal"] for c in clauses] == list(range(len(clauses)))
    for clause in clauses:
        assert clause["segmentation_method"] == "heuristic_v1"
        # Span integrity: the returned text MUST equal full_text[s:e].
        assert _CLAUSE_DOC_TEXT[
            clause["span_start"]:clause["span_end"]
        ] == clause["text"]


async def test_detail_endpoint_returns_clauses_for_org(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_org = await _create_user_org(db_session)
    monkeypatch.setattr(
        contracts_api,
        "parse_document",
        lambda file_bytes, filename: _parsed_document(
            file_bytes=file_bytes, text=_CLAUSE_DOC_TEXT
        ),
    )
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = upload.json()["id"]

    detail = await client.get(
        f"/api/contracts/{contract_id}",
        headers=_headers(user_org.user),
    )

    assert detail.status_code == 200
    body = detail.json()
    _assert_no_secrets(body)
    assert "clauses" in body
    assert len(body["clauses"]) >= 1
    # Detail also includes full_text and extracted_fields as before.
    assert "full_text" in body
    assert "extracted_fields" in body


async def test_separate_clauses_endpoint_scopes_to_user_org(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        contracts_api,
        "parse_document",
        lambda file_bytes, filename: _parsed_document(
            file_bytes=file_bytes, text=_CLAUSE_DOC_TEXT
        ),
    )
    first = await _create_user_org(db_session, email="cl-a@example.com")
    second = await _create_user_org(db_session, email="cl-b@example.com")
    own = await client.post(
        "/api/contracts/upload",
        headers=_headers(first.user),
        files=_file_tuple(),
    )
    other = await client.post(
        "/api/contracts/upload",
        headers=_headers(second.user),
        files=_file_tuple("other.pdf", b"%PDF-1.7\nother"),
    )

    own_response = await client.get(
        f"/api/contracts/{own.json()['id']}/clauses",
        headers=_headers(first.user),
    )
    assert own_response.status_code == 200
    own_clauses = own_response.json()
    assert isinstance(own_clauses, list)
    _assert_no_secrets(own_clauses)
    if own_clauses:
        assert all(
            c["contract_id"] == own.json()["id"] for c in own_clauses
        )

    forbidden = await client.get(
        f"/api/contracts/{other.json()['id']}/clauses",
        headers=_headers(first.user),
    )
    assert forbidden.status_code == 404


async def test_clauses_endpoint_requires_dev_user(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session)
    # Upload one contract to have a target id; missing-header request goes
    # against the same id but without auth.
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = upload.json()["id"]

    no_header = await client.get(f"/api/contracts/{contract_id}/clauses")
    assert no_header.status_code == 401

    bad_uuid = await client.get(
        f"/api/contracts/{contract_id}/clauses",
        headers={"X-Whereas-Dev-User": "not-a-uuid"},
    )
    assert bad_uuid.status_code == 401


async def test_clause_segmentation_failure_does_not_destroy_upload(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A segmentation crash MUST NOT take the upload down with it."""
    user_org = await _create_user_org(db_session)

    async def boom(session: Any, contract: Any, *, force: bool = False) -> Any:
        raise RuntimeError("segmenter exploded")

    monkeypatch.setattr(contracts_api, "segment_and_persist_clauses", boom)

    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )

    assert response.status_code == 201
    body = response.json()
    # Contract was still persisted and metadata still extracted.
    assert body["status"] == ContractStatus.READY.value
    assert body["clauses"] == []
    contract_id = body["id"]

    detail = await client.get(
        f"/api/contracts/{contract_id}",
        headers=_headers(user_org.user),
    )
    assert detail.status_code == 200
    assert detail.json()["clauses"] == []

    listing = await client.get("/api/contracts", headers=_headers(user_org.user))
    assert listing.status_code == 200
    assert any(c["id"] == contract_id for c in listing.json())
