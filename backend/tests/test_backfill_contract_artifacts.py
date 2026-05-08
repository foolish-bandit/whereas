"""Tests for the legacy -> ContractArtifact backfill service."""
from __future__ import annotations

import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

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

from app.core.database import Base
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
from app.security.audit_log import AuditEvent
from app.services.contract_artifacts import (
    backfill_original_upload_artifacts,
)

_PG_IMAGE = "pgvector/pgvector:pg16"


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


async def _make_org(session: AsyncSession, name: str = "Org") -> Organization:
    org = Organization(id=uuid.uuid4(), name=name, wrapped_master_key=None)
    session.add(org)
    await session.flush()
    return org


async def _make_user(session: AsyncSession, org: Organization) -> User:
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Test",
        is_active=True,
    )
    session.add(user)
    await session.flush()
    return user


async def _make_legacy_contract(
    session: AsyncSession,
    *,
    org: Organization,
    user: User,
    title: str = "Legacy MSA",
    s3_key: str | None = "documents/legacy.enc",
    mime_type: str = "application/pdf",
    file_hash: str = "a" * 64,
) -> Contract:
    contract = Contract(
        organization_id=org.id,
        uploaded_by=user.id,
        title=title,
        status=ContractStatus.READY.value,
        s3_key=s3_key or "",
        mime_type=mime_type,
        file_hash_sha256=file_hash,
        page_count=1,
        full_text="legacy",
    )
    session.add(contract)
    await session.flush()
    return contract


async def test_backfill_creates_artifact_for_legacy_contract(
    db_session: AsyncSession,
) -> None:
    org = await _make_org(db_session)
    user = await _make_user(db_session, org)
    contract = await _make_legacy_contract(db_session, org=org, user=user)
    await db_session.commit()

    result = await backfill_original_upload_artifacts(db_session)

    assert result.scanned == 1
    assert result.created == 1
    assert result.skipped_existing == 0
    assert result.skipped_no_storage == 0

    rows = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract.id
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    artifact = rows[0]
    assert artifact.artifact_type == "original_upload"
    assert artifact.is_official is True
    assert artifact.source == "legacy_backfill"
    assert artifact.storage_backend == "s3"
    assert artifact.storage_key == "documents/legacy.enc"
    assert artifact.filename == "Legacy MSA"
    assert artifact.mime_type == "application/pdf"
    assert artifact.file_hash_sha256 == "a" * 64
    assert artifact.size_bytes is None
    assert artifact.organization_id == org.id
    assert artifact.metadata_json == {
        "backfilled_from": "contract_legacy_storage_fields"
    }


async def test_backfill_skips_contract_with_existing_original_upload_artifact(
    db_session: AsyncSession,
) -> None:
    org = await _make_org(db_session)
    user = await _make_user(db_session, org)
    contract = await _make_legacy_contract(db_session, org=org, user=user)
    existing = ContractArtifact(
        organization_id=org.id,
        contract_id=contract.id,
        artifact_type="original_upload",
        storage_backend="s3",
        storage_key="documents/legacy.enc",
        filename="legacy.pdf",
        mime_type="application/pdf",
        file_hash_sha256="a" * 64,
        is_official=True,
        source="user_upload",
    )
    db_session.add(existing)
    await db_session.commit()

    result = await backfill_original_upload_artifacts(db_session)

    assert result.scanned == 1
    assert result.created == 0
    assert result.skipped_existing == 1
    assert result.skipped_no_storage == 0

    rows = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract.id
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].source == "user_upload"


async def test_backfill_skips_contract_with_no_legacy_storage_key(
    db_session: AsyncSession,
) -> None:
    org = await _make_org(db_session)
    user = await _make_user(db_session, org)
    await _make_legacy_contract(db_session, org=org, user=user, s3_key="")
    await db_session.commit()

    result = await backfill_original_upload_artifacts(db_session)

    assert result.scanned == 1
    assert result.created == 0
    assert result.skipped_existing == 0
    assert result.skipped_no_storage == 1

    rows = (
        await db_session.execute(select(ContractArtifact))
    ).scalars().all()
    assert rows == []


async def test_backfill_is_idempotent(db_session: AsyncSession) -> None:
    org = await _make_org(db_session)
    user = await _make_user(db_session, org)
    await _make_legacy_contract(db_session, org=org, user=user)
    await db_session.commit()

    first = await backfill_original_upload_artifacts(db_session)
    assert first.created == 1

    second = await backfill_original_upload_artifacts(db_session)
    assert second.created == 0
    assert second.skipped_existing == 1

    rows = (
        await db_session.execute(select(ContractArtifact))
    ).scalars().all()
    assert len(rows) == 1


async def test_backfill_organization_id_limits_scope(
    db_session: AsyncSession,
) -> None:
    org_a = await _make_org(db_session, name="A")
    user_a = await _make_user(db_session, org_a)
    contract_a = await _make_legacy_contract(
        db_session, org=org_a, user=user_a, title="A doc"
    )

    org_b = await _make_org(db_session, name="B")
    user_b = await _make_user(db_session, org_b)
    contract_b = await _make_legacy_contract(
        db_session, org=org_b, user=user_b, title="B doc"
    )
    await db_session.commit()

    result = await backfill_original_upload_artifacts(
        db_session, organization_id=org_a.id
    )
    assert result.scanned == 1
    assert result.created == 1

    a_rows = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_a.id
            )
        )
    ).scalars().all()
    b_rows = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == contract_b.id
            )
        )
    ).scalars().all()
    assert len(a_rows) == 1
    assert b_rows == []


async def test_backfill_dry_run_creates_nothing_but_reports_would_create(
    db_session: AsyncSession,
) -> None:
    org = await _make_org(db_session)
    user = await _make_user(db_session, org)
    await _make_legacy_contract(db_session, org=org, user=user)
    await _make_legacy_contract(
        db_session, org=org, user=user, title="Other", s3_key="documents/other.enc"
    )
    await db_session.commit()

    result = await backfill_original_upload_artifacts(db_session, dry_run=True)

    assert result.scanned == 2
    assert result.created == 0
    assert result.would_create == 2
    assert result.skipped_existing == 0
    assert result.skipped_no_storage == 0

    rows = (
        await db_session.execute(select(ContractArtifact))
    ).scalars().all()
    assert rows == []
