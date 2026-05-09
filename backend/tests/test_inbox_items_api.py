"""API tests for ``/api/inbox-items``."""
from __future__ import annotations

import secrets
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
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
    Contract,
    ContractRequest,
    InboxItem,
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
        tables = [
            Organization.__table__,
            User.__table__,
            AuditEvent.__table__,
            Contract.__table__,
            AgreementTemplate.__table__,
            ContractRequest.__table__,
            InboxItem.__table__,
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


async def test_create_inbox_item_general(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    response = await client.post(
        "/api/inbox-items",
        headers=_headers(user_org.user),
        json={
            "title": "Reach out to counsel",
            "item_type": "general",
            "priority": "high",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["item_type"] == "general"
    assert body["status"] == "open"
    assert body["priority"] == "high"
    assert body["request_id"] is None


async def test_inbox_get_and_update(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/inbox-items",
        headers=_headers(user_org.user),
        json={"title": "Original", "item_type": "general"},
    )
    item_id = created.json()["id"]

    got = await client.get(
        f"/api/inbox-items/{item_id}", headers=_headers(user_org.user)
    )
    assert got.status_code == 200

    patched = await client.patch(
        f"/api/inbox-items/{item_id}",
        headers=_headers(user_org.user),
        json={"title": "Updated", "status": "completed"},
    )
    assert patched.status_code == 200
    assert patched.json()["title"] == "Updated"
    assert patched.json()["status"] == "completed"


async def test_dismiss_inbox_item_excluded_by_default(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    keep = await client.post(
        "/api/inbox-items",
        headers=_headers(user_org.user),
        json={"title": "Keep me", "item_type": "general"},
    )
    drop = await client.post(
        "/api/inbox-items",
        headers=_headers(user_org.user),
        json={"title": "Dismiss me", "item_type": "general"},
    )
    drop_id = drop.json()["id"]

    cancel = await client.delete(
        f"/api/inbox-items/{drop_id}", headers=_headers(user_org.user)
    )
    assert cancel.status_code == 204

    listed = await client.get(
        "/api/inbox-items", headers=_headers(user_org.user)
    )
    ids = [r["id"] for r in listed.json()]
    assert keep.json()["id"] in ids
    assert drop_id not in ids

    listed_all = await client.get(
        "/api/inbox-items?include_dismissed=true",
        headers=_headers(user_org.user),
    )
    ids_all = {r["id"] for r in listed_all.json()}
    assert drop_id in ids_all


async def test_filter_by_item_type_and_status(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    await client.post(
        "/api/inbox-items",
        headers=_headers(user_org.user),
        json={"title": "g1", "item_type": "general"},
    )
    await client.post(
        "/api/inbox-items",
        headers=_headers(user_org.user),
        json={"title": "c1", "item_type": "contract_review"},
    )

    listed = await client.get(
        "/api/inbox-items?item_type=contract_review",
        headers=_headers(user_org.user),
    )
    assert {r["title"] for r in listed.json()} == {"c1"}

    listed_open = await client.get(
        "/api/inbox-items?status=open", headers=_headers(user_org.user)
    )
    assert len(listed_open.json()) == 2


async def test_cross_org_inbox_access_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    created = await client.post(
        "/api/inbox-items",
        headers=_headers(org_a.user),
        json={"title": "Org A only", "item_type": "general"},
    )
    item_id = created.json()["id"]
    got = await client.get(
        f"/api/inbox-items/{item_id}", headers=_headers(org_b.user)
    )
    assert got.status_code == 404


async def test_linked_request_must_belong_to_same_org(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")

    other_request = ContractRequest(
        id=uuid.uuid4(),
        organization_id=org_b.org.id,
        title="Org B request",
        status="open",
    )
    db_session.add(other_request)
    await db_session.commit()

    response = await client.post(
        "/api/inbox-items",
        headers=_headers(org_a.user),
        json={
            "title": "Cross-org",
            "item_type": "request_review",
            "request_id": str(other_request.id),
        },
    )
    assert response.status_code == 422


async def test_invalid_status_update_rejected(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    created = await client.post(
        "/api/inbox-items",
        headers=_headers(user_org.user),
        json={"title": "x", "item_type": "general"},
    )
    item_id = created.json()["id"]
    patched = await client.patch(
        f"/api/inbox-items/{item_id}",
        headers=_headers(user_org.user),
        json={"status": "banana"},
    )
    assert patched.status_code == 422


async def test_filter_by_due_window(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    early = await client.post(
        "/api/inbox-items",
        headers=_headers(user_org.user),
        json={"title": "early", "item_type": "general", "due_date": "2026-04-01"},
    )
    late = await client.post(
        "/api/inbox-items",
        headers=_headers(user_org.user),
        json={"title": "late", "item_type": "general", "due_date": "2026-08-01"},
    )

    listed = await client.get(
        "/api/inbox-items?due_before=2026-05-01",
        headers=_headers(user_org.user),
    )
    ids = {r["id"] for r in listed.json()}
    assert early.json()["id"] in ids
    assert late.json()["id"] not in ids
