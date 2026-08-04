"""HTTP tests for deterministic finding remediation planning and task routing."""
from __future__ import annotations

import secrets
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import func, select
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
    Clause,
    ClauseTemplate,
    Contract,
    ContractRequest,
    DeviationFinding,
    InboxItem,
    Organization,
    Playbook,
    PlaybookReviewRun,
    User,
)
from app.models.remediation import FindingRemediationTask  # noqa: E402
from app.security.audit_log import AuditEvent  # noqa: E402

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
            Clause.__table__,
            Playbook.__table__,
            PlaybookReviewRun.__table__,
            ClauseTemplate.__table__,
            DeviationFinding.__table__,
            AgreementTemplate.__table__,
            ContractRequest.__table__,
            InboxItem.__table__,
            FindingRemediationTask.__table__,
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
class SeededFinding:
    org: Organization
    user: User
    contract: Contract
    playbook: Playbook
    review_run: PlaybookReviewRun
    finding: DeviationFinding


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


async def _seed_finding(
    session: AsyncSession,
    *,
    email: str | None = None,
    preferred_language: str | None = None,
    severity: str = "high",
    clause_type: str = "governing_law",
) -> SeededFinding:
    org_id = uuid.uuid4()
    user_id = uuid.uuid4()
    contract_id = uuid.uuid4()
    playbook_id = uuid.uuid4()
    run_id = uuid.uuid4()
    finding_id = uuid.uuid4()

    org = Organization(id=org_id, name=f"Org {org_id}")
    user = User(
        id=user_id,
        organization_id=org_id,
        email=email or f"{user_id}@example.com",
        password_hash="hash",
        display_name="Test Reviewer",
        is_active=True,
    )
    contract = Contract(
        id=contract_id,
        organization_id=org_id,
        uploaded_by=user_id,
        title="Vendor MSA",
        status="ready",
        s3_key=f"test/{contract_id}.docx",
        mime_type=(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ),
        file_hash_sha256="a" * 64,
    )
    playbook = Playbook(
        id=playbook_id,
        organization_id=org_id,
        name="MSA review",
        version="1.0",
        yaml_source="name: MSA review\nrules: []\n",
        parsed_rules={"rules": []},
        is_active=True,
    )
    review_run = PlaybookReviewRun(
        id=run_id,
        organization_id=org_id,
        contract_id=contract_id,
        playbook_id=playbook_id,
        rules_checked=1,
        failed_count=1,
        passed_count=0,
    )
    finding = DeviationFinding(
        id=finding_id,
        organization_id=org_id,
        contract_id=contract_id,
        playbook_id=playbook_id,
        review_run_id=run_id,
        rule_id="governing-law-california",
        rule_title="Governing law should be California",
        rule_type="preferred_value",
        clause_type=clause_type,
        severity=severity,
        status="fail",
        finding_status="open",
        message="Preferred value was not found.",
        evidence_text="This Agreement is governed by New York law.",
        span_start=20,
        span_end=66,
        matched_terms=[],
        expected_value="California",
        guidance="Use the firm's approved California position.",
        preferred_language=preferred_language,
    )
    session.add_all([org, user, contract, playbook, review_run, finding])
    await session.commit()
    return SeededFinding(org, user, contract, playbook, review_run, finding)


async def _add_template(
    session: AsyncSession,
    seed: SeededFinding,
    *,
    name: str,
    text: str,
    tags: list[str] | None = None,
    clause_type: str = "governing_law",
    jurisdiction: str | None = None,
    contract_type: str | None = None,
    updated_at: datetime | None = None,
) -> ClauseTemplate:
    template = ClauseTemplate(
        id=uuid.uuid4(),
        organization_id=seed.org.id,
        name=name,
        clause_type=clause_type,
        text=text,
        tags=tags,
        jurisdiction=jurisdiction,
        contract_type=contract_type,
        is_active=True,
        updated_at=updated_at,
    )
    session.add(template)
    await session.commit()
    return template


