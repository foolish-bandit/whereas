"""API tests for the playbooks router.

The router is the public surface — we exercise it end-to-end through
an httpx ASGI transport against an in-memory SQLite database (or a
real Postgres if Docker is reachable). The loader itself is unit
tested separately in `test_playbook_loader.py`.
"""
from __future__ import annotations

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
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment,misc]

from app.core.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    Organization,
    Playbook,
    User,
)
from app.security.audit_log import AuditEvent  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)


VALID_PLAYBOOK_YAML = """
name: "Mutual NDA Review Playbook"
description: "Baseline review rules for mutual NDAs."
version: "1.0"
jurisdiction: "California"
contract_type: "mutual_nda"

rules:
  - id: "confidentiality-definition-required"
    title: "Confidential Information definition should be present"
    clause_type: "confidentiality"
    severity: "high"
    rule_type: "required_clause"
    description: "The agreement should define confidential information."
    guidance: "Look for a clause defining what information is protected."

  - id: "governing-law-california"
    title: "Governing law should be California"
    clause_type: "governing_law"
    severity: "medium"
    rule_type: "preferred_value"
    expected_value: "California"

  - id: "assignment-consent-required"
    title: "Assignment should require consent"
    clause_type: "assignment"
    severity: "medium"
    rule_type: "text_contains"
    required_terms:
      - "consent"
      - "prior written consent"
"""

INVALID_PLAYBOOK_YAML = """
name: "Bad"
rules:
  - id: "no-rule-type"
    title: "Missing rule_type"
    clause_type: "x"
    severity: "low"
"""


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
        # Only what the playbook router touches.
        tables = [
            Organization.__table__,
            User.__table__,
            AuditEvent.__table__,
            Playbook.__table__,
        ]
    else:
        engine = create_async_engine(_container_async_url(postgres_container), echo=False)
        tables = list(Base.metadata.sorted_tables)

    if engine.dialect.name == "sqlite":
        @event.listens_for(engine.sync_engine, "connect")
        def _enable_sqlite_foreign_keys(dbapi_connection: Any, _record: Any) -> None:
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
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
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
    active: bool = True,
    email: str | None = None,
) -> UserOrg:
    org = Organization(
        id=uuid.uuid4(),
        name=f"Org {uuid.uuid4()}",
        wrapped_master_key=_wrapped_org_key(uuid.uuid4()),
    )
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


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


# --------------------------------------------------------------------------
# Auth / scoping
# --------------------------------------------------------------------------


