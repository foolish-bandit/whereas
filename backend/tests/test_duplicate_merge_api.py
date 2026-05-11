"""API tests for the duplicate-merge endpoint (PR #76).

The merge endpoint is the primary user-facing way to resolve
duplicate Repository records without data loss. These tests pin:

* success path moves artifacts from source → target,
* source row stays in the database but is flagged with
  ``merged_into_contract_id`` / ``merged_at`` / ``merged_by_user_id``,
* default Repository list filters merged rows out,
  ``?include_merged=true`` brings them back,
* the merged source's detail still resolves (no 404), and carries
  the merge pointer back to the target,
* artifact storage internals (storage_key, wrapped_dek, etc.) are
  preserved server-side but never appear in the response or audit,
* same-record merge returns 400, cross-org returns 404,
  already-merged source/target returns 409,
* paired audit events fire with safe details only.
"""
from __future__ import annotations

import json
import secrets
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from sqlalchemy import select
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

from app.core.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    AgreementTemplate,
    ApprovalPolicy,
    ApprovalStep,
    ApprovalWorkflowRun,
    ApprovalWorkflowTemplate,
    ApprovalWorkflowTemplateStep,
    Clause,
    Contract,
    ContractArtifact,
    ContractRequest,
    ExtractedField,
    InboxItem,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent, AuditEventType  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)

# Strings that must NEVER appear inside a merge response or audit
# payload. The merge service does not project these by construction;
# this is the regression net.
FORBIDDEN_TERMS = (
    "storage_key",
    "wrapped_dek",
    "wrapped_master_key",
    "s3_key",
    "metadata_json",
    "private_url",
    "presigned",
    "webhook",
    "docuseal_secret",
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
            ExtractedField.__table__,
            Clause.__table__,
            AgreementTemplate.__table__,
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
        from sqlalchemy import event
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
    session: AsyncSession, *, email: str | None = None
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


async def _make_contract(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    uploaded_by: uuid.UUID,
    title: str = "Contract",
    file_hash: str | None = None,
) -> Contract:
    contract = Contract(
        organization_id=org_id,
        uploaded_by=uploaded_by,
        title=title,
        status="ready",
        s3_key=f"contracts/{uuid.uuid4()}/encrypted.bin",
        wrapped_dek=secrets.token_bytes(64),
        mime_type="application/pdf",
        file_hash_sha256=file_hash or ("a" * 64),
    )
    session.add(contract)
    await session.commit()
    return contract


async def _make_artifact(
    session: AsyncSession,
    *,
    contract: Contract,
    artifact_type: str = "original_upload",
    is_official: bool = True,
    filename: str = "doc.pdf",
) -> ContractArtifact:
    artifact = ContractArtifact(
        organization_id=contract.organization_id,
        contract_id=contract.id,
        artifact_type=artifact_type,
        storage_backend="s3",
        storage_key=f"artifacts/{uuid.uuid4()}/blob.bin",
        wrapped_dek=secrets.token_bytes(64),
        filename=filename,
        mime_type="application/pdf",
        file_hash_sha256="b" * 64,
        size_bytes=1234,
        source="user_upload",
        is_official=is_official,
        metadata_json={"counterparty_name": "Acme Corp"},
    )
    session.add(artifact)
    await session.commit()
    return artifact


def _assert_no_forbidden_terms(text: str) -> None:
    lower = text.lower()
    for term in FORBIDDEN_TERMS:
        assert term.lower() not in lower, (
            f"forbidden term {term!r} leaked into payload"
        )


async def _all_audit_events(
    session: AsyncSession, org_id: uuid.UUID
) -> list[AuditEvent]:
    stmt = (
        select(AuditEvent)
        .where(AuditEvent.organization_id == org_id)
        .order_by(AuditEvent.sequence.asc())
    )
    return list((await session.execute(stmt)).scalars().all())


# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------


async def test_merge_moves_artifacts_and_flags_source(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    target = await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Canonical",
    )
    source = await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Duplicate",
    )
    source_artifact_a = await _make_artifact(
        db_session, contract=source, filename="dup_a.pdf"
    )
    source_artifact_b = await _make_artifact(
        db_session, contract=source, filename="dup_b.pdf"
    )
    source_storage_key_a = source_artifact_a.storage_key
    source_wrapped_dek_a = source_artifact_a.wrapped_dek

    resp = await client.post(
        f"/api/contracts/{target.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(source.id)},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["target_contract_id"] == str(target.id)
    assert body["source_contract_id"] == str(source.id)
    assert body["artifacts_moved"] == 2
    assert body["merged_by_user_id"] == str(user_org.user.id)
    _assert_no_forbidden_terms(resp.text)

    # Source row is preserved but flagged.
    await db_session.refresh(source)
    assert source.merged_into_contract_id == target.id
    assert source.merged_at is not None
    assert source.merged_by_user_id == user_org.user.id

    # Artifacts now belong to the target. Storage metadata is
    # preserved verbatim — only ``contract_id`` flipped.
    target_artifacts = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == target.id
            )
        )
    ).scalars().all()
    assert len(target_artifacts) == 2
    by_id = {a.id: a for a in target_artifacts}
    assert by_id[source_artifact_a.id].storage_key == source_storage_key_a
    assert by_id[source_artifact_a.id].wrapped_dek == source_wrapped_dek_a
    assert by_id[source_artifact_a.id].organization_id == user_org.org.id
    # Source has no artifacts left.
    leftover = (
        await db_session.execute(
            select(ContractArtifact).where(
                ContractArtifact.contract_id == source.id
            )
        )
    ).scalars().all()
    assert leftover == []
    # Defensive: rows weren't deleted, just moved.
    _ = source_artifact_b


