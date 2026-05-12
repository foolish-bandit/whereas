"""API tests for the artifact compare route (PR #71).

Covers org/contract scoping, both happy paths (each artifact_type),
the conversion-failure 422 path, the missing-storage 409 path, the
audit event shape, and the response-safety rules (no storage_key /
wrapped_dek / raw bytes / signer PII in the body or headers).

Tests use the same in-memory + FakeStorage scaffolding as
``test_contracts_api`` so they don't require Docker. The
``convert_document_to_markdown`` seam is monkey-patched on a
per-test basis: extraction itself is exercised by the unit tests
in ``test_artifact_compare_service`` and the API tests stub it so a
known plain-text representation drives the diff.
"""
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
    ExtractedField,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent, AuditEventType  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402
from app.services import artifact_compare as artifact_compare_service  # noqa: E402
from app.services.document_markdown import MarkdownConversionResult  # noqa: E402
from app.services.document_parser import (  # noqa: E402
    ParsedDocument,
    ParsedPage,
)
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


def _parsed_document(file_bytes: bytes = _PDF_BYTES, text: str = "Sample") -> ParsedDocument:
    return ParsedDocument(
        full_text=text,
        pages=(ParsedPage(page_number=1, text=text, char_start=0, char_end=len(text), blocks=()),),
        page_count=1,
        content_hash=hashlib.sha256(file_bytes).hexdigest(),
    )


class FakeStorage:
    store_calls: list[dict[str, Any]]
    retrieve_calls: list[dict[str, Any]]
    plaintext_by_key: dict[str, bytes] = {}

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
        s3_key = f"documents/{document_id}.enc"
        self.__class__.store_calls.append(
            {
                "plaintext_bytes": plaintext_bytes,
                "document_id": document_id,
                "org_master_key": org_master_key,
                "s3_key": s3_key,
            }
        )
        self.__class__.plaintext_by_key[s3_key] = plaintext_bytes
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
                "org_master_key": org_master_key,
            }
        )
        return self.__class__.plaintext_by_key.get(s3_key, _PDF_BYTES)