class TestAuth:
    async def test_missing_dev_user_header_returns_401(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.get("/api/playbooks")
        assert response.status_code == 401

    async def test_invalid_dev_user_uuid_returns_401(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.get(
            "/api/playbooks", headers={"X-Whereas-Dev-User": "not-a-uuid"}
        )
        assert response.status_code == 401

    async def test_unknown_dev_user_returns_401(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.get(
            "/api/playbooks", headers={"X-Whereas-Dev-User": str(uuid.uuid4())}
        )
        assert response.status_code == 401

    async def test_inactive_dev_user_returns_403(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session, active=False)
        response = await client.get("/api/playbooks", headers=_headers(user_org.user))
        assert response.status_code == 403


# --------------------------------------------------------------------------
# Validation endpoint
# --------------------------------------------------------------------------


class TestValidateEndpoint:
    async def test_validate_happy_path(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        response = await client.post(
            "/api/playbooks/validate",
            headers=_headers(user_org.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is True
        assert body["name"] == "Mutual NDA Review Playbook"
        assert body["rule_count"] == 3
        assert body["jurisdiction"] == "California"
        assert body["contract_type"] == "mutual_nda"
        assert {r["rule_type"] for r in body["rules"]} == {
            "required_clause",
            "preferred_value",
            "text_contains",
        }

    async def test_validate_invalid_yaml_returns_structured_400(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        response = await client.post(
            "/api/playbooks/validate",
            headers=_headers(user_org.user),
            json={"yaml_source": INVALID_PLAYBOOK_YAML},
        )
        assert response.status_code == 400
        detail = response.json()["detail"]
        assert detail["ok"] is False
        assert isinstance(detail["errors"], list)
        assert detail["errors"], "errors list must not be empty"
        # The validator surfaces dotted paths so the editor can highlight.
        assert any(
            err.get("path", "").startswith("rules.0") for err in detail["errors"]
        )

    async def test_validate_does_not_persist(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        await client.post(
            "/api/playbooks/validate",
            headers=_headers(user_org.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        result = await db_session.execute(select(Playbook))
        assert result.scalar_one_or_none() is None

    async def test_validate_requires_dev_user(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post(
            "/api/playbooks/validate",
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        assert response.status_code == 401


# --------------------------------------------------------------------------
# Create endpoint
# --------------------------------------------------------------------------


class TestCreateEndpoint:
    async def test_create_persists_full_playbook(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        response = await client.post(
            "/api/playbooks",
            headers=_headers(user_org.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["name"] == "Mutual NDA Review Playbook"
        assert body["jurisdiction"] == "California"
        assert body["contract_type"] == "mutual_nda"
        assert body["version"] == "1.0"
        assert body["is_active"] is True
        assert body["rule_count"] == 3
        assert body["yaml_source"] == VALID_PLAYBOOK_YAML
        # parsed_rules round-trips and includes the discriminator.
        rule_types = {r["rule_type"] for r in body["parsed_rules"]["rules"]}
        assert rule_types == {
            "required_clause",
            "preferred_value",
            "text_contains",
        }
        assert {r["rule_type"] for r in body["rules"]} == rule_types

        # Persisted row matches the response.
        playbook_id = uuid.UUID(body["id"])
        playbook = await db_session.get(Playbook, playbook_id)
        assert playbook is not None
        assert playbook.organization_id == user_org.org.id
        assert playbook.name == "Mutual NDA Review Playbook"
        assert playbook.version == "1.0"
        assert playbook.is_active is True

    async def test_create_rejects_invalid_yaml_with_400(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        response = await client.post(
            "/api/playbooks",
            headers=_headers(user_org.user),
            json={"yaml_source": INVALID_PLAYBOOK_YAML},
        )
        assert response.status_code == 400
        # Nothing persisted.
        result = await db_session.execute(select(Playbook))
        assert result.scalar_one_or_none() is None

    async def test_create_rejects_duplicate_name_in_same_org(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        first = await client.post(
            "/api/playbooks",
            headers=_headers(user_org.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        assert first.status_code == 201
        duplicate = await client.post(
            "/api/playbooks",
            headers=_headers(user_org.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        assert duplicate.status_code == 409

    async def test_same_name_allowed_in_different_orgs(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        first = await _create_user_org(db_session, email="a@example.com")
        second = await _create_user_org(db_session, email="b@example.com")
        first_resp = await client.post(
            "/api/playbooks",
            headers=_headers(first.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        second_resp = await client.post(
            "/api/playbooks",
            headers=_headers(second.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        assert first_resp.status_code == 201
        assert second_resp.status_code == 201
        assert first_resp.json()["id"] != second_resp.json()["id"]


# --------------------------------------------------------------------------
# List / detail endpoints
# --------------------------------------------------------------------------


class TestListEndpoint:
    async def test_list_returns_only_caller_org_rows(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        first = await _create_user_org(db_session, email="list-a@example.com")
        second = await _create_user_org(db_session, email="list-b@example.com")
        await client.post(
            "/api/playbooks",
            headers=_headers(first.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        # Other org gets a playbook with a different name to avoid the
        # global-name confusion: still must not appear in the first org's list.
        other_yaml = VALID_PLAYBOOK_YAML.replace(
            'name: "Mutual NDA Review Playbook"',
            'name: "Other Org Playbook"',
        )
        await client.post(
            "/api/playbooks",
            headers=_headers(second.user),
            json={"yaml_source": other_yaml},
        )

        response = await client.get(
            "/api/playbooks", headers=_headers(first.user)
        )
        assert response.status_code == 200
        rows = response.json()
        assert len(rows) == 1
        assert rows[0]["name"] == "Mutual NDA Review Playbook"

    async def test_list_default_excludes_deactivated_playbooks(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        # Create one playbook, then deactivate it.
        created = await client.post(
            "/api/playbooks",
            headers=_headers(user_org.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        playbook_id = created.json()["id"]
        await client.delete(
            f"/api/playbooks/{playbook_id}", headers=_headers(user_org.user)
        )

        # Default list hides deactivated rows. The "what playbooks do
        # we have" view is the common case; archived ones are opt-in.
        default_rows = await client.get(
            "/api/playbooks", headers=_headers(user_org.user)
        )
        assert default_rows.status_code == 200
        assert default_rows.json() == []

        # include_inactive=true surfaces them again.
        with_inactive = await client.get(
            "/api/playbooks?include_inactive=true",
            headers=_headers(user_org.user),
        )
        assert with_inactive.status_code == 200
        rows = with_inactive.json()
        assert len(rows) == 1
        assert rows[0]["id"] == playbook_id
        assert rows[0]["is_active"] is False


class TestDetailEndpoint:
    async def test_detail_returns_yaml_and_parsed_rules(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        created = await client.post(
            "/api/playbooks",
            headers=_headers(user_org.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        playbook_id = created.json()["id"]
        response = await client.get(
            f"/api/playbooks/{playbook_id}", headers=_headers(user_org.user)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["yaml_source"] == VALID_PLAYBOOK_YAML
        assert body["parsed_rules"]["name"] == "Mutual NDA Review Playbook"
        assert len(body["rules"]) == 3

    async def test_detail_for_other_orgs_playbook_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        first = await _create_user_org(db_session, email="d-a@example.com")
        second = await _create_user_org(db_session, email="d-b@example.com")
        created = await client.post(
            "/api/playbooks",
            headers=_headers(first.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        playbook_id = created.json()["id"]

        response = await client.get(
            f"/api/playbooks/{playbook_id}", headers=_headers(second.user)
        )
        # 404 not 403 — do not leak existence across orgs.
        assert response.status_code == 404

    async def test_detail_for_unknown_id_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        response = await client.get(
            f"/api/playbooks/{uuid.uuid4()}", headers=_headers(user_org.user)
        )
        assert response.status_code == 404

    async def test_detail_for_deactivated_playbook_returns_404_by_default(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        """Inactive playbooks 404 unless the caller opts in.

        Same logic as cross-org access — do not surface archived rows
        to clients that haven't asked for them. Symmetric with the
        list endpoint's default.
        """
        user_org = await _create_user_org(db_session)
        # Cache the header dict so we don't lazy-load `user.id` again
        # after the override_get_db dependency has committed and
        # expired the row across the four sequential requests below.
        headers = _headers(user_org.user)
        created = await client.post(
            "/api/playbooks",
            headers=headers,
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        playbook_id = created.json()["id"]
        await client.delete(f"/api/playbooks/{playbook_id}", headers=headers)

        default = await client.get(
            f"/api/playbooks/{playbook_id}", headers=headers
        )
        assert default.status_code == 404

        with_inactive = await client.get(
            f"/api/playbooks/{playbook_id}?include_inactive=true",
            headers=headers,
        )
        assert with_inactive.status_code == 200
        assert with_inactive.json()["id"] == playbook_id
        assert with_inactive.json()["is_active"] is False


# --------------------------------------------------------------------------
# Soft delete
# --------------------------------------------------------------------------


class TestDeactivate:
    async def test_deactivate_flips_is_active(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        created = await client.post(
            "/api/playbooks",
            headers=_headers(user_org.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        playbook_id = uuid.UUID(created.json()["id"])

        response = await client.delete(
            f"/api/playbooks/{playbook_id}", headers=_headers(user_org.user)
        )
        assert response.status_code == 200
        assert response.json()["is_active"] is False

        # Row still exists; we soft-delete only.
        playbook = await db_session.get(Playbook, playbook_id)
        assert playbook is not None
        assert playbook.is_active is False

    async def test_deactivate_idempotent(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        user_org = await _create_user_org(db_session)
        created = await client.post(
            "/api/playbooks",
            headers=_headers(user_org.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        playbook_id = created.json()["id"]
        first = await client.delete(
            f"/api/playbooks/{playbook_id}", headers=_headers(user_org.user)
        )
        second = await client.delete(
            f"/api/playbooks/{playbook_id}", headers=_headers(user_org.user)
        )
        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["is_active"] is False
        assert second.json()["is_active"] is False

    async def test_deactivate_other_org_playbook_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        first = await _create_user_org(db_session, email="del-a@example.com")
        second = await _create_user_org(db_session, email="del-b@example.com")
        created = await client.post(
            "/api/playbooks",
            headers=_headers(first.user),
            json={"yaml_source": VALID_PLAYBOOK_YAML},
        )
        playbook_id = created.json()["id"]
        response = await client.delete(
            f"/api/playbooks/{playbook_id}", headers=_headers(second.user)
        )
        assert response.status_code == 404
        # Original row untouched.
        playbook = await db_session.get(Playbook, uuid.UUID(playbook_id))
        assert playbook is not None
        assert playbook.is_active is True