async def test_merge_response_no_storage_internals(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    target = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    source = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    await _make_artifact(db_session, contract=source)

    resp = await client.post(
        f"/api/contracts/{target.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={
            "source_contract_id": str(source.id),
            "merge_note": "looks like the counterparty re-uploaded",
        },
    )
    assert resp.status_code == 200
    _assert_no_forbidden_terms(resp.text)
    parsed = json.loads(resp.text)
    _assert_no_forbidden_terms(json.dumps(parsed))
    # Note text is NOT echoed back.
    assert "counterparty re-uploaded" not in resp.text


async def test_merged_source_hidden_from_default_list_and_visible_with_filter(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    target = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id, title="Keep"
    )
    source = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id, title="Dup"
    )
    await _make_artifact(db_session, contract=source)

    merge_resp = await client.post(
        f"/api/contracts/{target.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(source.id)},
    )
    assert merge_resp.status_code == 200

    # Default list filters merged rows out.
    list_resp = await client.get("/api/contracts", headers=_headers(user_org.user))
    assert list_resp.status_code == 200
    ids = {row["id"] for row in list_resp.json()}
    assert str(target.id) in ids
    assert str(source.id) not in ids

    # ``include_merged=true`` brings them back.
    list_inc = await client.get(
        "/api/contracts?include_merged=true", headers=_headers(user_org.user)
    )
    inc_ids = {row["id"] for row in list_inc.json()}
    assert str(source.id) in inc_ids


async def test_merged_source_detail_still_resolves_and_carries_pointer(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    target = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    source = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )

    merge = await client.post(
        f"/api/contracts/{target.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(source.id)},
    )
    assert merge.status_code == 200

    detail = await client.get(
        f"/api/contracts/{source.id}", headers=_headers(user_org.user)
    )
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["merged_into_contract_id"] == str(target.id)
    assert body["merged_at"] is not None


# ---------------------------------------------------------------------------
# Failure / conflict
# ---------------------------------------------------------------------------


