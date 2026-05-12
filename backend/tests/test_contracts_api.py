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
    ContractArtifact,
    ContractMarkdownSnapshot,
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
from app.services.document_preview import PreviewResult  # noqa: E402
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
            ContractMarkdownSnapshot.__table__,
            ContractArtifact.__table__,
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


async def test_duplicate_upload_same_org_warns_but_does_not_block(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """PR #66 — exact-hash duplicates are warning-only.

    The Repository upload route used to 409 on a same-org hash match.
    The new policy returns 201 plus a ``duplicate_candidates`` list
    pointing at the existing contract so the UI can warn the user
    without blocking the upload. Cross-org uploads still succeed and
    must NOT see other orgs' rows on their candidate list.
    """
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
    assert duplicate_response.status_code == 201, duplicate_response.text
    body = duplicate_response.json()
    candidates = body["duplicate_candidates"]
    assert len(candidates) >= 1
    # The pre-existing contract appears as an exact-hash candidate;
    # the upload-in-progress is excluded from its own candidate list.
    first_id = first_response.json()["id"]
    new_id = body["id"]
    assert any(c["contract_id"] == first_id for c in candidates)
    assert all(c["contract_id"] != new_id for c in candidates)
    assert all(c["reason"] == "exact_file_hash" for c in candidates)
    assert all(c["confidence"] == "exact" for c in candidates)
    # Storage internals never reach the response.
    body_text = duplicate_response.text
    assert "storage_key" not in body_text
    assert "wrapped_dek" not in body_text

    other_org_response = await client.post(
        "/api/contracts/upload",
        headers=second_headers,
        files=_file_tuple(),
    )
    assert other_org_response.status_code == 201
    # Cross-org uploads never see the first org's matching row.
    assert other_org_response.json()["duplicate_candidates"] == []


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


# --------------------------------------------------------------------------
# PR #95 — Repository search (?q=…)
# --------------------------------------------------------------------------


async def _upload_with_title(
    client: httpx.AsyncClient,
    user_org: UserOrg,
    *,
    title: str,
    filename: str,
    content: bytes,
) -> str:
    """Upload a contract with an explicit title; return its id."""
    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(filename, content),
        data={"title": title},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def test_list_q_filters_by_case_insensitive_title_substring(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """``?q=foo`` returns only the rows whose title contains ``foo``
    (case-insensitive substring)."""
    user_org = await _create_user_org(db_session, email="q-1@example.com")
    nda_id = await _upload_with_title(
        client,
        user_org,
        title="Acme NDA — mutual",
        filename="nda.pdf",
        content=b"%PDF-1.4\nA",
    )
    msa_id = await _upload_with_title(
        client,
        user_org,
        title="WidgetWorks MSA",
        filename="msa.pdf",
        content=b"%PDF-1.4\nB",
    )
    await _upload_with_title(
        client,
        user_org,
        title="Vendor DPA",
        filename="dpa.pdf",
        content=b"%PDF-1.4\nC",
    )

    # case-insensitive substring on "nda"
    response = await client.get(
        "/api/contracts?q=nda",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200, response.text
    ids = [row["id"] for row in response.json()]
    assert ids == [nda_id]

    # "MSA" upper-case still hits the lower-cased pattern
    response = await client.get(
        "/api/contracts?q=MSA",
        headers=_headers(user_org.user),
    )
    assert [row["id"] for row in response.json()] == [msa_id]

    # whitespace-only q is treated as no filter (full list back)
    response = await client.get(
        "/api/contracts?q=%20%20",
        headers=_headers(user_org.user),
    )
    assert len(response.json()) == 3


async def test_list_q_does_not_cross_organizations(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A matching title in another org never bleeds into this org's
    search results, even when the caller's own contracts don't match."""
    first = await _create_user_org(db_session, email="q-x@example.com")
    second = await _create_user_org(db_session, email="q-y@example.com")
    await _upload_with_title(
        client,
        first,
        title="OnlyOnFirstOrg",
        filename="one.pdf",
        content=b"%PDF-1.4\nX",
    )
    await _upload_with_title(
        client,
        second,
        title="OnlyOnFirstOrg",  # same title, different org
        filename="two.pdf",
        content=b"%PDF-1.4\nY",
    )

    response = await client.get(
        "/api/contracts?q=OnlyOnFirstOrg",
        headers=_headers(first.user),
    )
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1
    # The matching row is the one owned by ``first``.
    assert rows[0]["file_hash_sha256"] == hashlib.sha256(
        b"%PDF-1.4\nX"
    ).hexdigest()


async def test_list_q_respects_include_merged_default(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A merged Repository record is hidden from ``q`` results by
    default, the same as the unfiltered list. ``include_merged=true``
    surfaces it back."""
    from datetime import UTC, datetime

    user_org = await _create_user_org(db_session, email="q-merge@example.com")
    canonical_id = await _upload_with_title(
        client,
        user_org,
        title="MergeCanonical",
        filename="canon.pdf",
        content=b"%PDF-1.4\nC",
    )
    duplicate_id = await _upload_with_title(
        client,
        user_org,
        title="MergeDuplicate",
        filename="dup.pdf",
        content=b"%PDF-1.4\nD",
    )

    # Mark the duplicate as merged into the canonical — this is what
    # the PR #76 service does in production. We do it directly here
    # rather than calling the merge route to keep this test focused on
    # the q-filter / include_merged interaction.
    duplicate = await db_session.get(Contract, uuid.UUID(duplicate_id))
    assert duplicate is not None
    duplicate.merged_into_contract_id = uuid.UUID(canonical_id)
    duplicate.merged_at = datetime.now(tz=UTC)
    await db_session.commit()

    # Default: merged hidden, even on a q match.
    response = await client.get(
        "/api/contracts?q=Merge",
        headers=_headers(user_org.user),
    )
    ids = [row["id"] for row in response.json()]
    assert ids == [canonical_id]

    # include_merged=true: both surface.
    response = await client.get(
        "/api/contracts?q=Merge&include_merged=true",
        headers=_headers(user_org.user),
    )
    ids = sorted(row["id"] for row in response.json())
    assert ids == sorted([canonical_id, duplicate_id])


async def test_list_q_does_not_match_storage_internals_or_metadata(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The q filter is strictly a title substring — it must not match
    on ``s3_key``, ``wrapped_dek`` bytes, ``file_hash_sha256``, or
    any other storage / hash metadata."""
    user_org = await _create_user_org(db_session, email="q-safe@example.com")
    contract_id = await _upload_with_title(
        client,
        user_org,
        title="SafeTitle",
        filename="x.pdf",
        content=b"%PDF-1.4\nZ",
    )
    contract = await db_session.get(Contract, uuid.UUID(contract_id))
    assert contract is not None
    # The s3_key for this contract is ``documents/{id}.enc`` — i.e.
    # the id appears verbatim in the storage key. q on that id
    # fragment must NOT return the row (only the title is searched).
    s3_id_fragment = contract.s3_key.replace("documents/", "").replace(".enc", "")
    response = await client.get(
        f"/api/contracts?q={s3_id_fragment[:8]}",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    ids = [row["id"] for row in response.json()]
    # The id substring isn't in the title, so this should be empty.
    assert ids == []
    # And the response never includes storage internals regardless.
    _assert_no_secrets(response.json())


async def test_list_q_escapes_sql_wildcards(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A user query containing ``%`` should be matched literally, not
    treated as the SQL LIKE wildcard."""
    user_org = await _create_user_org(db_session, email="q-esc@example.com")
    a = await _upload_with_title(
        client,
        user_org,
        title="50% discount agreement",
        filename="a.pdf",
        content=b"%PDF-1.4\nA",
    )
    await _upload_with_title(
        client,
        user_org,
        title="No discount agreement",
        filename="b.pdf",
        content=b"%PDF-1.4\nB",
    )

    response = await client.get(
        "/api/contracts?q=50%25%20discount",  # 50% discount URL-encoded
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    ids = [row["id"] for row in response.json()]
    assert ids == [a]


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


# --------------------------------------------------------------------------
# Markdown working snapshot
# --------------------------------------------------------------------------


def _install_fake_markitdown(
    monkeypatch: pytest.MonkeyPatch, text_content: str
) -> None:
    """Install a fake ``markitdown`` module so the service imports it."""
    import sys
    import types

    class FakeConversionResult:
        def __init__(self, text: str) -> None:
            self.text_content = text

    class FakeMarkItDown:
        def convert(self, _path: str) -> Any:
            return FakeConversionResult(text_content)

    fake_module = types.ModuleType("markitdown")
    fake_module.MarkItDown = FakeMarkItDown  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "markitdown", fake_module)


def _disable_markitdown(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force the service down the fallback path by killing the import."""
    import sys

    monkeypatch.setitem(sys.modules, "markitdown", None)


async def test_upload_persists_markdown_snapshot_via_markitdown(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_markitdown(monkeypatch, "# MSA\n\nEffective Date: 2026-05-08.")
    user_org = await _create_user_org(db_session)

    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
        data={"title": "Vendor MSA"},
    )
    assert response.status_code == 201
    contract_id = uuid.UUID(response.json()["id"])

    snaps = (
        await db_session.execute(
            select(ContractMarkdownSnapshot).where(
                ContractMarkdownSnapshot.contract_id == contract_id
            )
        )
    ).scalars().all()
    assert len(snaps) == 1
    snap = snaps[0]
    assert snap.converter_name == "markitdown"
    assert snap.conversion_status == "ready"
    assert snap.markdown_text.startswith("# MSA")
    assert snap.organization_id == user_org.org.id
    assert snap.source_kind == "original_upload"
    assert snap.created_by == user_org.user.id


async def test_upload_uses_fallback_plain_text_when_markitdown_missing(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _disable_markitdown(monkeypatch)
    user_org = await _create_user_org(db_session)

    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    assert response.status_code == 201
    contract_id = uuid.UUID(response.json()["id"])

    snap = (
        await db_session.execute(
            select(ContractMarkdownSnapshot).where(
                ContractMarkdownSnapshot.contract_id == contract_id
            )
        )
    ).scalar_one_or_none()
    assert snap is not None
    assert snap.converter_name == "fallback_plain_text"
    assert snap.conversion_status == "ready"
    assert "Effective Date" in snap.markdown_text


async def test_markdown_conversion_failure_does_not_destroy_upload(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A markdown conversion crash MUST NOT take the upload down with it."""
    from app.services import document_markdown as md_service

    async def boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("markdown service exploded")

    monkeypatch.setattr(
        contracts_api, "create_markdown_snapshot_for_contract", boom
    )
    _ = md_service  # silence "imported but unused" if linter inspects

    user_org = await _create_user_org(db_session)
    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == ContractStatus.READY.value


async def test_get_markdown_returns_latest_snapshot(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_markitdown(monkeypatch, "# v1")
    user_org = await _create_user_org(db_session)

    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    assert upload.status_code == 201
    contract_id = upload.json()["id"]

    # Append a newer snapshot directly to verify "latest by created_at desc".
    # SQLite's now() resolves to seconds, so set an explicit later timestamp
    # to make the ordering deterministic on fast machines.
    from datetime import UTC, datetime, timedelta

    newer = ContractMarkdownSnapshot(
        contract_id=uuid.UUID(contract_id),
        organization_id=user_org.org.id,
        markdown_text="# v2 newer",
        source_kind="manual_edit",
        converter_name="markitdown",
        conversion_status="ready",
        created_at=datetime.now(UTC) + timedelta(minutes=1),
    )
    db_session.add(newer)
    await db_session.commit()

    response = await client.get(
        f"/api/contracts/{contract_id}/markdown",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["contract_id"] == contract_id
    assert body["markdown_text"] == "# v2 newer"
    assert body["source_kind"] == "manual_edit"
    assert body["conversion_status"] == "ready"
    _assert_no_secrets(body)


async def test_get_markdown_returns_404_when_no_snapshot(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _disable_markitdown(monkeypatch)
    # Strip the parser's full_text so the fallback also has nothing to wrap.
    monkeypatch.setattr(
        contracts_api,
        "parse_document",
        lambda file_bytes, filename: ParsedDocument(
            full_text="",
            pages=(
                ParsedPage(
                    page_number=1,
                    text="",
                    char_start=0,
                    char_end=0,
                    blocks=(),
                ),
            ),
            page_count=1,
            content_hash="0" * 64,
        ),
    )

    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    assert upload.status_code == 201
    contract_id = upload.json()["id"]

    response = await client.get(
        f"/api/contracts/{contract_id}/markdown",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 404


async def test_get_markdown_is_org_scoped(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_markitdown(monkeypatch, "# Sensitive")
    owner = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(owner.user),
        files=_file_tuple(),
    )
    assert upload.status_code == 201
    contract_id = upload.json()["id"]

    other_org_user = await _create_user_org(db_session)
    cross = await client.get(
        f"/api/contracts/{contract_id}/markdown",
        headers=_headers(other_org_user.user),
    )
    # Cross-org access must look like "not found" — never leak existence.
    assert cross.status_code == 404


async def test_get_markdown_requires_dev_user_header(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get(f"/api/contracts/{uuid.uuid4()}/markdown")
    assert response.status_code == 401


async def test_get_markdown_skips_failed_snapshots(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session)
    contract = Contract(
        organization_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Manual",
        status=ContractStatus.READY.value,
        s3_key="documents/manual.enc",
        mime_type="application/pdf",
        file_hash_sha256="b" * 64,
        page_count=1,
        full_text="manual",
    )
    db_session.add(contract)
    await db_session.flush()

    failed = ContractMarkdownSnapshot(
        contract_id=contract.id,
        organization_id=user_org.org.id,
        markdown_text="",
        source_kind="original_upload",
        converter_name="none",
        conversion_status="failed",
    )
    db_session.add(failed)
    await db_session.commit()

    response = await client.get(
        f"/api/contracts/{contract.id}/markdown",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 404


# --------------------------------------------------------------------------
# Contract artifacts
# --------------------------------------------------------------------------


async def test_upload_creates_original_upload_artifact(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session)

    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(name="vendor.pdf"),
        data={"title": "Vendor MSA"},
    )
    assert upload.status_code == 201
    contract_id = uuid.UUID(upload.json()["id"])

    rows = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    artifact = rows[0]
    assert artifact.artifact_type == "original_upload"
    assert artifact.is_official is True
    assert artifact.source == "user_upload"
    assert artifact.storage_backend == "s3"
    assert artifact.storage_key == f"documents/{contract_id}.enc"
    assert artifact.filename == "vendor.pdf"
    assert artifact.mime_type == "application/pdf"
    assert artifact.file_hash_sha256 == hashlib.sha256(_PDF_BYTES).hexdigest()
    assert artifact.size_bytes == len(_PDF_BYTES)
    assert artifact.organization_id == user_org.org.id
    assert artifact.created_by == user_org.user.id


async def test_list_artifacts_returns_metadata_for_org(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(name="vendor.pdf"),
    )
    contract_id = upload.json()["id"]

    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1
    row = rows[0]
    assert row["artifact_type"] == "original_upload"
    assert row["is_official"] is True
    assert row["filename"] == "vendor.pdf"
    assert row["mime_type"] == "application/pdf"
    assert row["source"] == "user_upload"
    assert row["storage_backend"] == "s3"
    # Listing is metadata-only — never expose the raw object key.
    assert "storage_key" not in row
    _assert_no_secrets(rows)


async def test_list_artifacts_orders_newest_first(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    from datetime import UTC, datetime, timedelta

    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])

    later = ContractArtifact(
        organization_id=user_org.org.id,
        contract_id=contract_id,
        artifact_type="signed_pdf",
        storage_backend="s3",
        storage_key=f"documents/{contract_id}.signed.enc",
        filename="signed.pdf",
        mime_type="application/pdf",
        is_official=True,
        source="docuseal",
        created_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    db_session.add(later)
    await db_session.commit()

    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    rows = response.json()
    assert [r["artifact_type"] for r in rows] == [
        "signed_pdf",
        "original_upload",
    ]


async def test_list_artifacts_cross_org_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    owner = await _create_user_org(db_session, email="art-a@example.com")
    other = await _create_user_org(db_session, email="art-b@example.com")
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(owner.user),
        files=_file_tuple(),
    )
    contract_id = upload.json()["id"]

    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts",
        headers=_headers(other.user),
    )
    assert response.status_code == 404


async def test_list_artifacts_requires_dev_user_header(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get(f"/api/contracts/{uuid.uuid4()}/artifacts")
    assert response.status_code == 401


# --------------------------------------------------------------------------
# Artifact-backed download (PR #35)
# --------------------------------------------------------------------------


async def test_download_uses_artifact_storage_key_and_filename(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A fresh upload routes the download through its original_upload artifact.

    The artifact carries the user-supplied filename (``vendor.pdf``)
    while the contract title is human-friendly (``Vendor MSA``); the
    Content-Disposition should reflect the artifact's filename.
    """
    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(name="vendor.pdf"),
        data={"title": "Vendor MSA"},
    )
    contract_id = upload.json()["id"]

    response = await client.get(
        f"/api/contracts/{contract_id}/download",
        headers=_headers(user_org.user),
    )

    assert response.status_code == 200
    # Storage retrieval used the artifact's storage_key (same value as
    # the legacy contract.s3_key on a fresh upload — but the resolution
    # path went through the artifact).
    assert (
        FakeStorage.retrieve_calls[0]["s3_key"]
        == f"documents/{contract_id}.enc"
    )
    # Filename comes from the artifact, not the contract title.
    assert "vendor.pdf" in response.headers["content-disposition"]

    audit_events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.event_type
                == AuditEventType.CONTRACT_DOWNLOADED.value
            )
        )
    ).scalars().all()
    assert len(audit_events) == 1
    details = audit_events[0].details
    assert details["filename"] == "vendor.pdf"
    assert "artifact_id" in details
    assert "wrapped_dek" not in str(details)
    assert "storage_key" not in str(details)


async def test_download_falls_back_to_legacy_contract_fields(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A contract without any ContractArtifact rows still downloads.

    Mirrors the pre-PR-#34 state: the contract row carries the storage
    pointer, no artifact has been backfilled. The download endpoint
    must keep working without the artifact.
    """
    user_org = await _create_user_org(db_session)
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Legacy MSA",
        status=ContractStatus.READY.value,
        s3_key="documents/legacy.enc",
        wrapped_dek=b"wrapped-dek",
        mime_type="application/pdf",
        file_hash_sha256="c" * 64,
        page_count=1,
        full_text="text",
    )
    db_session.add(contract)
    await db_session.commit()

    response = await client.get(
        f"/api/contracts/{contract.id}/download",
        headers=_headers(user_org.user),
    )

    assert response.status_code == 200
    assert (
        FakeStorage.retrieve_calls[0]["s3_key"] == "documents/legacy.enc"
    )
    # No artifact filename available; fall back to the contract title.
    assert "Legacy_MSA" in response.headers["content-disposition"]


async def test_download_prefers_latest_official_artifact(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """When multiple original_upload artifacts exist, the newest official wins."""
    from datetime import UTC, datetime, timedelta

    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(name="vendor.pdf"),
    )
    contract_id = uuid.UUID(upload.json()["id"])

    # Append a newer official original_upload pointing at a different
    # storage_key. The download must follow the new artifact.
    newer = ContractArtifact(
        organization_id=user_org.org.id,
        contract_id=contract_id,
        artifact_type="original_upload",
        storage_backend="s3",
        storage_key=f"documents/{contract_id}.v2.enc",
        filename="vendor-v2.pdf",
        mime_type="application/pdf",
        is_official=True,
        source="user_upload",
        created_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    db_session.add(newer)
    await db_session.commit()

    response = await client.get(
        f"/api/contracts/{contract_id}/download",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    assert (
        FakeStorage.retrieve_calls[0]["s3_key"]
        == f"documents/{contract_id}.v2.enc"
    )
    assert "vendor-v2.pdf" in response.headers["content-disposition"]


async def test_download_cross_org_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    owner = await _create_user_org(db_session, email="dl-a@example.com")
    other = await _create_user_org(db_session, email="dl-b@example.com")
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(owner.user),
        files=_file_tuple(),
    )
    contract_id = upload.json()["id"]

    response = await client.get(
        f"/api/contracts/{contract_id}/download",
        headers=_headers(other.user),
    )
    assert response.status_code == 404
    assert FakeStorage.retrieve_calls == []


# --------------------------------------------------------------------------
# Per-artifact download (PR #70)
#
# The Document History view now exposes a "Download version" action that
# fetches a specific ContractArtifact rather than the current
# priority-winning document. These tests cover the new
# ``/{contract_id}/artifacts/{artifact_id}/download`` endpoint:
# org/contract scoping, each artifact_type, missing-storage handling,
# headers, response-body secret scrubbing, and the new audit event.
# Existing default-download tests above continue to verify that
# ``/{contract_id}/download`` still uses signed_pdf > generated_docx >
# original_upload > legacy ``Contract.s3_key`` (unchanged by PR #70).
# --------------------------------------------------------------------------


def _add_artifact(
    db_session: AsyncSession,
    *,
    user_org: UserOrg,
    contract_id: uuid.UUID,
    artifact_type: str,
    storage_key: str,
    filename: str,
    mime_type: str = "application/pdf",
    wrapped_dek: bytes | None = None,
    is_official: bool = True,
    source: str | None = "user_upload",
) -> ContractArtifact:
    artifact = ContractArtifact(
        organization_id=user_org.org.id,
        contract_id=contract_id,
        artifact_type=artifact_type,
        storage_backend="s3",
        storage_key=storage_key,
        wrapped_dek=wrapped_dek,
        filename=filename,
        mime_type=mime_type,
        is_official=is_official,
        source=source,
    )
    db_session.add(artifact)
    return artifact


async def test_artifact_download_original_upload_succeeds_and_audits(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Per-artifact download for the original upload returns the file
    and writes a dedicated ``contract.artifact_downloaded`` audit
    entry distinct from the contract-level ``contract.downloaded``."""
    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(name="vendor.pdf"),
        data={"title": "Vendor MSA"},
    )
    contract_id = uuid.UUID(upload.json()["id"])
    artifact_row = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id,
                ContractArtifact.artifact_type == "original_upload",
            )
        )
    ).scalar_one()

    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{artifact_row.id}/download",
        headers=_headers(user_org.user),
    )

    assert response.status_code == 200
    assert response.content == _PDF_BYTES
    assert response.headers["content-type"].startswith("application/pdf")
    assert "vendor.pdf" in response.headers["content-disposition"]
    # No storage internals leaked in headers.
    assert "storage_key" not in {k.lower() for k in response.headers}
    assert "wrapped_dek" not in {k.lower() for k in response.headers}
    # Storage retrieval used the artifact's storage_key.
    assert (
        FakeStorage.retrieve_calls[-1]["s3_key"]
        == f"documents/{contract_id}.enc"
    )

    artifact_events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.event_type
                == AuditEventType.CONTRACT_ARTIFACT_DOWNLOADED.value
            )
        )
    ).scalars().all()
    assert len(artifact_events) == 1
    details = artifact_events[0].details
    assert details["contract_id"] == str(contract_id)
    assert details["artifact_id"] == str(artifact_row.id)
    assert details["artifact_type"] == "original_upload"
    assert details["filename"] == "vendor.pdf"
    assert "wrapped_dek" not in str(details)
    assert "storage_key" not in str(details)


async def test_artifact_download_generated_docx_succeeds(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])

    generated = _add_artifact(
        db_session,
        user_org=user_org,
        contract_id=contract_id,
        artifact_type="generated_docx",
        storage_key=f"documents/{contract_id}.docx.enc",
        filename="acme-nda.docx",
        mime_type=(
            "application/vnd.openxmlformats-officedocument."
            "wordprocessingml.document"
        ),
        source="template_generation",
    )
    await db_session.commit()

    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{generated.id}/download",
        headers=_headers(user_org.user),
    )

    assert response.status_code == 200
    assert response.content == _PDF_BYTES  # FakeStorage returns canned bytes
    assert "acme-nda.docx" in response.headers["content-disposition"]
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    assert (
        FakeStorage.retrieve_calls[-1]["s3_key"]
        == f"documents/{contract_id}.docx.enc"
    )


async def test_artifact_download_signed_pdf_uses_artifact_dek_and_filename(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """A ``signed_pdf`` artifact carries its own wrapped DEK (PR #45)
    and a derived storage key. The download must pass the artifact's
    DEK to the storage layer, not fall back to ``contract.wrapped_dek``,
    and the AAD must be derived from the artifact storage key."""
    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])

    # A separate document_id baked into the signed-PDF storage key so
    # the AAD path resolves it via ``_document_id_from_storage_key``.
    signed_doc_id = uuid.uuid4()
    signed = _add_artifact(
        db_session,
        user_org=user_org,
        contract_id=contract_id,
        artifact_type="signed_pdf",
        storage_key=f"documents/{signed_doc_id}.enc",
        filename="executed.pdf",
        wrapped_dek=b"signed-wrapped-dek",
        source="docuseal",
    )
    await db_session.commit()

    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{signed.id}/download",
        headers=_headers(user_org.user),
    )

    assert response.status_code == 200
    assert "executed.pdf" in response.headers["content-disposition"]
    last = FakeStorage.retrieve_calls[-1]
    assert last["s3_key"] == f"documents/{signed_doc_id}.enc"
    assert last["wrapped_dek_bytes"] == b"signed-wrapped-dek"
    # AAD must be the artifact's document id, not the contract id.
    assert last["document_id"] == str(signed_doc_id)


async def test_artifact_download_cross_org_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    owner = await _create_user_org(db_session, email="art-dl-a@example.com")
    other = await _create_user_org(db_session, email="art-dl-b@example.com")
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(owner.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])
    artifact_row = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id
            )
        )
    ).scalar_one()

    before = list(FakeStorage.retrieve_calls)
    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{artifact_row.id}/download",
        headers=_headers(other.user),
    )
    assert response.status_code == 404
    assert FakeStorage.retrieve_calls == before


async def test_artifact_download_wrong_contract_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An artifact id belonging to another contract in the same org is
    still 404 — the path's ``contract_id`` and the artifact's
    ``contract_id`` must match."""
    user_org = await _create_user_org(db_session)
    first = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(name="a.pdf"),
    )
    second = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(name="b.pdf", content=b"%PDF-1.7\nB"),
    )
    second_id = uuid.UUID(second.json()["id"])
    second_artifact = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == second_id
            )
        )
    ).scalar_one()
    first_id = first.json()["id"]

    before = list(FakeStorage.retrieve_calls)
    response = await client.get(
        f"/api/contracts/{first_id}/artifacts/{second_artifact.id}/download",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 404
    assert FakeStorage.retrieve_calls == before


async def test_artifact_download_missing_artifact_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = upload.json()["id"]

    before = list(FakeStorage.retrieve_calls)
    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{uuid.uuid4()}/download",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 404
    assert FakeStorage.retrieve_calls == before


async def test_artifact_download_missing_storage_metadata_returns_409(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """An artifact with no ``storage_key`` is unretrievable. The
    endpoint must surface 409 rather than try to fetch a blob or fall
    back to the contract record."""
    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])

    orphan = _add_artifact(
        db_session,
        user_org=user_org,
        contract_id=contract_id,
        artifact_type="attachment",
        storage_key="",  # intentionally empty
        filename="orphan.pdf",
        source=None,
        is_official=False,
    )
    await db_session.commit()

    before = list(FakeStorage.retrieve_calls)
    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{orphan.id}/download",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 409
    assert FakeStorage.retrieve_calls == before


async def test_artifact_download_response_does_not_expose_storage_internals(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The response body is the decrypted file bytes; storage_key and
    wrapped_dek must never appear in headers or the body."""
    user_org = await _create_user_org(db_session)
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])
    artifact_row = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id
            )
        )
    ).scalar_one()

    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{artifact_row.id}/download",
        headers=_headers(user_org.user),
    )

    assert response.status_code == 200
    blob = response.content
    assert b"storage_key" not in blob
    assert b"wrapped_dek" not in blob
    header_text = "\n".join(
        f"{k}:{v}" for k, v in response.headers.items()
    )
    assert "storage_key" not in header_text
    assert "wrapped_dek" not in header_text



async def test_artifact_preview_pdf_inline_success(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session, email="preview-owner@example.com")
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(name="signed.pdf"),
    )
    contract_id = uuid.UUID(upload.json()["id"])
    artifact_row = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id,
                ContractArtifact.artifact_type == "original_upload",
            )
        )
    ).scalar_one()

    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{artifact_row.id}/preview",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/pdf")
    assert response.headers["content-disposition"].startswith("inline;")
    assert "signed.pdf" in response.headers["content-disposition"]
    assert response.content == _PDF_BYTES
    assert response.text != ""
    assert "storage_key" not in response.text
    assert "wrapped_dek" not in response.text
    assert "s3_key" not in response.text
    assert "presigned" not in response.text.lower()
    assert "metadata_json" not in response.text
    event = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.event_type
                == AuditEventType.CONTRACT_ARTIFACT_PREVIEWED.value
            )
        )
    ).scalar_one()
    # The audit details schema was widened in PR #73 (DOCX preview)
    # to record the source MIME type plus how the PDF preview was
    # produced ("pdf" = inline PDF bytes were already PDF;
    # "docx" = converted via LibreOffice). The DOCX preview test
    # exercises the converted path; this test pins the inline-PDF
    # path. Storage internals are still asserted absent below.
    assert event.details == {
        "contract_id": str(contract_id),
        "artifact_id": str(artifact_row.id),
        "artifact_type": "original_upload",
        "filename": "signed.pdf",
        "mime_type": "application/pdf",
        "preview_format": "pdf",
        "conversion_source": "pdf",
    }
    # Belt-and-braces: even the audit details must not carry storage
    # internals. ``record_event`` rejects unknown keys at write time;
    # this is the regression net.
    for forbidden in ("storage_key", "wrapped_dek", "s3_key", "metadata_json"):
        assert forbidden not in event.details


async def test_artifact_preview_docx_success(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_org = await _create_user_org(db_session, email="preview-docx-success@example.com")
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])

    generated = _add_artifact(
        db_session,
        user_org=user_org,
        contract_id=contract_id,
        artifact_type="generated_docx",
        storage_key=f"documents/{contract_id}.docx.enc",
        filename="draft.docx",
        mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        source="template_generation",
    )
    await db_session.commit()

    def _fake_convert(content: bytes, mime_type: str, *, timeout_seconds: int = 20) -> PreviewResult:
        assert mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        return PreviewResult(pdf_bytes=b"%PDF-1.7\nDOCX PREVIEW\n", conversion_source="docx")

    from app.api import contracts as contracts_module
    monkeypatch.setattr(contracts_module, "convert_to_pdf_preview", _fake_convert)

    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{generated.id}/preview",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/pdf")
    assert response.headers["content-disposition"].startswith("inline;")
    assert "draft.pdf" in response.headers["content-disposition"]
    assert response.content == b"%PDF-1.7\nDOCX PREVIEW\n"
    preview_event = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.event_type == AuditEventType.CONTRACT_ARTIFACT_PREVIEWED.value
            )
        )
    ).scalar_one()
    assert preview_event.details["conversion_source"] == "docx"


async def test_artifact_preview_unsupported_type_returns_415(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session, email="preview-unsupported@example.com")
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])
    attachment = _add_artifact(
        db_session,
        user_org=user_org,
        contract_id=contract_id,
        artifact_type="attachment",
        storage_key=f"documents/{contract_id}.txt.enc",
        filename="notes.txt",
        mime_type="text/plain",
        source=None,
    )
    await db_session.commit()
    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{attachment.id}/preview",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 415
    assert response.json()["detail"] == "Unsupported file type for preview."


async def test_artifact_preview_missing_artifact_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session, email="preview-missing-art@example.com")
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = upload.json()["id"]
    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{uuid.uuid4()}/preview",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 404


async def test_artifact_preview_wrong_contract_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session, email="preview-wrong-contract@example.com")
    first = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(name="first.pdf"),
    )
    second = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(name="second.pdf", content=b"%PDF-1.7\nSECOND"),
    )
    second_id = uuid.UUID(second.json()["id"])
    second_artifact = (
        await db_session.execute(
            select(ContractArtifact).where(ContractArtifact.contract_id == second_id)
        )
    ).scalar_one()
    response = await client.get(
        f"/api/contracts/{first.json()['id']}/artifacts/{second_artifact.id}/preview",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 404


async def test_artifact_preview_cross_org_contract_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    owner = await _create_user_org(db_session, email="preview-owner-a@example.com")
    other = await _create_user_org(db_session, email="preview-owner-b@example.com")
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(owner.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])
    artifact_row = (
        await db_session.execute(
            select(ContractArtifact).where(ContractArtifact.contract_id == contract_id)
        )
    ).scalar_one()
    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{artifact_row.id}/preview",
        headers=_headers(other.user),
    )
    assert response.status_code == 404


async def test_artifact_preview_cross_org_artifact_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    org_a = await _create_user_org(db_session, email="preview-art-org-a@example.com")
    org_b = await _create_user_org(db_session, email="preview-art-org-b@example.com")
    upload_a = await client.post(
        "/api/contracts/upload",
        headers=_headers(org_a.user),
        files=_file_tuple(name="a.pdf"),
    )
    upload_b = await client.post(
        "/api/contracts/upload",
        headers=_headers(org_b.user),
        files=_file_tuple(name="b.pdf"),
    )
    contract_a_id = upload_a.json()["id"]
    contract_b_id = uuid.UUID(upload_b.json()["id"])
    artifact_b = (
        await db_session.execute(
            select(ContractArtifact).where(ContractArtifact.contract_id == contract_b_id)
        )
    ).scalar_one()
    response = await client.get(
        f"/api/contracts/{contract_a_id}/artifacts/{artifact_b.id}/preview",
        headers=_headers(org_a.user),
    )
    assert response.status_code == 404


async def test_artifact_preview_missing_storage_metadata_returns_safe_409(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    user_org = await _create_user_org(db_session, email="preview-missing-storage@example.com")
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])
    broken = _add_artifact(
        db_session,
        user_org=user_org,
        contract_id=contract_id,
        artifact_type="signed_pdf",
        storage_key="",
        filename="broken.pdf",
        mime_type="application/pdf",
    )
    await db_session.commit()
    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{broken.id}/preview",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert isinstance(detail, str)
    for secret_key in ("storage_key", "wrapped_dek", "s3_key", "metadata_json", "presigned"):
        assert secret_key not in detail


async def test_artifact_preview_docx_unavailable_returns_safe_422(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_org = await _create_user_org(db_session, email="preview-docx-unavailable@example.com")
    upload = await client.post(
        "/api/contracts/upload",
        headers=_headers(user_org.user),
        files=_file_tuple(),
    )
    contract_id = uuid.UUID(upload.json()["id"])
    generated = _add_artifact(
        db_session,
        user_org=user_org,
        contract_id=contract_id,
        artifact_type="generated_docx",
        storage_key=f"documents/{contract_id}.docx.enc",
        filename="draft.docx",
        mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        source="template_generation",
    )
    await db_session.commit()

    from app.api import contracts as contracts_module
    monkeypatch.setattr(
        contracts_module,
        "convert_to_pdf_preview",
        lambda _c, _m, timeout_seconds=20: (_ for _ in ()).throw(contracts_module.ConverterUnavailableError("missing")),
    )

    response = await client.get(
        f"/api/contracts/{contract_id}/artifacts/{generated.id}/preview",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "PDF preview could not be generated for this file."
    preview_events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.event_type == AuditEventType.CONTRACT_ARTIFACT_PREVIEWED.value
            )
        )
    ).scalars().all()
    assert preview_events == []