@pytest.fixture(autouse=True)
def patch_heavy_seams(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeStorage.store_calls = []
    FakeStorage.retrieve_calls = []
    FakeStorage.plaintext_by_key = {}
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
        return []

    monkeypatch.setattr(contracts_api, "extract_and_persist_metadata", fake_extract)


@pytest.fixture
def stub_markdown_converter(monkeypatch: pytest.MonkeyPatch):
    """Replace ``convert_document_to_markdown`` with a controllable stub.

    The stub returns a ``ready`` result whose ``markdown_text`` is the
    plaintext bytes interpreted as UTF-8 (so the API tests can stage
    deterministic input by uploading the desired text). Tests that
    want to simulate a conversion failure pass ``always_fail=True``.
    """

    def factory(*, always_fail: bool = False, side_fail: str | None = None):
        calls: list[dict[str, Any]] = []

        def _convert(*, file_bytes: bytes, mime_type: str, filename: str | None, fallback_plain_text: str | None = None) -> MarkdownConversionResult:
            calls.append(
                {
                    "file_bytes": file_bytes,
                    "mime_type": mime_type,
                    "filename": filename,
                }
            )
            if always_fail:
                return MarkdownConversionResult(
                    status="failed",
                    markdown_text="",
                    converter_name="markitdown",
                    warnings=["markitdown_empty_output"],
                )
            text = file_bytes.decode("utf-8", errors="replace")
            if side_fail is not None and side_fail in (filename or ""):
                return MarkdownConversionResult(
                    status="failed",
                    markdown_text="",
                    converter_name="markitdown",
                    warnings=["markitdown_empty_output"],
                )
            return MarkdownConversionResult(
                status="ready",
                markdown_text=text,
                converter_name="markitdown",
                converter_version="0.0.test",
                warnings=[],
            )

        monkeypatch.setattr(
            artifact_compare_service,
            "convert_document_to_markdown",
            _convert,
        )
        return calls

    return factory


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


def _file_tuple(name: str = "contract.pdf", content: bytes = _PDF_BYTES, mime: str = "application/pdf") -> dict[str, tuple[str, bytes, str]]:
    return {"file": (name, content, mime)}


async def _upload(client: httpx.AsyncClient, user: User, *, name: str, content: bytes = _PDF_BYTES) -> dict[str, Any]:
    """Upload a contract. ``content`` defaults to a valid stub PDF header
    that satisfies ``_validate_upload``; the stored artifact text used
    for the actual compare is set separately via ``_set_artifact_plaintext``.
    """
    response = await client.post(
        "/api/contracts/upload",
        headers=_headers(user),
        files=_file_tuple(name=name, content=content),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _set_artifact_plaintext(artifact: ContractArtifact, text: str) -> None:
    """Stage the bytes ``retrieve_decrypted`` returns for this artifact.

    The upload validator requires a PDF magic header at upload time,
    but the compare service runs against whatever the storage layer
    returns. Tests stage text by writing it into ``FakeStorage``'s
    plaintext-by-key map so the converter stub sees deterministic
    input.
    """
    FakeStorage.plaintext_by_key[artifact.storage_key] = text.encode("utf-8")


def _add_artifact(
    db_session: AsyncSession,
    *,
    user_org: UserOrg,
    contract_id: uuid.UUID,
    artifact_type: str,
    storage_key: str,
    filename: str,
    plaintext: bytes,
    mime_type: str = "application/pdf",
    source: str | None = None,
) -> ContractArtifact:
    artifact = ContractArtifact(
        organization_id=user_org.org.id,
        contract_id=contract_id,
        artifact_type=artifact_type,
        storage_backend="s3",
        storage_key=storage_key,
        filename=filename,
        mime_type=mime_type,
        is_official=True,
        source=source,
    )
    db_session.add(artifact)
    FakeStorage.plaintext_by_key[storage_key] = plaintext
    return artifact


async def _two_artifacts(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    user_org: UserOrg,
    *,
    base_text: str = "alpha\nbeta\ngamma\ndelta\n",
    compare_text: str = "alpha\nBETA\ngamma\ndelta\nepsilon\n",
) -> tuple[uuid.UUID, ContractArtifact, ContractArtifact]:
    """Upload a contract and attach two artifacts with controlled bodies.

    Returns ``(contract_id, base_artifact, compare_artifact)``. The
    upload is done with a stub PDF header to satisfy the upload
    validator; the artifact's bytes are then overridden in
    ``FakeStorage`` so the compare service sees the desired text.
    """
    upload = await _upload(client, user_org.user, name="base.pdf")
    contract_id = uuid.UUID(upload["id"])

    base_artifact = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id,
                ContractArtifact.artifact_type == "original_upload",
            )
        )
    ).scalar_one()
    _set_artifact_plaintext(base_artifact, base_text)

    compare_artifact = _add_artifact(
        db_session,
        user_org=user_org,
        contract_id=contract_id,
        artifact_type="generated_docx",
        storage_key=f"documents/{contract_id}.compare.enc",
        filename="generated.docx",
        plaintext=compare_text.encode("utf-8"),
        mime_type=(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ),
        source="template_generation",
    )
    await db_session.commit()
    return contract_id, base_artifact, compare_artifact


# --------------------------------------------------------------------------
# Happy paths
# --------------------------------------------------------------------------