async def test_merge_same_record_returns_400(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    resp = await client.post(
        f"/api/contracts/{contract.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(contract.id)},
    )
    assert resp.status_code == 400


async def test_merge_cross_org_source_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    target = await _make_contract(
        db_session, org_id=org_a.org.id, uploaded_by=org_a.user.id
    )
    foreign_source = await _make_contract(
        db_session, org_id=org_b.org.id, uploaded_by=org_b.user.id
    )
    resp = await client.post(
        f"/api/contracts/{target.id}/merge-duplicate",
        headers=_headers(org_a.user),
        json={"source_contract_id": str(foreign_source.id)},
    )
    assert resp.status_code == 404


async def test_merge_cross_org_target_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    foreign_target = await _make_contract(
        db_session, org_id=org_b.org.id, uploaded_by=org_b.user.id
    )
    source = await _make_contract(
        db_session, org_id=org_a.org.id, uploaded_by=org_a.user.id
    )
    resp = await client.post(
        f"/api/contracts/{foreign_target.id}/merge-duplicate",
        headers=_headers(org_a.user),
        json={"source_contract_id": str(source.id)},
    )
    assert resp.status_code == 404


async def test_merge_missing_source_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    target = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    resp = await client.post(
        f"/api/contracts/{target.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(uuid.uuid4())},
    )
    assert resp.status_code == 404


async def test_merge_missing_target_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    source = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    resp = await client.post(
        f"/api/contracts/{uuid.uuid4()}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(source.id)},
    )
    assert resp.status_code == 404


async def test_merge_already_merged_source_returns_409(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    target = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    source = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    other_target = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )

    # First merge: source → target.
    r1 = await client.post(
        f"/api/contracts/{target.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(source.id)},
    )
    assert r1.status_code == 200
    # Second merge of the same source into a different target.
    r2 = await client.post(
        f"/api/contracts/{other_target.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(source.id)},
    )
    assert r2.status_code == 409


async def test_merge_already_merged_target_returns_409(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    canonical = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    midway = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    fresh = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    # midway → canonical.
    r = await client.post(
        f"/api/contracts/{canonical.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(midway.id)},
    )
    assert r.status_code == 200
    # Now try fresh → midway. midway is already merged, so the
    # target rejects with 409.
    r2 = await client.post(
        f"/api/contracts/{midway.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(fresh.id)},
    )
    assert r2.status_code == 409


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------


async def test_merge_writes_paired_audit_events_with_safe_details(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    target = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    source = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    await _make_artifact(db_session, contract=source)
    await _make_artifact(db_session, contract=source)

    resp = await client.post(
        f"/api/contracts/{target.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={
            "source_contract_id": str(source.id),
            "merge_note": "duplicate from re-upload",
        },
    )
    assert resp.status_code == 200

    events = await _all_audit_events(db_session, user_org.org.id)
    merge_events = [
        e
        for e in events
        if e.event_type
        in (
            AuditEventType.CONTRACT_DUPLICATE_MERGED.value,
            AuditEventType.CONTRACT_MERGED_INTO.value,
        )
    ]
    assert len(merge_events) == 2
    by_type = {e.event_type: e for e in merge_events}
    duplicate_merged = by_type[AuditEventType.CONTRACT_DUPLICATE_MERGED.value]
    merged_into = by_type[AuditEventType.CONTRACT_MERGED_INTO.value]

    assert duplicate_merged.target_id == str(target.id)
    assert merged_into.target_id == str(source.id)

    # Allowlisted keys ONLY — note text never appears.
    expected_keys = {
        "target_contract_id",
        "source_contract_id",
        "artifacts_moved",
        "merge_note_present",
        "workflow_runs_attached_to_source",
        "requests_attached_to_source",
    }
    for ev in merge_events:
        assert set(ev.details.keys()) == expected_keys
        assert ev.details["merge_note_present"] is True
        assert ev.details["artifacts_moved"] == 2

    # The note text must NOT survive into any audit payload, anywhere.
    for ev in events:
        assert "re-upload" not in json.dumps(ev.details or {})


async def test_merge_audit_omits_note_when_blank(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    target = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    source = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    resp = await client.post(
        f"/api/contracts/{target.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(source.id), "merge_note": "   "},
    )
    assert resp.status_code == 200
    events = await _all_audit_events(db_session, user_org.org.id)
    merged = next(
        e
        for e in events
        if e.event_type == AuditEventType.CONTRACT_DUPLICATE_MERGED.value
    )
    assert merged.details["merge_note_present"] is False


# ---------------------------------------------------------------------------
# Workflow-link warnings
# ---------------------------------------------------------------------------


async def test_merge_reports_workflow_count_without_rewiring(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    target = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    source = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    # Attach a workflow run to the source.
    run = ApprovalWorkflowRun(
        organization_id=user_org.org.id,
        name="Legal review",
        status="active",
        contract_id=source.id,
    )
    db_session.add(run)
    await db_session.commit()

    resp = await client.post(
        f"/api/contracts/{target.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(source.id)},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["workflow_runs_attached_to_source"] == 1

    # Workflow run still points at source — we deliberately did not
    # rewire it.
    await db_session.refresh(run)
    assert run.contract_id == source.id


# ---------------------------------------------------------------------------
# Duplicate-candidates endpoint
# ---------------------------------------------------------------------------


async def test_duplicate_candidates_endpoint_excludes_self_and_merged(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    canonical = await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="ACME MSA 2026",
        file_hash="c" * 64,
    )
    same_hash = await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="ACME MSA 2026",
        file_hash="c" * 64,
    )
    already_merged = await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="ACME MSA 2026",
        file_hash="c" * 64,
    )
    # Mark ``already_merged`` as merged into canonical.
    r = await client.post(
        f"/api/contracts/{canonical.id}/merge-duplicate",
        headers=_headers(user_org.user),
        json={"source_contract_id": str(already_merged.id)},
    )
    assert r.status_code == 200

    resp = await client.get(
        f"/api/contracts/{canonical.id}/duplicate-candidates",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200
    candidates = resp.json()["candidates"]
    ids = {c["contract_id"] for c in candidates}
    # ``same_hash`` is still a viable duplicate; ``already_merged`` is not.
    assert str(same_hash.id) in ids
    assert str(canonical.id) not in ids
    assert str(already_merged.id) not in ids
    _assert_no_forbidden_terms(resp.text)


async def test_duplicate_candidates_endpoint_cross_org_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    foreign = await _make_contract(
        db_session, org_id=org_b.org.id, uploaded_by=org_b.user.id
    )
    resp = await client.get(
        f"/api/contracts/{foreign.id}/duplicate-candidates",
        headers=_headers(org_a.user),
    )
    assert resp.status_code == 404
