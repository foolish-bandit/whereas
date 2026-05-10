"""API tests for ``/api/requests`` and request -> inbox auto-creation."""
from __future__ import annotations

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
    Contract,
    ContractRequest,
    ContractRequestStatus,
    InboxItem,
    InboxItemStatus,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)


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
        # Whitelisted tables for SQLite — the requests/inbox surface
        # only needs orgs, users, contracts, agreement templates,
        # the new request + inbox tables, and the audit table.
        # ApprovalPolicy + workflow tables are required because the
        # request create/update paths call ``apply_approval_policies_to_request``
        # (PR #53), which needs ``approval_policies`` to exist even when
        # no policies match.
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


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_create_request_creates_inbox_item(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    response = await client.post(
        "/api/requests",
        headers=_headers(user_org.user),
        json={
            "title": "NDA with Acme",
            "request_type": "new_contract",
            "contract_type": "NDA",
            "priority": "normal",
            "counterparty_name": "Acme Corp",
            "due_date": "2026-06-01",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "NDA with Acme"
    assert body["status"] == "open"
    assert body["due_date"] == "2026-06-01"
    request_id = body["id"]

    inbox = await client.get(
        "/api/inbox-items", headers=_headers(user_org.user)
    )
    assert inbox.status_code == 200
    items = inbox.json()
    assert len(items) == 1
    item = items[0]
    assert item["item_type"] == "request_review"
    assert item["status"] == "open"
    assert item["request_id"] == request_id
    assert item["title"].startswith("Review request:")
    assert item["due_date"] == "2026-06-01"
    assert item["priority"] == "normal"


async def test_get_request(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/requests",
        headers=_headers(user_org.user),
        json={"title": "Renewal review"},
    )
    request_id = created.json()["id"]

    got = await client.get(
        f"/api/requests/{request_id}", headers=_headers(user_org.user)
    )
    assert got.status_code == 200
    assert got.json()["id"] == request_id


async def test_list_requests_excludes_cancelled_by_default(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    keep = await client.post(
        "/api/requests",
        headers=_headers(user_org.user),
        json={"title": "Keep me"},
    )
    drop = await client.post(
        "/api/requests",
        headers=_headers(user_org.user),
        json={"title": "Cancel me"},
    )
    drop_id = drop.json()["id"]

    cancel = await client.delete(
        f"/api/requests/{drop_id}", headers=_headers(user_org.user)
    )
    assert cancel.status_code == 204

    listed = await client.get(
        "/api/requests", headers=_headers(user_org.user)
    )
    ids = [r["id"] for r in listed.json()]
    assert keep.json()["id"] in ids
    assert drop_id not in ids

    listed_all = await client.get(
        "/api/requests?include_cancelled=true",
        headers=_headers(user_org.user),
    )
    ids_all = [r["id"] for r in listed_all.json()]
    assert drop_id in ids_all


async def test_list_requests_filters_status_and_assignee(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)

    other_user = User(
        id=uuid.uuid4(),
        organization_id=user_org.org.id,
        email=f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Other",
        is_active=True,
    )
    db_session.add(other_user)
    await db_session.commit()

    own = await client.post(
        "/api/requests",
        headers=_headers(user_org.user),
        json={"title": "Mine", "assigned_to": str(user_org.user.id)},
    )
    other = await client.post(
        "/api/requests",
        headers=_headers(user_org.user),
        json={"title": "Theirs", "assigned_to": str(other_user.id)},
    )

    listed = await client.get(
        f"/api/requests?assigned_to={user_org.user.id}",
        headers=_headers(user_org.user),
    )
    ids = {r["id"] for r in listed.json()}
    assert own.json()["id"] in ids
    assert other.json()["id"] not in ids


async def test_update_request_status_completed_resolves_open_inbox_item(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/requests",
        headers=_headers(user_org.user),
        json={"title": "Wrap up"},
    )
    request_id = created.json()["id"]

    patched = await client.patch(
        f"/api/requests/{request_id}",
        headers=_headers(user_org.user),
        json={"status": "completed"},
    )
    assert patched.status_code == 200
    assert patched.json()["status"] == "completed"

    inbox = await client.get(
        "/api/inbox-items?include_dismissed=true",
        headers=_headers(user_org.user),
    )
    items = inbox.json()
    assert len(items) == 1
    assert items[0]["status"] == "completed"


async def test_cancel_request_dismisses_open_inbox_item(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/requests",
        headers=_headers(user_org.user),
        json={"title": "Mistaken request"},
    )
    request_id = created.json()["id"]

    cancel = await client.delete(
        f"/api/requests/{request_id}", headers=_headers(user_org.user)
    )
    assert cancel.status_code == 204

    inbox = await client.get(
        "/api/inbox-items?include_dismissed=true",
        headers=_headers(user_org.user),
    )
    items = inbox.json()
    assert len(items) == 1
    assert items[0]["status"] == "dismissed"


async def test_cross_org_request_access_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    created = await client.post(
        "/api/requests",
        headers=_headers(org_a.user),
        json={"title": "Org A only"},
    )
    request_id = created.json()["id"]

    got = await client.get(
        f"/api/requests/{request_id}", headers=_headers(org_b.user)
    )
    assert got.status_code == 404


async def test_linked_template_must_belong_to_same_org(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")

    other_template = AgreementTemplate(
        id=uuid.uuid4(),
        organization_id=org_b.org.id,
        name="Other org template",
        status="active",
    )
    db_session.add(other_template)
    await db_session.commit()

    response = await client.post(
        "/api/requests",
        headers=_headers(org_a.user),
        json={
            "title": "Try to link",
            "linked_template_id": str(other_template.id),
        },
    )
    assert response.status_code == 422


async def test_request_creation_rolls_back_on_inbox_failure(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """If the inbox insert fails, the request insert must roll back too.

    We force a failure by patching the InboxItem class to a sentinel
    that raises on instantiation. The override_get_db wrapper rolls the
    session back on exception, so no ContractRequest row should
    survive.
    """
    user_org = await _create_user_org(db_session)
    pre = (await db_session.execute(select(ContractRequest))).scalars().all()
    assert pre == []

    from app.api import requests as request_routes

    class _Boom:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("inbox insert failed")

    original = request_routes.InboxItem
    request_routes.InboxItem = _Boom  # type: ignore[assignment]
    try:
        with pytest.raises(RuntimeError, match="inbox insert failed"):
            await client.post(
                "/api/requests",
                headers=_headers(user_org.user),
                json={"title": "Doomed"},
            )
    finally:
        request_routes.InboxItem = original  # type: ignore[assignment]

    # The session was rolled back by override_get_db on exception; reset
    # this test's view of it before reading.
    await db_session.rollback()
    after = (await db_session.execute(select(ContractRequest))).scalars().all()
    assert after == []


async def test_invalid_status_filter_rejected(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    response = await client.get(
        "/api/requests?status=banana", headers=_headers(user_org.user)
    )
    assert response.status_code == 422


async def test_invalid_status_update_rejected(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/requests",
        headers=_headers(user_org.user),
        json={"title": "x"},
    )
    request_id = created.json()["id"]
    response = await client.patch(
        f"/api/requests/{request_id}",
        headers=_headers(user_org.user),
        json={"status": "banana"},
    )
    assert response.status_code == 422


async def test_status_enum_values_are_complete() -> None:
    # Guard: if someone adds a status, the API filter set should be
    # updated. Cheap sanity check that does not need the DB.
    assert {s.value for s in ContractRequestStatus} == {
        "open",
        "in_progress",
        "completed",
        "cancelled",
    }
    assert {s.value for s in InboxItemStatus} == {
        "open",
        "completed",
        "dismissed",
    }
