"""PR #109 — Cross-cutting API response leak audit.

Exercises the list/detail/error responses of every major resource
group with a freshly-bootstrapped dev workspace and asserts that
none of the ``FORBIDDEN_RESPONSE_TOKENS`` from
``tests/_response_audit.py`` appear in any response payload.

The individual ``test_*_api.py`` files already carry narrow
forbidden-substring scans (117 such assertions at the time of
writing). This file is the cross-cutting backstop: a new endpoint
added without its own scan still passes through here, and the
canonical token list lives in one place.

Endpoint coverage:
    GET  /api/setup/status                          (config-like)
    POST /api/setup/dev                             (org/user bootstrap)
    GET  /api/contracts                             (Repository list)
    GET  /api/contracts/<missing>                   (Repository detail 404)
    GET  /api/contracts/<missing>/artifacts          (artifact list 404)
    GET  /api/contracts/<missing>/clauses           (clause list 404)
    GET  /api/contracts/<missing>/activity          (activity 404)
    GET  /api/contracts/<missing>/activity/export   (export 404)
    GET  /api/contracts/<missing>/duplicate-candidates (duplicate 404)
    GET  /api/agreement-templates                   (Templates list)
    GET  /api/agreement-templates/<missing>         (Templates detail 404)
    GET  /api/agreement-templates/<missing>/artifacts (artifact list 404)
    GET  /api/agreement-templates/<missing>/variables (variables 404)
    GET  /api/requests                              (Requests list)
    GET  /api/requests/<missing>                    (Requests detail 404)
    GET  /api/requests/<missing>/approval-status    (approval status 404)
    GET  /api/requests/<missing>/activity           (activity 404)
    GET  /api/approval-policies                     (Policies list)
    GET  /api/approval-policies/<missing>           (Policy detail 404)
    GET  /api/approval-workflow-templates           (Workflow templates list)
    GET  /api/approval-workflow-templates/<missing> (Workflow template 404)
    GET  /api/approval-workflows                    (Workflow runs list)
    GET  /api/approval-workflows/<missing>          (Workflow run 404)
    GET  /api/inbox-items                           (Inbox list)
    GET  /api/clause-templates                      (Clause templates list)
    GET  /api/playbooks                             (Playbooks list)
    GET  /api/dashboard/summary                     (Dashboard summary)

Binary endpoints (download / preview) are not exercised here —
they return raw bytes by design, are extensively covered by their
own tests, and the helper ``assert_safe_binary_headers`` codifies
the headers-level check those tests can opt into.

No product behavior is changed.
"""
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
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment,misc]

from app.core.config import get_settings  # noqa: E402
from app.core.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    Clause,
    ClauseTemplate,
    Contract,
    ContractArtifact,
    ContractMarkdownSnapshot,
    ExtractedField,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent  # noqa: E402
