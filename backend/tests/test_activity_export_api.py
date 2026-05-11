"""API tests for the activity timeline export endpoints (PR #75).

The export endpoints reuse the same sanitized projection as the
``/activity`` endpoints and format it as CSV or JSON. These tests
pin:

* success paths return 200, the right ``Content-Type``, an
  ``attachment`` ``Content-Disposition``, and a CSV with a header
  row / a JSON envelope with the expected keys,
* cross-org access still returns 404,
* unsupported formats return 422,
* exported bytes never contain storage internals
  (``storage_key`` / ``wrapped_dek`` / ``s3_key`` / ``metadata_json``
  / ``presigned`` / DocuSeal raw payloads / decision-note text /
  document bytes),
* an audit event is written for each export with safe details only.
"""
from __future__ import annotations

import csv
import io
import json
import secrets
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
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
    Contract,
    ContractRequest,
    InboxItem,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent, AuditEventType, record_event  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)

# Strings that must NEVER appear inside an exported file. The
# projection already excludes them by construction; this list is the
# regression net.
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
    "decision_note",
    "raw_submission",
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


async def _make_request(
    session: AsyncSession,
    org_id: uuid.UUID,
    *,
    title: str = "Req",
    linked_contract_id: uuid.UUID | None = None,
) -> ContractRequest:
    row = ContractRequest(
        organization_id=org_id,
        title=title,
        linked_contract_id=linked_contract_id,
    )
    session.add(row)
    await session.commit()
    return row


async def _make_contract(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    uploaded_by: uuid.UUID,
    title: str = "Contract",
) -> Contract:
    contract = Contract(
        organization_id=org_id,
        uploaded_by=uploaded_by,
        title=title,
        status="ready",
        s3_key="dummy/key",
        mime_type="application/pdf",
        file_hash_sha256="0" * 64,
    )
    session.add(contract)
    await session.commit()
    return contract


async def _seed_contract_with_events(
    session: AsyncSession,
    user_org: UserOrg,
) -> Contract:
    """Create a contract and a couple of audit events the timeline
    surfaces. The DocuSeal-send event details intentionally include a
    couple of safe identifier fields only — the timeline projection
    must drop everything else.
    """
    contract = await _make_contract(
        session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    await record_event(
        session,
        organization_id=user_org.org.id,
        event_type=AuditEventType.CONTRACT_SENT_FOR_SIGNATURE,
        actor_user_id=user_org.user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "submission_id": "ds-42",
            "signer_count": 1,
        },
        occurred_at=datetime(2026, 5, 1, 12, 0, tzinfo=UTC),
    )
    await record_event(
        session,
        organization_id=user_org.org.id,
        event_type=AuditEventType.CONTRACT_EXECUTED,
        actor_user_id=user_org.user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "submission_id": "ds-42",
        },
        occurred_at=datetime(2026, 5, 2, 12, 0, tzinfo=UTC),
    )
    await session.commit()
    return contract


async def _audit_events_for_org(
    session: AsyncSession, org_id: uuid.UUID
) -> list[AuditEvent]:
    stmt = (
        select(AuditEvent)
        .where(AuditEvent.organization_id == org_id)
        .order_by(AuditEvent.sequence.asc())
    )
    return list((await session.execute(stmt)).scalars().all())


def _assert_forbidden_terms_absent(blob: str) -> None:
    lower = blob.lower()
    for term in FORBIDDEN_TERMS:
        assert term.lower() not in lower, (
            f"forbidden term {term!r} leaked into export payload"
        )


# ---------------------------------------------------------------------------
# Contract export — CSV
# ---------------------------------------------------------------------------


