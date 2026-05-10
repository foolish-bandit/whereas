"""API tests for ``/api/approval-workflows``.

Covers PR #50 — the narrow approval workflow foundation. The flows that
matter:

* creating a workflow attached to a request / contract creates ordered
  steps and a single ``approval`` inbox item for step 1 only,
* approving the current step closes its inbox item and opens the next
  step's inbox item, or completes the workflow,
* rejecting the current step rejects the workflow and skips remaining
  pending steps,
* cancelling dismisses the open approval inbox item and skips pending
  steps,
* idempotency / 409 guards on out-of-order or duplicate decisions,
* cross-org access returns 404,
* responses never leak storage internals.
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
    ApprovalStep,
    ApprovalStepStatus,
    ApprovalWorkflowRun,
    ApprovalWorkflowRunStatus,
    Contract,
    ContractRequest,
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
        engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:", echo=False
        )
        tables = [
            Organization.__table__,
            User.__table__,
            AuditEvent.__table__,
            Contract.__table__,
            AgreementTemplate.__table__,
            ContractRequest.__table__,
            InboxItem.__table__,
            ApprovalWorkflowRun.__table__,
            ApprovalStep.__table__,
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
    session: AsyncSession, org_id: uuid.UUID, *, title: str = "Req"
) -> ContractRequest:
    row = ContractRequest(organization_id=org_id, title=title)
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


def _step_titles(rows: list[dict[str, Any]]) -> list[str]:
    return [row["title"] for row in rows]


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


async def test_create_workflow_attached_to_request_creates_first_inbox_item(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)

    response = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Legal approval",
            "request_id": str(request.id),
            "steps": [
                {
                    "title": "Legal review",
                    "approver_email": "legal@example.com",
                    "due_date": "2026-05-20",
                },
                {
                    "title": "CFO sign-off",
                    "approver_email": "cfo@example.com",
                },
            ],
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "active"
    assert body["current_step_order"] == 1
    assert _step_titles(body["steps"]) == ["Legal review", "CFO sign-off"]
    assert [s["status"] for s in body["steps"]] == ["pending", "pending"]
    assert [s["step_order"] for s in body["steps"]] == [1, 2]
    assert body["steps"][0]["inbox_item_id"] is not None
    assert body["steps"][1]["inbox_item_id"] is None

    inbox = await client.get(
        "/api/inbox-items?item_type=approval",
        headers=_headers(user_org.user),
    )
    items = inbox.json()
    assert len(items) == 1
    item = items[0]
    assert item["item_type"] == "approval"
    assert item["title"] == "Approval needed: Legal review"
    assert item["request_id"] == str(request.id)
    assert item["due_date"] == "2026-05-20"
    assert item["metadata_json"]["workflow_run_id"] == body["id"]
    assert item["metadata_json"]["approval_step_id"] == body["steps"][0]["id"]


async def test_create_workflow_attached_to_contract(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    contract = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )

    response = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Counsel review",
            "contract_id": str(contract.id),
            "steps": [{"title": "Counsel review"}],
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["contract_id"] == str(contract.id)
    inbox = await client.get(
        "/api/inbox-items?item_type=approval",
        headers=_headers(user_org.user),
    )
    items = inbox.json()
    assert len(items) == 1
    assert items[0]["contract_id"] == str(contract.id)


async def test_create_workflow_requires_at_least_one_link(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    response = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Floating",
            "steps": [{"title": "x"}],
        },
    )
    assert response.status_code == 422


async def test_create_workflow_requires_at_least_one_step(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    response = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Empty",
            "request_id": str(request.id),
            "steps": [],
        },
    )
    assert response.status_code == 422


async def test_create_workflow_rejects_cross_org_request(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    other_request = await _make_request(db_session, org_b.org.id)
    response = await client.post(
        "/api/approval-workflows",
        headers=_headers(org_a.user),
        json={
            "name": "Cross",
            "request_id": str(other_request.id),
            "steps": [{"title": "x"}],
        },
    )
    assert response.status_code == 422


async def test_create_workflow_rejects_cross_org_template(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    request = await _make_request(db_session, org_a.org.id)
    other_template = AgreementTemplate(
        id=uuid.uuid4(),
        organization_id=org_b.org.id,
        name="Other",
        status="active",
    )
    db_session.add(other_template)
    await db_session.commit()
    response = await client.post(
        "/api/approval-workflows",
        headers=_headers(org_a.user),
        json={
            "name": "Cross",
            "request_id": str(request.id),
            "template_id": str(other_template.id),
            "steps": [{"title": "x"}],
        },
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Approve / reject
# ---------------------------------------------------------------------------


async def test_approve_step_advances_to_next_step_and_opens_inbox(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Two-step",
            "request_id": str(request.id),
            "steps": [
                {"title": "Legal"},
                {"title": "Finance"},
            ],
        },
    )
    body = create.json()
    workflow_id = body["id"]
    step1_id = body["steps"][0]["id"]
    step1_inbox_id = body["steps"][0]["inbox_item_id"]

    approve = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step1_id}/approve",
        headers=_headers(user_org.user),
        json={"decision_note": "looks good"},
    )
    assert approve.status_code == 200
    after = approve.json()
    assert after["status"] == "active"
    assert after["current_step_order"] == 2
    assert after["steps"][0]["status"] == "approved"
    assert after["steps"][0]["decision_note"] == "looks good"
    assert after["steps"][1]["status"] == "pending"
    assert after["steps"][1]["inbox_item_id"] is not None
    assert after["steps"][1]["inbox_item_id"] != step1_inbox_id

    inbox = await client.get(
        "/api/inbox-items?include_dismissed=true&item_type=approval",
        headers=_headers(user_org.user),
    )
    items = {row["id"]: row for row in inbox.json()}
    assert items[step1_inbox_id]["status"] == "completed"
    assert items[after["steps"][1]["inbox_item_id"]]["status"] == "open"
    assert items[after["steps"][1]["inbox_item_id"]]["title"].startswith(
        "Approval needed: Finance"
    )


async def test_approve_last_step_completes_workflow(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Single",
            "request_id": str(request.id),
            "steps": [{"title": "Only"}],
        },
    )
    body = create.json()
    approve = await client.post(
        f"/api/approval-workflows/{body['id']}/steps/{body['steps'][0]['id']}/approve",
        headers=_headers(user_org.user),
        json={},
    )
    assert approve.status_code == 200
    after = approve.json()
    assert after["status"] == "completed"
    assert after["completed_at"] is not None
    assert after["steps"][0]["status"] == "approved"


async def test_reject_current_step_rejects_workflow_and_skips_rest(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Three-step",
            "request_id": str(request.id),
            "steps": [
                {"title": "Legal"},
                {"title": "Finance"},
                {"title": "Exec"},
            ],
        },
    )
    body = create.json()
    workflow_id = body["id"]
    step1_id = body["steps"][0]["id"]
    step1_inbox_id = body["steps"][0]["inbox_item_id"]

    reject = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step1_id}/reject",
        headers=_headers(user_org.user),
        json={"decision_note": "missing exhibit"},
    )
    assert reject.status_code == 200
    after = reject.json()
    assert after["status"] == "rejected"
    assert after["completed_at"] is not None
    assert [s["status"] for s in after["steps"]] == [
        "rejected",
        "skipped",
        "skipped",
    ]
    assert after["steps"][0]["decision_note"] == "missing exhibit"

    inbox = await client.get(
        "/api/inbox-items?include_dismissed=true&item_type=approval",
        headers=_headers(user_org.user),
    )
    items = inbox.json()
    # Only the first step ever had an inbox item; rejection completes
    # it. No additional inbox items should exist for the skipped tail.
    assert len(items) == 1
    assert items[0]["id"] == step1_inbox_id
    assert items[0]["status"] == "completed"


async def test_cannot_approve_non_current_step(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Two",
            "request_id": str(request.id),
            "steps": [{"title": "First"}, {"title": "Second"}],
        },
    )
    body = create.json()
    workflow_id = body["id"]
    step2_id = body["steps"][1]["id"]
    skipped = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step2_id}/approve",
        headers=_headers(user_org.user),
        json={},
    )
    assert skipped.status_code == 409


async def test_cannot_approve_already_decided_step(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=headers,
        json={
            "name": "One",
            "request_id": str(request.id),
            "steps": [{"title": "First"}],
        },
    )
    body = create.json()
    workflow_id = body["id"]
    step_id = body["steps"][0]["id"]
    first = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step_id}/approve",
        headers=headers,
        json={},
    )
    assert first.status_code == 200
    again = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step_id}/approve",
        headers=headers,
        json={},
    )
    assert again.status_code == 409
    rejected = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step_id}/reject",
        headers=headers,
        json={},
    )
    assert rejected.status_code == 409


# ---------------------------------------------------------------------------
# Cancel
# ---------------------------------------------------------------------------


async def test_cancel_workflow_dismisses_inbox_and_skips_pending(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Three",
            "request_id": str(request.id),
            "steps": [
                {"title": "First"},
                {"title": "Second"},
            ],
        },
    )
    body = create.json()
    workflow_id = body["id"]
    inbox_id = body["steps"][0]["inbox_item_id"]

    cancel = await client.patch(
        f"/api/approval-workflows/{workflow_id}/cancel",
        headers=_headers(user_org.user),
    )
    assert cancel.status_code == 200
    after = cancel.json()
    assert after["status"] == "cancelled"
    assert after["completed_at"] is not None
    assert [s["status"] for s in after["steps"]] == ["skipped", "skipped"]

    inbox = await client.get(
        "/api/inbox-items?include_dismissed=true&item_type=approval",
        headers=_headers(user_org.user),
    )
    items = {row["id"]: row for row in inbox.json()}
    assert items[inbox_id]["status"] == "dismissed"


async def test_cancel_terminal_workflow_returns_409(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "One",
            "request_id": str(request.id),
            "steps": [{"title": "First"}],
        },
    )
    workflow_id = create.json()["id"]
    step_id = create.json()["steps"][0]["id"]
    await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step_id}/approve",
        headers=_headers(user_org.user),
        json={},
    )
    again = await client.patch(
        f"/api/approval-workflows/{workflow_id}/cancel",
        headers=_headers(user_org.user),
    )
    assert again.status_code == 409


# ---------------------------------------------------------------------------
# Cross-org access + list filters
# ---------------------------------------------------------------------------


async def test_cross_org_workflow_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    headers_a = _headers(org_a.user)
    headers_b = _headers(org_b.user)
    request = await _make_request(db_session, org_a.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=headers_a,
        json={
            "name": "Theirs",
            "request_id": str(request.id),
            "steps": [{"title": "x"}],
        },
    )
    workflow_id = create.json()["id"]
    step_id = create.json()["steps"][0]["id"]

    got = await client.get(
        f"/api/approval-workflows/{workflow_id}",
        headers=headers_b,
    )
    assert got.status_code == 404
    approve = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step_id}/approve",
        headers=headers_b,
        json={},
    )
    assert approve.status_code == 404


async def test_list_filters_by_status(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)

    active = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Active",
            "request_id": str(request.id),
            "steps": [{"title": "x"}],
        },
    )
    other_request = await _make_request(db_session, user_org.org.id, title="Other")
    completed = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Completed",
            "request_id": str(other_request.id),
            "steps": [{"title": "y"}],
        },
    )
    cstep = completed.json()["steps"][0]["id"]
    await client.post(
        f"/api/approval-workflows/{completed.json()['id']}/steps/{cstep}/approve",
        headers=_headers(user_org.user),
        json={},
    )

    listed = await client.get(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
    )
    ids = {row["id"] for row in listed.json()}
    assert active.json()["id"] in ids
    assert completed.json()["id"] in ids

    only_active = await client.get(
        "/api/approval-workflows?include_terminal=false",
        headers=_headers(user_org.user),
    )
    only_ids = {row["id"] for row in only_active.json()}
    assert active.json()["id"] in only_ids
    assert completed.json()["id"] not in only_ids

    by_status = await client.get(
        "/api/approval-workflows?status=completed",
        headers=_headers(user_org.user),
    )
    by_status_ids = {row["id"] for row in by_status.json()}
    assert by_status_ids == {completed.json()["id"]}


# ---------------------------------------------------------------------------
# Misc invariants
# ---------------------------------------------------------------------------


async def test_response_has_no_storage_internals(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Audit",
            "request_id": str(request.id),
            "steps": [{"title": "x"}],
        },
    )
    text = create.text
    for forbidden in ("storage_key", "wrapped_dek", "wrapped_master_key", "s3_key"):
        assert forbidden not in text


async def test_status_enum_values_are_complete() -> None:
    assert {s.value for s in ApprovalWorkflowRunStatus} == {
        "active",
        "completed",
        "rejected",
        "cancelled",
    }
    assert {s.value for s in ApprovalStepStatus} == {
        "pending",
        "approved",
        "rejected",
        "skipped",
    }


async def test_pending_step_can_be_edited(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Edit",
            "request_id": str(request.id),
            "steps": [{"title": "Old", "due_date": "2026-05-15"}],
        },
    )
    workflow_id = create.json()["id"]
    step_id = create.json()["steps"][0]["id"]
    inbox_id = create.json()["steps"][0]["inbox_item_id"]

    patched = await client.patch(
        f"/api/approval-workflows/{workflow_id}/steps/{step_id}",
        headers=_headers(user_org.user),
        json={"title": "New", "due_date": "2026-06-01"},
    )
    assert patched.status_code == 200
    assert patched.json()["title"] == "New"
    assert patched.json()["due_date"] == "2026-06-01"

    inbox_row = await db_session.execute(
        select(InboxItem).where(InboxItem.id == uuid.UUID(inbox_id))
    )
    item = inbox_row.scalar_one()
    assert item.title == "Approval needed: New"
    assert item.due_date.isoformat() == "2026-06-01"
    assert item.status == InboxItemStatus.OPEN.value


async def test_decision_after_cancel_returns_409(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflows",
        headers=_headers(user_org.user),
        json={
            "name": "Cancelled",
            "request_id": str(request.id),
            "steps": [{"title": "x"}],
        },
    )
    workflow_id = create.json()["id"]
    step_id = create.json()["steps"][0]["id"]
    await client.patch(
        f"/api/approval-workflows/{workflow_id}/cancel",
        headers=_headers(user_org.user),
    )
    approve = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step_id}/approve",
        headers=_headers(user_org.user),
        json={},
    )
    assert approve.status_code == 409
