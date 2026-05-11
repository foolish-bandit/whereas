"""Unit tests for the warning-only duplicate-contract detector (PR #66).

Lightweight DB harness: same in-memory SQLite shape the other request
+ contract test modules use, just stripped down to the rows the
detector actually touches (organizations, users, contracts). The
goal is to pin the detector's contract independently of the upload
route — the integration tests in
``test_request_upload_conversion_api.py`` /
``test_contracts_api.py`` cover the wired-in behavior.

Privacy-critical posture:
- Cross-org rows must never appear in another org's candidate list.
- ``storage_key`` / ``wrapped_dek`` are not part of the
  ``DuplicateCandidate`` dataclass at all; the response projection
  cannot expose them.
"""
from __future__ import annotations

import secrets
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.models import Contract, ContractStatus, Organization, User
from app.security.encryption import create_org_master_key
from app.services.duplicate_detection import (
    DuplicateCandidate,
    find_possible_duplicate_contracts,
)

_INSTANCE_KEY = secrets.token_bytes(32)
_DOCX_MIME = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    """In-memory SQLite engine with just the tables the detector needs.

    Avoids the testcontainers Postgres bootstrap so these tests stay
    cheap and runnable without Docker. The detector only reads
    ``contracts``, so we don't have to set up the artifact / approval
    tables here.
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
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
        await conn.run_sync(
            Organization.__table__.create
        )
        await conn.run_sync(User.__table__.create)
        await conn.run_sync(Contract.__table__.create)
    try:
        yield engine
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Contract.__table__.drop)
            await conn.run_sync(User.__table__.drop)
            await conn.run_sync(Organization.__table__.drop)
        await engine.dispose()


@pytest.fixture
async def session(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    async with maker() as session:
        yield session


def _wrapped_org_key(org_id: uuid.UUID) -> bytes:
    return create_org_master_key(
        organization_id=str(org_id),
        instance_key=_INSTANCE_KEY,
    ).to_bytes()


async def _create_org_with_user(session: AsyncSession) -> tuple[Organization, User]:
    org = Organization(
        id=uuid.uuid4(),
        name=f"Org {uuid.uuid4()}",
        wrapped_master_key=_wrapped_org_key(uuid.uuid4()),
    )
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Test User",
        is_active=True,
    )
    session.add_all([org, user])
    await session.commit()
    return org, user


async def _insert_contract(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
    uploaded_by: uuid.UUID,
    title: str,
    file_hash: str,
    mime_type: str = _DOCX_MIME,
) -> Contract:
    contract = Contract(
        organization_id=organization_id,
        uploaded_by=uploaded_by,
        title=title,
        status=ContractStatus.READY.value,
        s3_key=f"documents/{uuid.uuid4()}.enc",
        mime_type=mime_type,
        file_hash_sha256=file_hash,
        page_count=None,
        full_text=None,
    )
    session.add(contract)
    await session.commit()
    await session.refresh(contract)
    return contract


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_exact_file_hash_match_returns_exact_candidate(
    session: AsyncSession,
) -> None:
    org, user = await _create_org_with_user(session)
    target_hash = "a" * 64
    existing = await _insert_contract(
        session,
        organization_id=org.id,
        uploaded_by=user.id,
        title="Mutual NDA — Acme",
        file_hash=target_hash,
    )

    candidates = await find_possible_duplicate_contracts(
        session,
        organization_id=org.id,
        file_hash_sha256=target_hash,
    )
    assert len(candidates) == 1
    assert candidates[0].contract_id == existing.id
    assert candidates[0].reason == "exact_file_hash"
    assert candidates[0].confidence == "exact"
    # Storage internals can't appear: the dataclass simply doesn't
    # have ``storage_key`` / ``wrapped_dek`` fields.
    assert not hasattr(candidates[0], "storage_key")
    assert not hasattr(candidates[0], "wrapped_dek")


async def test_cross_org_match_is_filtered_out(session: AsyncSession) -> None:
    org_a, user_a = await _create_org_with_user(session)
    org_b, _user_b = await _create_org_with_user(session)
    target_hash = "b" * 64
    await _insert_contract(
        session,
        organization_id=org_b.id,
        uploaded_by=_user_b.id,
        title="NDA - Globex",
        file_hash=target_hash,
    )

    # Same hash, queried as org A — must not see org B's contract.
    candidates = await find_possible_duplicate_contracts(
        session,
        organization_id=org_a.id,
        file_hash_sha256=target_hash,
    )
    assert candidates == []


async def test_excludes_self_contract_id(session: AsyncSession) -> None:
    org, user = await _create_org_with_user(session)
    target_hash = "c" * 64
    existing = await _insert_contract(
        session,
        organization_id=org.id,
        uploaded_by=user.id,
        title="NDA - Acme",
        file_hash=target_hash,
    )
    # Querying with ``exclude_contract_id=existing.id`` mirrors the
    # upload-in-progress case: the row that's being created shouldn't
    # match itself even if a hash collides.
    candidates = await find_possible_duplicate_contracts(
        session,
        organization_id=org.id,
        file_hash_sha256=target_hash,
        exclude_contract_id=existing.id,
    )
    assert candidates == []


async def test_similar_title_candidate(session: AsyncSession) -> None:
    org, user = await _create_org_with_user(session)
    existing = await _insert_contract(
        session,
        organization_id=org.id,
        uploaded_by=user.id,
        title="Mutual NDA Acme",
        file_hash="d" * 64,
    )
    # New upload has a fresh hash but the same normalized title.
    candidates = await find_possible_duplicate_contracts(
        session,
        organization_id=org.id,
        file_hash_sha256="e" * 64,
        suggested_title="Mutual NDA Acme",
    )
    assert len(candidates) == 1
    assert candidates[0].contract_id == existing.id
    assert candidates[0].reason == "similar_title"
    assert candidates[0].confidence == "possible"


async def test_similar_title_uses_filename_when_no_explicit_title(
    session: AsyncSession,
) -> None:
    """Same file uploaded with a different ``title=`` query param
    should still surface via the filename alias.
    """
    org, user = await _create_org_with_user(session)
    existing = await _insert_contract(
        session,
        organization_id=org.id,
        uploaded_by=user.id,
        title="acme contract",
        file_hash="f" * 64,
    )
    candidates = await find_possible_duplicate_contracts(
        session,
        organization_id=org.id,
        file_hash_sha256="0" * 64,
        suggested_title=None,
        filename="Acme_Contract.pdf",
    )
    assert {c.contract_id for c in candidates} == {existing.id}


async def test_similar_title_and_counterparty_match(session: AsyncSession) -> None:
    org, user = await _create_org_with_user(session)
    existing = await _insert_contract(
        session,
        organization_id=org.id,
        uploaded_by=user.id,
        title="NDA Acme Inc",
        file_hash="1" * 64,
    )
    candidates = await find_possible_duplicate_contracts(
        session,
        organization_id=org.id,
        file_hash_sha256="2" * 64,
        suggested_title="NDA Acme Inc",
        counterparty_name="Acme Inc",
    )
    assert len(candidates) == 1
    assert candidates[0].contract_id == existing.id
    assert candidates[0].reason == "similar_title_and_counterparty"


async def test_exact_hash_beats_title_for_same_row(session: AsyncSession) -> None:
    """When the same row matches both buckets, the strongest reason wins."""
    org, user = await _create_org_with_user(session)
    existing = await _insert_contract(
        session,
        organization_id=org.id,
        uploaded_by=user.id,
        title="NDA Acme",
        file_hash="3" * 64,
    )
    candidates = await find_possible_duplicate_contracts(
        session,
        organization_id=org.id,
        file_hash_sha256="3" * 64,
        suggested_title="NDA Acme",
    )
    assert len(candidates) == 1
    assert candidates[0].contract_id == existing.id
    assert candidates[0].reason == "exact_file_hash"


async def test_limit_is_respected(session: AsyncSession) -> None:
    org, user = await _create_org_with_user(session)
    target_hash = "4" * 64
    for i in range(6):
        await _insert_contract(
            session,
            organization_id=org.id,
            uploaded_by=user.id,
            title=f"Same Title #{i}",
            file_hash=target_hash,
        )

    candidates = await find_possible_duplicate_contracts(
        session,
        organization_id=org.id,
        file_hash_sha256=target_hash,
        limit=3,
    )
    assert len(candidates) == 3


async def test_no_inputs_returns_empty(session: AsyncSession) -> None:
    """With no hash, title, or filename, there's nothing to compare."""
    org, _user = await _create_org_with_user(session)
    candidates = await find_possible_duplicate_contracts(
        session,
        organization_id=org.id,
        file_hash_sha256=None,
    )
    assert candidates == []


async def test_dataclass_only_has_safe_fields() -> None:
    """``DuplicateCandidate`` has no storage / encryption attributes."""
    fields = set(DuplicateCandidate.__dataclass_fields__)
    assert fields == {
        "contract_id",
        "title",
        "reason",
        "confidence",
        "created_at",
        "status",
    }