async def test_compare_two_artifacts_same_contract_succeeds(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    # Both sides surface safe metadata, including the user-facing
    # label (never the raw artifact_type alone).
    assert body["base"]["artifact_id"] == str(base.id)
    assert body["base"]["artifact_type"] == "original_upload"
    assert body["base"]["label"] == "Source file"
    assert body["compare"]["artifact_id"] == str(compare.id)
    assert body["compare"]["artifact_type"] == "generated_docx"
    assert body["compare"]["label"] == "Generated Word document"

    summary = body["summary"]
    # base: alpha,beta,gamma,delta  | compare: alpha,BETA,gamma,delta,epsilon
    #   ⇒ beta replaced with BETA (1 replaced line each → 1 changed block)
    #   ⇒ epsilon added at end
    assert summary["added_lines"] == 2  # BETA (replace insert) + epsilon
    assert summary["removed_lines"] == 1  # beta
    assert summary["changed_blocks"] == 1  # the replace block
    assert summary["unchanged_lines"] == 3  # alpha, gamma, delta
    assert isinstance(body["diff_blocks"], list)
    assert len(body["diff_blocks"]) >= 2
    # Diff carries the actual line text, not raw bytes.
    flat = " ".join(
        line["text"] for block in body["diff_blocks"] for line in block["lines"]
    )
    assert "alpha" in flat
    assert "BETA" in flat
    # No storage internals in body.
    text_body = response.text
    assert "storage_key" not in text_body
    assert "wrapped_dek" not in text_body


async def test_compare_writes_safe_audit_event(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 200

    events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.event_type
                == AuditEventType.CONTRACT_ARTIFACTS_COMPARED.value
            )
        )
    ).scalars().all()
    assert len(events) == 1
    details = events[0].details
    assert details["contract_id"] == str(contract_id)
    assert details["base_artifact_id"] == str(base.id)
    assert details["compare_artifact_id"] == str(compare.id)
    assert details["base_artifact_type"] == "original_upload"
    assert details["compare_artifact_type"] == "generated_docx"
    assert details["added_lines"] == 2
    assert details["removed_lines"] == 1
    # The audit log never carries storage internals or the extracted
    # text itself — only the line counts and ids.
    serialized = str(details)
    assert "storage_key" not in serialized
    assert "wrapped_dek" not in serialized
    assert "alpha" not in serialized
    assert "BETA" not in serialized


async def test_compare_signed_pdf_against_source_succeeds(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """A signed_pdf vs an original_upload is the most common compare:
    the panel needs to render both sides' labels."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    upload = await _upload(client, user_org.user, name="msa.pdf")
    contract_id = uuid.UUID(upload["id"])
    base_artifact = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id
            )
        )
    ).scalar_one()
    _set_artifact_plaintext(
        base_artifact,
        "Section 1. Term.\nThe Agreement is for one (1) year.\n",
    )

    signed = _add_artifact(
        db_session,
        user_org=user_org,
        contract_id=contract_id,
        artifact_type="signed_pdf",
        storage_key=f"documents/{contract_id}.signed.enc",
        filename="executed.pdf",
        plaintext=b"Section 1. Term.\nThe Agreement is for two (2) years.\n",
        source="docuseal",
    )
    await db_session.commit()

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base_artifact.id),
            "compare_artifact_id": str(signed.id),
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["base"]["label"] == "Source file"
    assert body["compare"]["label"] == "Signed PDF"
    assert body["summary"]["changed_blocks"] >= 1


# --------------------------------------------------------------------------
# Org / contract / artifact scoping
# --------------------------------------------------------------------------


async def test_compare_cross_org_artifact_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    stub_markdown_converter()
    owner = await _create_user_org(db_session, email="cmp-a@example.com")
    other = await _create_user_org(db_session, email="cmp-b@example.com")
    contract_id, base, compare = await _two_artifacts(client, db_session, owner)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare",
        headers=_headers(other.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 404


async def test_compare_artifact_from_another_contract_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_a_id, base_a, _ = await _two_artifacts(
        client, db_session, user_org
    )
    # Upload a second contract in the same org; its artifact should
    # not be addressable through the first contract's compare route.
    second = await _upload(client, user_org.user, name="other.pdf")
    second_id = uuid.UUID(second["id"])
    second_artifact = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == second_id
            )
        )
    ).scalar_one()

    response = await client.post(
        f"/api/contracts/{contract_a_id}/artifacts/compare",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base_a.id),
            "compare_artifact_id": str(second_artifact.id),
        },
    )
    assert response.status_code == 404


async def test_compare_missing_artifact_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, _ = await _two_artifacts(client, db_session, user_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 404


# --------------------------------------------------------------------------
# Storage / conversion / safety
# --------------------------------------------------------------------------


async def test_compare_missing_storage_metadata_returns_409(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    upload = await _upload(client, user_org.user, name="contract.pdf")
    contract_id = uuid.UUID(upload["id"])
    base_artifact = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id
            )
        )
    ).scalar_one()

    # An artifact whose ``storage_key`` is missing is unretrievable.
    orphan = ContractArtifact(
        organization_id=user_org.org.id,
        contract_id=contract_id,
        artifact_type="attachment",
        storage_backend="s3",
        storage_key="",
        filename="orphan.pdf",
        mime_type="application/pdf",
        is_official=False,
    )
    db_session.add(orphan)
    await db_session.commit()

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base_artifact.id),
            "compare_artifact_id": str(orphan.id),
        },
    )
    assert response.status_code == 409


async def test_compare_conversion_failure_returns_422(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    stub_markdown_converter(always_fail=True)
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 422
    detail = response.json().get("detail", "")
    # User-facing message — never the internal converter / warning
    # codes.
    assert "could not be converted to comparable text" in detail.lower()
    assert "markitdown" not in detail.lower()


async def test_compare_response_omits_storage_internals_and_extracted_text_persistence(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """Belt-and-braces: the response carries no storage internals,
    and the compare endpoint does not write any ``ContractMarkdownSnapshot``
    rows (text extraction is on-demand, not persisted)."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    snapshots_before = (
        await db_session.execute(
            select(ContractMarkdownSnapshot).where(
                ContractMarkdownSnapshot.contract_id == contract_id
            )
        )
    ).scalars().all()

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 200
    body = response.text
    for needle in (
        "storage_key",
        "wrapped_dek",
        "presigned_url",
        ".enc",  # raw storage path
    ):
        assert needle not in body, f"response leaked {needle!r}"

    snapshots_after = (
        await db_session.execute(
            select(ContractMarkdownSnapshot).where(
                ContractMarkdownSnapshot.contract_id == contract_id
            )
        )
    ).scalars().all()
    # Compare must not create new markdown-snapshot rows.
    assert len(snapshots_after) == len(snapshots_before)