def _plan_url(seed: SeededFinding) -> str:
    return (
        f"/api/contracts/{seed.contract.id}/findings/"
        f"{seed.finding.id}/remediation"
    )


def _task_url(seed: SeededFinding) -> str:
    return f"{_plan_url(seed)}/task"


async def test_plan_prefers_firm_authored_playbook_language(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    preferred = "This Agreement is governed by California law."
    seed = await _seed_finding(db_session, preferred_language=preferred)
    await _add_template(
        db_session,
        seed,
        name="Clause Manager fallback",
        text="Fallback text should not win.",
        tags=["preferred"],
    )

    response = await client.get(_plan_url(seed), headers=_headers(seed.user))

    assert response.status_code == 200
    body = response.json()
    assert body["suggested_language"] == preferred
    assert body["source_type"] == "playbook_preferred_language"
    assert body["source_id"] == str(seed.playbook.id)
    assert body["existing_task"] is None


async def test_plan_uses_stable_clause_manager_fallback_and_scope_warning(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    seed = await _seed_finding(db_session)
    now = datetime(2026, 8, 4, tzinfo=UTC)
    await _add_template(
        db_session,
        seed,
        name="New generic",
        text="Generic language.",
        updated_at=now,
    )
    selected = await _add_template(
        db_session,
        seed,
        name="Firm preferred California MSA",
        text="Approved California language.",
        tags=["preferred"],
        jurisdiction="California",
        contract_type="MSA",
        updated_at=now - timedelta(days=30),
    )

    response = await client.get(_plan_url(seed), headers=_headers(seed.user))

    assert response.status_code == 200
    body = response.json()
    assert body["suggested_language"] == selected.text
    assert body["source_type"] == "clause_template"
    assert body["source_id"] == str(selected.id)
    assert "California" in body["scope_warning"]
    assert "MSA" in body["scope_warning"]


async def test_plan_returns_honest_empty_state_when_no_source_matches(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    seed = await _seed_finding(db_session, clause_type="indemnity")
    await _add_template(
        db_session,
        seed,
        name="Wrong taxonomy",
        text="Assignment language.",
        clause_type="assignment",
    )

    response = await client.get(_plan_url(seed), headers=_headers(seed.user))

    assert response.status_code == 200
    body = response.json()
    assert body["suggested_language"] is None
    assert body["source_type"] == "none"
    assert "Add preferred language" in body["rationale"]


async def test_task_creation_is_idempotent_and_audited_without_legal_text(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    preferred = "Confidential approved California clause text."
    evidence = "This Agreement is governed by New York law."
    seed = await _seed_finding(db_session, preferred_language=preferred)

    first = await client.post(
        _task_url(seed),
        headers=_headers(seed.user),
        json={"due_date": "2026-08-14"},
    )
    second = await client.post(
        _task_url(seed),
        headers=_headers(seed.user),
        json={"due_date": "2026-09-01"},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    first_body = first.json()
    second_body = second.json()
    assert first_body["created"] is True
    assert first_body["reopened"] is False
    assert second_body["created"] is False
    assert second_body["reopened"] is False
    assert first_body["task"]["id"] == second_body["task"]["id"]
    assert second_body["task"]["due_date"] == "2026-08-14"
    assert first_body["task"]["priority"] == "high"
    assert first_body["task"]["assigned_to"] == str(seed.user.id)
    assert first_body["plan"]["existing_task"]["id"] == first_body["task"]["id"]

    inbox_count = await db_session.scalar(
        select(func.count())
        .select_from(InboxItem)
        .where(InboxItem.item_type == "finding_remediation")
    )
    link_count = await db_session.scalar(
        select(func.count()).select_from(FindingRemediationTask)
    )
    assert inbox_count == 1
    assert link_count == 1

    events = (
        await db_session.execute(
            select(AuditEvent).where(
                AuditEvent.organization_id == seed.org.id,
                AuditEvent.event_type == "finding.remediation_task.created",
            )
        )
    ).scalars().all()
    assert len(events) == 1
    serialized_details = repr(events[0].details)
    assert preferred not in serialized_details
    assert evidence not in serialized_details
    assert "inbox_item_id" in events[0].details


async def test_dismissed_task_is_reopened_instead_of_duplicated(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    seed = await _seed_finding(db_session)
    created = await client.post(_task_url(seed), headers=_headers(seed.user), json={})
    task_id = created.json()["task"]["id"]

    dismissed = await client.delete(
        f"/api/inbox-items/{task_id}", headers=_headers(seed.user)
    )
    assert dismissed.status_code == 204

    reopened = await client.post(
        _task_url(seed),
        headers=_headers(seed.user),
        json={"due_date": "2026-08-20"},
    )
    assert reopened.status_code == 200
    body = reopened.json()
    assert body["created"] is False
    assert body["reopened"] is True
    assert body["task"]["id"] == task_id
    assert body["task"]["status"] == "open"
    assert body["task"]["due_date"] == "2026-08-20"

    events = (
        await db_session.execute(
            select(AuditEvent.event_type).where(
                AuditEvent.organization_id == seed.org.id,
                AuditEvent.event_type.in_(
                    [
                        "finding.remediation_task.created",
                        "finding.remediation_task.reopened",
                    ]
                ),
            )
        )
    ).scalars().all()
    assert events.count("finding.remediation_task.created") == 1
    assert events.count("finding.remediation_task.reopened") == 1


async def test_task_can_be_created_without_approved_language(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    seed = await _seed_finding(db_session, clause_type="indemnity")

    response = await client.post(_task_url(seed), headers=_headers(seed.user), json={})

    assert response.status_code == 200
    body = response.json()
    assert body["created"] is True
    assert body["plan"]["suggested_language"] is None
    assert body["plan"]["source_type"] == "none"


async def test_cross_org_and_contract_mismatch_are_not_discoverable(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _seed_finding(db_session, email="a@example.com")
    org_b = await _seed_finding(db_session, email="b@example.com")

    cross_org = await client.get(_plan_url(org_a), headers=_headers(org_b.user))
    mismatched = await client.get(
        (
            f"/api/contracts/{org_b.contract.id}/findings/"
            f"{org_a.finding.id}/remediation"
        ),
        headers=_headers(org_a.user),
    )

    assert cross_org.status_code == 404
    assert mismatched.status_code == 404


async def test_assignee_must_belong_to_same_org(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _seed_finding(db_session, email="a@example.com")
    org_b = await _seed_finding(db_session, email="b@example.com")

    response = await client.post(
        _task_url(org_a),
        headers=_headers(org_a.user),
        json={"assigned_to": str(org_b.user.id)},
    )

    assert response.status_code == 422
    count = await db_session.scalar(
        select(func.count()).select_from(FindingRemediationTask)
    )
    assert count == 0


async def test_reserved_item_type_must_use_specialized_endpoint(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    seed = await _seed_finding(db_session)

    response = await client.post(
        "/api/inbox-items",
        headers=_headers(seed.user),
        json={
            "title": "Bypass provenance",
            "item_type": "finding_remediation",
            "contract_id": str(seed.contract.id),
        },
    )

    assert response.status_code == 409


async def test_generic_patch_cannot_break_remediation_linkage(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    seed = await _seed_finding(db_session)
    created = await client.post(_task_url(seed), headers=_headers(seed.user), json={})
    task_id = created.json()["task"]["id"]

    changed_type = await client.patch(
        f"/api/inbox-items/{task_id}",
        headers=_headers(seed.user),
        json={"item_type": "general"},
    )
    changed_contract = await client.patch(
        f"/api/inbox-items/{task_id}",
        headers=_headers(seed.user),
        json={"contract_id": None},
    )
    completed = await client.patch(
        f"/api/inbox-items/{task_id}",
        headers=_headers(seed.user),
        json={"status": "completed"},
    )

    assert changed_type.status_code == 409
    assert changed_contract.status_code == 409
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