async def test_contract_csv_export_returns_200_and_attachment(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract_with_events(db_session, user_org)

    resp = await client.get(
        f"/api/contracts/{contract.id}/activity/export?format=csv",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200, resp.text
    ctype = resp.headers["content-type"]
    assert ctype.startswith("text/csv"), ctype
    disposition = resp.headers["content-disposition"]
    assert disposition.startswith("attachment;"), disposition
    assert ".csv" in disposition

    body = resp.text
    reader = csv.reader(io.StringIO(body))
    rows = list(reader)
    # Header row + at least the two seeded events.
    assert rows[0] == [
        "occurred_at",
        "event_type",
        "event_id",
        "actor_user_id",
        "title",
        "description",
        "contract_id",
        "request_id",
        "workflow_run_id",
        "approval_step_id",
        "step_order",
        "source",
    ]
    assert len(rows) >= 3
    data_rows = rows[1:]
    event_types = [r[1] for r in data_rows]
    assert AuditEventType.CONTRACT_SENT_FOR_SIGNATURE.value in event_types
    assert AuditEventType.CONTRACT_EXECUTED.value in event_types
    # Every data row carries the contract_id.
    contract_id_idx = rows[0].index("contract_id")
    assert all(r[contract_id_idx] == str(contract.id) for r in data_rows)


async def test_contract_csv_export_excludes_forbidden_terms(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract_with_events(db_session, user_org)

    # Seed a deliberately noisy audit event with keys we never expose.
    await record_event(
        db_session,
        organization_id=user_org.org.id,
        event_type=AuditEventType.CONTRACT_SENT_FOR_SIGNATURE,
        actor_user_id=user_org.user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "storage_key": "secret-key/should-never-leak",
            "wrapped_dek": "AAAA",
            "s3_key": "buckety/path",
            "metadata_json": {"private_url": "https://leaked/"},
            "raw_submission": {"webhook": "payload"},
            "decision_note": "hush",
        },
    )
    await db_session.commit()

    resp = await client.get(
        f"/api/contracts/{contract.id}/activity/export?format=csv",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200
    _assert_forbidden_terms_absent(resp.text)


# ---------------------------------------------------------------------------
# Contract export — JSON
# ---------------------------------------------------------------------------


async def test_contract_json_export_envelope_shape(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract_with_events(db_session, user_org)

    resp = await client.get(
        f"/api/contracts/{contract.id}/activity/export?format=json",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    assert resp.headers["content-disposition"].startswith("attachment;")
    assert ".json" in resp.headers["content-disposition"]

    body = resp.json()
    assert body["export_type"] == "activity_timeline"
    assert body["subject_type"] == "contract"
    assert body["subject_id"] == str(contract.id)
    # ISO-8601 generated_at parses.
    datetime.fromisoformat(body["generated_at"].replace("Z", "+00:00"))

    events = body["events"]
    assert isinstance(events, list) and len(events) >= 2
    sample = events[0]
    # Allowlisted keys — exactly the timeline projection's shape.
    assert set(sample.keys()) == {
        "id",
        "event_type",
        "occurred_at",
        "actor_user_id",
        "title",
        "description",
        "request_id",
        "contract_id",
        "workflow_run_id",
        "approval_step_id",
        "step_order",
        "source",
    }


async def test_contract_json_export_excludes_forbidden_terms(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract_with_events(db_session, user_org)
    await record_event(
        db_session,
        organization_id=user_org.org.id,
        event_type=AuditEventType.CONTRACT_EXECUTED,
        actor_user_id=user_org.user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "storage_key": "leaky/key",
            "wrapped_dek": "AAAA",
            "s3_key": "x",
            "metadata_json": "shouldnotappear",
            "presigned_url": "https://leak/",
            "webhook_payload": {"raw": True},
            "decision_note": "hidden text",
        },
    )
    await db_session.commit()

    resp = await client.get(
        f"/api/contracts/{contract.id}/activity/export?format=json",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200
    raw = resp.text
    _assert_forbidden_terms_absent(raw)
    # Parse + serialize round-trip — defense in depth.
    parsed = json.loads(raw)
    _assert_forbidden_terms_absent(json.dumps(parsed))


# ---------------------------------------------------------------------------
# Request export
# ---------------------------------------------------------------------------


async def _seed_request_with_events(
    session: AsyncSession,
    user_org: UserOrg,
) -> tuple[ContractRequest, Contract]:
    contract = await _make_contract(
        session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    request = await _make_request(
        session, user_org.org.id, linked_contract_id=contract.id
    )
    await record_event(
        session,
        organization_id=user_org.org.id,
        event_type=AuditEventType.CONTRACT_SENT_FOR_SIGNATURE,
        actor_user_id=user_org.user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "submission_id": "ds-1",
            "signer_count": 1,
        },
    )
    await record_event(
        session,
        organization_id=user_org.org.id,
        event_type=AuditEventType.REQUEST_CONVERTED_BY_UPLOAD,
        actor_user_id=user_org.user.id,
        target_type="request",
        target_id=str(request.id),
        details={
            "request_id": str(request.id),
            "contract_id": str(contract.id),
            "filename": "executed.pdf",
        },
    )
    await session.commit()
    return request, contract


async def test_request_csv_export_returns_200_and_includes_request_event(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request, _ = await _seed_request_with_events(db_session, user_org)

    resp = await client.get(
        f"/api/requests/{request.id}/activity/export?format=csv",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(resp.text)))
    types = [r[1] for r in rows[1:]]
    assert AuditEventType.REQUEST_CONVERTED_BY_UPLOAD.value in types
    assert AuditEventType.CONTRACT_SENT_FOR_SIGNATURE.value in types
    _assert_forbidden_terms_absent(resp.text)


async def test_request_json_export_returns_safe_envelope(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request, _ = await _seed_request_with_events(db_session, user_org)

    resp = await client.get(
        f"/api/requests/{request.id}/activity/export?format=json",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["subject_type"] == "request"
    assert body["subject_id"] == str(request.id)
    assert body["export_type"] == "activity_timeline"
    assert len(body["events"]) >= 2
    _assert_forbidden_terms_absent(resp.text)


# ---------------------------------------------------------------------------
# Cross-org & unsupported-format errors
# ---------------------------------------------------------------------------


async def test_contract_export_cross_org_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    contract = await _seed_contract_with_events(db_session, org_a)

    resp = await client.get(
        f"/api/contracts/{contract.id}/activity/export?format=csv",
        headers=_headers(org_b.user),
    )
    assert resp.status_code == 404


async def test_request_export_cross_org_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    request, _ = await _seed_request_with_events(db_session, org_a)

    resp = await client.get(
        f"/api/requests/{request.id}/activity/export?format=csv",
        headers=_headers(org_b.user),
    )
    assert resp.status_code == 404


async def test_contract_export_unsupported_format_returns_422(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract_with_events(db_session, user_org)

    resp = await client.get(
        f"/api/contracts/{contract.id}/activity/export?format=xml",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 422
    # No bytes leaked into the error body either.
    _assert_forbidden_terms_absent(resp.text)


async def test_request_export_unsupported_format_returns_422(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request, _ = await _seed_request_with_events(db_session, user_org)

    resp = await client.get(
        f"/api/requests/{request.id}/activity/export?format=yaml",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Export audit event
# ---------------------------------------------------------------------------


async def test_contract_export_writes_audit_event_with_safe_details(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract_with_events(db_session, user_org)

    resp = await client.get(
        f"/api/contracts/{contract.id}/activity/export?format=csv",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200

    events = await _audit_events_for_org(db_session, user_org.org.id)
    export_events = [
        e
        for e in events
        if e.event_type == AuditEventType.CONTRACT_ACTIVITY_EXPORTED.value
    ]
    assert len(export_events) == 1
    e = export_events[0]
    assert e.target_type == "contract"
    assert e.target_id == str(contract.id)
    assert set(e.details.keys()) == {"contract_id", "format", "event_count"}
    assert e.details["format"] == "csv"
    assert isinstance(e.details["event_count"], int)
    assert e.details["event_count"] >= 1


async def test_request_export_writes_audit_event_with_safe_details(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request, _ = await _seed_request_with_events(db_session, user_org)

    resp = await client.get(
        f"/api/requests/{request.id}/activity/export?format=json",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200

    events = await _audit_events_for_org(db_session, user_org.org.id)
    export_events = [
        e
        for e in events
        if e.event_type == AuditEventType.REQUEST_ACTIVITY_EXPORTED.value
    ]
    assert len(export_events) == 1
    e = export_events[0]
    assert e.target_type == "request"
    assert e.target_id == str(request.id)
    assert set(e.details.keys()) == {"request_id", "format", "event_count"}
    assert e.details["format"] == "json"


async def test_export_audit_events_do_not_appear_in_timeline(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """An export must NOT show up inside the very timeline it produced.

    The new event types are deliberately outside the timeline
    projection's surfaced set, which keeps the export safe and
    non-recursive.
    """
    user_org = await _create_user_org(db_session)
    contract = await _seed_contract_with_events(db_session, user_org)

    # Trigger an export so the audit event exists.
    resp = await client.get(
        f"/api/contracts/{contract.id}/activity/export?format=csv",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200

    # Read the timeline back.
    tl = await client.get(
        f"/api/contracts/{contract.id}/activity",
        headers=_headers(user_org.user),
    )
    assert tl.status_code == 200
    types = [item["event_type"] for item in tl.json()["items"]]
    assert AuditEventType.CONTRACT_ACTIVITY_EXPORTED.value not in types