# --------------------------------------------------------------------------
# Diff truncation
# --------------------------------------------------------------------------


async def test_compare_truncates_large_diff_with_warning(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """A diff that would emit more than DEFAULT_MAX_LINES lines is
    truncated and a ``diff_lines_truncated`` warning is appended.
    Summary counts remain accurate against the full diff."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    base_text = "\n".join(f"base-{i:04d}" for i in range(3000)) + "\n"
    compare_text = "\n".join(f"compare-{i:04d}" for i in range(3000)) + "\n"
    contract_id, base, compare = await _two_artifacts(
        client,
        db_session,
        user_org,
        base_text=base_text,
        compare_text=compare_text,
    )

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 200
    body = response.json()
    # Total emitted lines should be capped near DEFAULT_MAX_LINES.
    emitted = sum(len(b["lines"]) for b in body["diff_blocks"])
    assert emitted <= artifact_compare_service.DEFAULT_MAX_LINES
    assert "diff_lines_truncated" in body["warnings"]
    # Summary still reflects the full diff (every line replaced).
    assert body["summary"]["added_lines"] == 3000
    assert body["summary"]["removed_lines"] == 3000


# --------------------------------------------------------------------------
# PR #90 — redline export
# --------------------------------------------------------------------------


_DOCX_MIME = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


async def _expect_audit_event(
    db_session: AsyncSession, *, event_type: str
) -> dict[str, Any] | None:
    """Return the most recent audit event of the given type, if any."""
    from app.security.audit_log import AuditEvent

    stmt = (
        select(AuditEvent)
        .where(AuditEvent.event_type == event_type)
        .order_by(AuditEvent.created_at.desc())
        .limit(1)
    )
    row = (await db_session.execute(stmt)).scalar_one_or_none()
    return row.details if row is not None else None


async def test_compare_export_returns_docx_attachment(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """Happy path: two compatible artifacts → DOCX bytes with the right
    Content-Type and an attachment Content-Disposition header that
    includes the contract title (sanitized) plus a -comparison-report.docx
    suffix."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/export",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(_DOCX_MIME)
    disposition = response.headers["content-disposition"]
    assert "attachment;" in disposition
    assert "comparison-report.docx" in disposition
    # Real DOCX files start with the ZIP magic bytes.
    assert response.content[:2] == b"PK"
    assert len(response.content) > 0


async def test_compare_export_emits_safe_audit_event(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """A successful export emits ``contract.artifacts_compare_exported``
    with allowlisted details — never the diff/extracted text or any
    storage internals."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/export",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 200

    details = await _expect_audit_event(
        db_session, event_type="contract.artifacts_compare_exported"
    )
    assert details is not None
    assert set(details.keys()) == {
        "contract_id",
        "base_artifact_id",
        "compare_artifact_id",
        "base_artifact_type",
        "compare_artifact_type",
        "added_lines",
        "removed_lines",
        "changed_blocks",
        "format",
        "byte_count",
    }
    assert details["contract_id"] == str(contract_id)
    assert details["base_artifact_id"] == str(base.id)
    assert details["compare_artifact_id"] == str(compare.id)
    assert details["format"] == "docx"
    assert isinstance(details["byte_count"], int) and details["byte_count"] > 0
    # No leaked content.
    serialized = str(details)
    assert "storage_key" not in serialized
    assert "wrapped_dek" not in serialized
    assert "BETA" not in serialized  # would be from extracted text
    assert "alpha" not in serialized
    assert "epsilon" not in serialized


async def test_compare_export_cross_org_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """An artifact id that belongs to another org returns 404, never
    a leakier response. The route cannot distinguish wrong-org from
    no-such-artifact."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    # A second org with its own contract + artifacts.
    other_org = await _create_user_org(db_session)
    _, _, other_compare = await _two_artifacts(client, db_session, other_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/export",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(other_compare.id),
        },
    )
    assert response.status_code == 404


async def test_compare_export_unknown_artifact_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, _compare = await _two_artifacts(client, db_session, user_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/export",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 404


async def test_compare_export_unextractable_side_returns_422(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """If one side cannot be converted to comparable text the route
    returns 422 with a user-friendly message — no DOCX rendered."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)
    # Force the compare side to be unextractable.
    _set_artifact_plaintext(compare, "")  # empty body → CompareTextExtractionError

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/export",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 422
    assert "compare version" in response.json()["detail"].lower()


async def test_compare_export_does_not_persist_an_artifact(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """PR #90 is the export *foundation*: a successful export does NOT
    write a ``ContractArtifact`` row. The existing artifact list must
    stay the same after export."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    before = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id
            )
        )
    ).scalars().all()

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/export",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 200

    after = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id
            )
        )
    ).scalars().all()
    assert [a.id for a in before] == [a.id for a in after]