from tests._response_audit import (  # noqa: E402
    FORBIDDEN_RESPONSE_TOKENS,
    assert_no_forbidden_tokens,
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
        tables = list(Base.metadata.sorted_tables)
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
async def client(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[httpx.AsyncClient]:
    monkeypatch.setenv("WHEREAS_INSTANCE_KEY", _INSTANCE_KEY.hex())
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


# Suppress noisy unused-import warnings — these models are required so
# Base.metadata picks them up for create_all on the SQLite fallback.
_KEEP_IMPORTS_ALIVE = (
    Clause,
    ClauseTemplate,
    Contract,
    ContractArtifact,
    ContractMarkdownSnapshot,
    ExtractedField,
    Organization,
    User,
    AuditEvent,
)


async def _bootstrap_dev_user(client: httpx.AsyncClient) -> dict[str, str]:
    """POST /api/setup/dev and return the auth header for subsequent calls."""
    response = await client.post("/api/setup/dev", json={})
    assert response.status_code == 200, response.text
    body = response.json()
    assert_no_forbidden_tokens(body, where="POST /api/setup/dev response")
    return {"X-Whereas-Dev-User": body["user_id"]}


_MISSING = uuid.UUID("00000000-0000-4000-8000-000000000000")


async def _assert_clean(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    expected_status: tuple[int, ...] = (200, 404),
) -> None:
    request_method = getattr(client, method.lower())
    response = await request_method(path, headers=headers or {})
    assert response.status_code in expected_status, (
        f"{method} {path} returned {response.status_code}: {response.text}"
    )
    # Even 4xx error envelopes go through the scanner — leaks are often
    # in the description field of an HTTPException, not the happy path.
    body: Any
    try:
        body = response.json()
    except ValueError:
        body = response.text
    assert_no_forbidden_tokens(body, where=f"{method} {path}")


class TestForbiddenTokenList:
    """Pin the canonical list itself so a future PR shrinking it is intentional."""

    def test_strict_tokens_cover_storage_internals(self) -> None:
        for token in (
            "storage_key",
            "wrapped_dek",
            "wrapped_master_key",
            "org_master_key",
            "s3_key",
        ):
            assert token in FORBIDDEN_RESPONSE_TOKENS

    def test_strict_tokens_cover_signed_urls(self) -> None:
        for token in ("presigned_url", "presigned_uri", "private_url"):
            assert token in FORBIDDEN_RESPONSE_TOKENS

    def test_strict_tokens_cover_docuseal_secrets(self) -> None:
        for token in ("docuseal_webhook_secret", "docuseal_api_token"):
            assert token in FORBIDDEN_RESPONSE_TOKENS


class TestPublicListAndDetailEndpoints:
    """Cross-cutting scan: list endpoints (empty) + 404 detail responses."""

    async def test_setup_status_is_clean(self, client: httpx.AsyncClient) -> None:
        await _assert_clean(client, "GET", "/api/setup/status", expected_status=(200,))

    async def test_setup_dev_response_is_clean(
        self, client: httpx.AsyncClient
    ) -> None:
        await _bootstrap_dev_user(client)

    async def test_repository_list_and_detail_endpoints(
        self, client: httpx.AsyncClient
    ) -> None:
        headers = await _bootstrap_dev_user(client)
        await _assert_clean(client, "GET", "/api/contracts", headers=headers,
                            expected_status=(200,))
        # 404 detail paths — error envelopes are scanned for leaks too.
        await _assert_clean(client, "GET", f"/api/contracts/{_MISSING}", headers=headers)
        await _assert_clean(client, "GET", f"/api/contracts/{_MISSING}/artifacts",
                            headers=headers)
        await _assert_clean(client, "GET", f"/api/contracts/{_MISSING}/clauses",
                            headers=headers)
        await _assert_clean(client, "GET", f"/api/contracts/{_MISSING}/activity",
                            headers=headers)
        await _assert_clean(client, "GET", f"/api/contracts/{_MISSING}/activity/export",
                            headers=headers)
        await _assert_clean(client,
                            "GET",
                            f"/api/contracts/{_MISSING}/duplicate-candidates",
                            headers=headers)

    async def test_agreement_templates_list_and_detail(
        self, client: httpx.AsyncClient
    ) -> None:
        headers = await _bootstrap_dev_user(client)
        await _assert_clean(client, "GET", "/api/agreement-templates",
                            headers=headers, expected_status=(200,))
        await _assert_clean(client, "GET", f"/api/agreement-templates/{_MISSING}",
                            headers=headers)
        await _assert_clean(client,
                            "GET",
                            f"/api/agreement-templates/{_MISSING}/artifacts",
                            headers=headers)
        await _assert_clean(client,
                            "GET",
                            f"/api/agreement-templates/{_MISSING}/variables",
                            headers=headers)

    async def test_requests_list_and_detail(self, client: httpx.AsyncClient) -> None:
        headers = await _bootstrap_dev_user(client)
        await _assert_clean(client, "GET", "/api/requests", headers=headers,
                            expected_status=(200,))
        await _assert_clean(client, "GET", f"/api/requests/{_MISSING}",
                            headers=headers)
        await _assert_clean(client, "GET",
                            f"/api/requests/{_MISSING}/approval-status",
                            headers=headers)
        await _assert_clean(client, "GET", f"/api/requests/{_MISSING}/activity",
                            headers=headers)

    async def test_approval_policies_endpoints(
        self, client: httpx.AsyncClient
    ) -> None:
        headers = await _bootstrap_dev_user(client)
        await _assert_clean(client, "GET", "/api/approval-policies",
                            headers=headers, expected_status=(200,))
        await _assert_clean(client, "GET", f"/api/approval-policies/{_MISSING}",
                            headers=headers)

    async def test_approval_workflow_templates_endpoints(
        self, client: httpx.AsyncClient
    ) -> None:
        headers = await _bootstrap_dev_user(client)
        await _assert_clean(client, "GET", "/api/approval-workflow-templates",
                            headers=headers, expected_status=(200,))
        await _assert_clean(client, "GET",
                            f"/api/approval-workflow-templates/{_MISSING}",
                            headers=headers)

    async def test_approval_workflows_endpoints(
        self, client: httpx.AsyncClient
    ) -> None:
        headers = await _bootstrap_dev_user(client)
        await _assert_clean(client, "GET", "/api/approval-workflows",
                            headers=headers, expected_status=(200,))
        await _assert_clean(client, "GET", f"/api/approval-workflows/{_MISSING}",
                            headers=headers)

    async def test_inbox_clause_templates_playbooks_endpoints(
        self, client: httpx.AsyncClient
    ) -> None:
        headers = await _bootstrap_dev_user(client)
        await _assert_clean(client, "GET", "/api/inbox-items", headers=headers,
                            expected_status=(200,))
        await _assert_clean(client, "GET", "/api/clause-templates",
                            headers=headers, expected_status=(200,))
        await _assert_clean(client, "GET", "/api/playbooks", headers=headers,
                            expected_status=(200,))

    async def test_dashboard_summary_is_clean(
        self, client: httpx.AsyncClient
    ) -> None:
        headers = await _bootstrap_dev_user(client)
        await _assert_clean(client, "GET", "/api/dashboard/summary",
                            headers=headers, expected_status=(200,))


class TestAuditEventDetails:
    """Audit events written during the bootstrap path also obey the scrub."""

    async def test_setup_dev_audit_details_are_clean(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        await _bootstrap_dev_user(client)
        events = (
            await db_session.execute(select(AuditEvent))
        ).scalars().all()
        # At minimum a USER_CREATED event lands; multiple are fine.
        assert events, "setup endpoint should emit at least one audit event"
        for event_row in events:
            assert_no_forbidden_tokens(
                event_row.details,
                where=f"AuditEvent({event_row.event_type}).details",
            )


class TestUnauthorizedResponseIsClean:
    """Even auth-failure envelopes must not leak."""

    async def test_missing_dev_user_header(self, client: httpx.AsyncClient) -> None:
        # No org / user yet, no header — endpoint should 401 cleanly.
        await _assert_clean(client, "GET", "/api/contracts",
                            expected_status=(401, 403))
