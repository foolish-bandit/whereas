"""API tests for the dev-only first-run setup endpoints."""
from __future__ import annotations

import secrets
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
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

from app.api import setup as setup_api  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.core.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Contract, ExtractedField, Organization, User  # noqa: E402
from app.security.audit_log import AuditEvent, AuditEventType  # noqa: E402
from app.security.encryption import (  # noqa: E402
    WrappedKey,
    load_org_master_key,
)

_PG_IMAGE = "pgvector/pgvector:pg16"
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
        # Match the contracts api test fixture: only the tables we touch.
        # Contract/ExtractedField are pulled in because the smoke test
        # below calls GET /api/contracts.
        tables = [
            Organization.__table__,
            User.__table__,
            AuditEvent.__table__,
            Contract.__table__,
            ExtractedField.__table__,
        ]
    else:
        engine = create_async_engine(_container_async_url(postgres_container), echo=False)
        tables = list(Base.metadata.sorted_tables)

    if engine.dialect.name == "sqlite":
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
async def client(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[httpx.AsyncClient]:
    monkeypatch.setenv("WHEREAS_INSTANCE_KEY", _INSTANCE_KEY.hex())
    # Ensure dev-mode setup is enabled by default in tests.
    monkeypatch.setenv("ENVIRONMENT", "development")
    get_settings.cache_clear()

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
    get_settings.cache_clear()


class TestSetupStatus:
    async def test_setup_required_on_empty_database(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.get("/api/setup/status")
        assert response.status_code == 200
        body = response.json()
        assert body["setup_required"] is True
        assert body["organization_count"] == 0
        assert body["user_count"] == 0
        assert body["dev_mode_enabled"] is True
        assert isinstance(body["message"], str) and body["message"]

    async def test_setup_complete_after_creation(
        self, client: httpx.AsyncClient
    ) -> None:
        await client.post("/api/setup/dev", json={})
        response = await client.get("/api/setup/status")
        body = response.json()
        assert body["setup_required"] is False
        assert body["organization_count"] == 1
        assert body["user_count"] == 1


class TestCreateDevSetup:
    async def test_creates_org_user_and_wraps_master_key(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        response = await client.post("/api/setup/dev", json={})
        assert response.status_code == 200
        body = response.json()

        assert body["organization_name"] == setup_api.DEFAULT_ORG_NAME
        assert body["user_email"] == setup_api.DEFAULT_USER_EMAIL
        assert uuid.UUID(body["organization_id"])
        assert uuid.UUID(body["user_id"])
        assert body["dev_user_id"] == body["user_id"]
        assert "Created new development workspace" in body["message"]

        # Org has a wrapped master key that unwraps under the test
        # instance key.
        org = (
            await db_session.execute(
                select(Organization).where(
                    Organization.id == uuid.UUID(body["organization_id"])
                )
            )
        ).scalar_one()
        assert org.wrapped_master_key is not None
        master = load_org_master_key(
            wrapped_master_key=WrappedKey.from_bytes(org.wrapped_master_key),
            organization_id=str(org.id),
            instance_key=_INSTANCE_KEY,
        )
        assert len(master) == 32  # AES-256 key

        # User is active and lives in that org.
        user = (
            await db_session.execute(
                select(User).where(User.id == uuid.UUID(body["user_id"]))
            )
        ).scalar_one()
        assert user.is_active is True
        assert user.organization_id == org.id
        assert user.email == setup_api.DEFAULT_USER_EMAIL

        # Audit chain has the USER_CREATED event for this user.
        events = (
            await db_session.execute(
                select(AuditEvent).where(AuditEvent.organization_id == org.id)
            )
        ).scalars().all()
        assert any(
            e.event_type == AuditEventType.USER_CREATED.value for e in events
        )

    async def test_response_does_not_leak_secrets(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post("/api/setup/dev", json={})
        body = response.json()
        forbidden = {
            "wrapped_master_key",
            "wrapped_dek",
            "password_hash",
            "instance_key",
            "secret_key",
        }
        assert forbidden.isdisjoint(body.keys())

    async def test_idempotent_returns_existing_workspace(
        self, client: httpx.AsyncClient
    ) -> None:
        first = await client.post("/api/setup/dev", json={})
        assert first.status_code == 200
        second = await client.post("/api/setup/dev", json={})
        assert second.status_code == 200

        a, b = first.json(), second.json()
        assert a["organization_id"] == b["organization_id"]
        assert a["user_id"] == b["user_id"]
        assert "Returned existing development workspace" in b["message"]
        assert "Created new development workspace" not in b["message"]

    async def test_blank_inputs_fall_back_to_defaults(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post(
            "/api/setup/dev",
            json={
                "organization_name": "   ",
                "user_email": None,
                "user_name": "",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["organization_name"] == setup_api.DEFAULT_ORG_NAME
        assert body["user_email"] == setup_api.DEFAULT_USER_EMAIL

    async def test_custom_inputs_are_used(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post(
            "/api/setup/dev",
            json={
                "organization_name": "Acme Legal",
                "user_email": "founder@example.com",
                "user_name": "Founder",
            },
        )
        body = response.json()
        assert body["organization_name"] == "Acme Legal"
        assert body["user_email"] == "founder@example.com"

    async def test_returned_dev_user_can_call_contracts(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post("/api/setup/dev", json={})
        dev_user_id = response.json()["dev_user_id"]
        listing = await client.get(
            "/api/contracts",
            headers={"X-Whereas-Dev-User": dev_user_id},
        )
        assert listing.status_code == 200
        assert listing.json() == []

    async def test_backfills_wrapped_key_on_stranded_org(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        # Pre-create a legacy org with no wrapped key.
        legacy_org = Organization(name="Legacy", wrapped_master_key=None)
        db_session.add(legacy_org)
        await db_session.commit()

        response = await client.post("/api/setup/dev", json={})
        assert response.status_code == 200
        body = response.json()
        assert body["organization_id"] == str(legacy_org.id)
        assert "Backfilled wrapped master key" in body["message"]

        await db_session.refresh(legacy_org)
        assert legacy_org.wrapped_master_key is not None

    async def test_does_not_overwrite_existing_wrapped_key(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        # Pre-create an org with a wrapped key that we'll later compare.
        legacy_org = Organization(name="Legacy", wrapped_master_key=None)
        db_session.add(legacy_org)
        await db_session.commit()
        await client.post("/api/setup/dev", json={})
        await db_session.refresh(legacy_org)
        original_key = legacy_org.wrapped_master_key
        assert original_key is not None

        # Re-running setup must not change the wrapped key.
        await client.post("/api/setup/dev", json={})
        await db_session.refresh(legacy_org)
        assert legacy_org.wrapped_master_key == original_key


class TestProductionBlocking:
    async def test_status_blocked_in_production(
        self,
        client: httpx.AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("ENVIRONMENT", "production")
        get_settings.cache_clear()
        try:
            response = await client.get("/api/setup/status")
            assert response.status_code == 403
            assert "production" in response.json()["detail"].lower()
        finally:
            get_settings.cache_clear()

    async def test_create_blocked_in_production(
        self,
        client: httpx.AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("ENVIRONMENT", "production")
        get_settings.cache_clear()
        try:
            response = await client.post("/api/setup/dev", json={})
            assert response.status_code == 403
        finally:
            get_settings.cache_clear()

    async def test_allowed_in_test_environment(
        self,
        client: httpx.AsyncClient,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("ENVIRONMENT", "test")
        get_settings.cache_clear()
        try:
            response = await client.get("/api/setup/status")
            assert response.status_code == 200
        finally:
            get_settings.cache_clear()