async def test_compare_export_response_carries_no_storage_internals(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """Defense-in-depth: the rendered DOCX bytes should never contain
    storage_key, wrapped_dek, s3_key, raw metadata_json keys, or
    DocuSeal secret keys, even when the underlying artifacts carry
    them on the row."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/export",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 200
    body = response.content
    for needle in (
        b"storage_key",
        b"wrapped_dek",
        b"s3_key",
        b"presigned",
        b"docuseal_submission_id",
    ):
        assert needle not in body


# --------------------------------------------------------------------------
# PR #91 — persisted redline (save the comparison report to Document History)
# --------------------------------------------------------------------------


async def test_compare_save_persists_a_redline_artifact_row(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """Happy path: POST .../compare/save creates a new
    ``ContractArtifact`` with ``artifact_type=redline``,
    ``is_official=False``, ``source=comparison_report``, and a
    ``mime_type`` of the DOCX content type. Storage key + wrapped DEK
    are present on the row (so the existing per-artifact download can
    retrieve it) but never travel on the wire."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/save",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["artifact_type"] == "redline"
    assert body["is_official"] is False
    assert body["source"] == "comparison_report"
    assert body["mime_type"] == _DOCX_MIME
    assert body["size_bytes"] > 0
    metadata = body["metadata_json"]
    assert metadata["base_artifact_id"] == str(base.id)
    assert metadata["compare_artifact_id"] == str(compare.id)
    assert metadata["format"] == "docx"
    assert metadata["source_kind"] == "comparison_report"
    for forbidden in ("storage_key", "wrapped_dek"):
        assert forbidden not in body
    db_artifact = await db_session.get(ContractArtifact, uuid.UUID(body["id"]))
    assert db_artifact is not None
    assert db_artifact.storage_key
    assert db_artifact.wrapped_dek
    assert db_artifact.artifact_type == "redline"
    assert db_artifact.is_official is False


async def test_compare_save_emits_safe_audit_event(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/save",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 201

    details = await _expect_audit_event(
        db_session, event_type="contract.artifact_redline_saved"
    )
    assert details is not None
    assert set(details.keys()) == {
        "contract_id",
        "artifact_id",
        "base_artifact_id",
        "compare_artifact_id",
        "base_artifact_type",
        "compare_artifact_type",
        "added_lines",
        "removed_lines",
        "changed_blocks",
        "format",
    }
    assert details["artifact_id"] == response.json()["id"]
    serialized = str(details)
    for needle in ("storage_key", "wrapped_dek", "alpha", "BETA", "epsilon"):
        assert needle not in serialized


async def test_compare_save_appears_in_artifacts_listing(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """After saving, the new redline shows up in the contract's
    artifact listing — that's the whole point: it joins Document
    History."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    listing_before = await client.get(
        f"/api/contracts/{contract_id}/artifacts",
        headers=_headers(user_org.user),
    )
    assert listing_before.status_code == 200
    before_types = [a["artifact_type"] for a in listing_before.json()]
    assert "redline" not in before_types

    save = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/save",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert save.status_code == 201

    listing_after = await client.get(
        f"/api/contracts/{contract_id}/artifacts",
        headers=_headers(user_org.user),
    )
    assert listing_after.status_code == 200
    after_types = [a["artifact_type"] for a in listing_after.json()]
    assert "redline" in after_types


async def test_compare_save_does_not_change_download_priority(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """A saved redline must never become the *current document*. It's
    not in ``DOWNLOADABLE_ARTIFACT_TYPES_BY_PRIORITY`` AND it's
    ``is_official=False``, so the priority resolver cannot return
    it."""
    from app.services.contract_artifacts import (
        DOWNLOADABLE_ARTIFACT_TYPES_BY_PRIORITY,
        get_latest_official_downloadable_artifact,
    )

    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)

    save = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/save",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert save.status_code == 201

    assert "redline" not in DOWNLOADABLE_ARTIFACT_TYPES_BY_PRIORITY

    chosen = await get_latest_official_downloadable_artifact(
        db_session,
        contract_id=contract_id,
        organization_id=user_org.org.id,
    )
    assert chosen is not None
    assert chosen.artifact_type == "original_upload"
    assert chosen.is_official is True


async def test_compare_save_cross_org_returns_404(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, _compare = await _two_artifacts(client, db_session, user_org)

    other_org = await _create_user_org(db_session)
    _, _, other_compare = await _two_artifacts(client, db_session, other_org)

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/save",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(other_compare.id),
        },
    )
    assert response.status_code == 404


async def test_compare_save_unextractable_side_returns_422(
    client: httpx.AsyncClient,
    db_session: AsyncSession,
    stub_markdown_converter,
) -> None:
    """If one side is un-extractable nothing is persisted."""
    stub_markdown_converter()
    user_org = await _create_user_org(db_session)
    contract_id, base, compare = await _two_artifacts(client, db_session, user_org)
    _set_artifact_plaintext(compare, "")

    response = await client.post(
        f"/api/contracts/{contract_id}/artifacts/compare/save",
        headers=_headers(user_org.user),
        json={
            "base_artifact_id": str(base.id),
            "compare_artifact_id": str(compare.id),
        },
    )
    assert response.status_code == 422

    after = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_id,
                ContractArtifact.artifact_type == "redline",
            )
        )
    ).scalars().all()
    assert after == []
