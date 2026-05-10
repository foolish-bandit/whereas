"""API tests for ``/api/approval-workflow-templates``.

Covers PR #51 — reusable approval workflow blueprints. The flows that
matter:

* creating / listing / fetching / patching / archiving templates,
* adding / patching / deleting template steps with order normalization,
* cross-org templates return 404,
* instantiating a template:
  * creates a concrete ``ApprovalWorkflowRun`` and ``ApprovalStep`` rows,
  * opens the first ``InboxItem`` only,
  * computes ``due_date = today + due_in_days`` per step,
  * stores the source workflow template id/name on the run,
  * refuses to instantiate an archived template,
  * refuses to instantiate without a request_id or contract_id,
  * validates that linked request/contract/agreement_template are same-org,
* template edits after instantiation do not mutate the run/steps,
* responses never leak storage internals,
* existing approval workflow tests still pass (this suite only adds rows).
"""
from __future__ import annotations

import secrets
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime
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
    ApprovalWorkflowRun,
    ApprovalWorkflowTemplate,
    ApprovalWorkflowTemplateStep,
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
            ApprovalWorkflowTemplate.__table__,
            ApprovalWorkflowTemplateStep.__table__,
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


def _basic_payload(
    name: str = "Standard Legal Review",
    *,
    template_type: str | None = "legal_review",
) -> dict[str, Any]:
    return {
        "name": name,
        "description": "One legal approver, then finance",
        "template_type": template_type,
        "steps": [
            {
                "step_order": 1,
                "title": "Legal review",
                "approver_name": "Legal Team",
                "approver_email": "legal@example.com",
                "due_in_days": 3,
            },
            {
                "step_order": 2,
                "title": "Finance review",
                "approver_email": "finance@example.com",
                "due_in_days": 5,
            },
        ],
    }


# ---------------------------------------------------------------------------
# Create / list / get / patch / archive
# ---------------------------------------------------------------------------


async def test_create_template_with_steps(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    response = await client.post(
        "/api/approval-workflow-templates",
        headers=_headers(user_org.user),
        json=_basic_payload(),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Standard Legal Review"
    assert body["status"] == "active"
    assert body["template_type"] == "legal_review"
    assert [s["step_order"] for s in body["steps"]] == [1, 2]
    assert [s["title"] for s in body["steps"]] == ["Legal review", "Finance review"]
    assert body["steps"][0]["due_in_days"] == 3
    assert body["steps"][1]["due_in_days"] == 5


async def test_create_template_requires_at_least_one_step(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    response = await client.post(
        "/api/approval-workflow-templates",
        headers=_headers(user_org.user),
        json={"name": "Empty", "steps": []},
    )
    assert response.status_code == 422


async def test_create_template_rejects_duplicate_name(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    first = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    assert first.status_code == 201
    duplicate = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    assert duplicate.status_code == 409


async def test_duplicate_template_name_in_different_org_is_allowed(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """Name uniqueness scope is per-org, not global."""
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    headers_a = _headers(org_a.user)
    headers_b = _headers(org_b.user)

    a = await client.post(
        "/api/approval-workflow-templates",
        headers=headers_a,
        json=_basic_payload("Shared Name"),
    )
    assert a.status_code == 201
    b = await client.post(
        "/api/approval-workflow-templates",
        headers=headers_b,
        json=_basic_payload("Shared Name"),
    )
    assert b.status_code == 201
    assert a.json()["id"] != b.json()["id"]


async def test_list_excludes_archived_by_default(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)

    a = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload("Active"),
    )
    b = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload("Archive me"),
    )
    archive = await client.delete(
        f"/api/approval-workflow-templates/{b.json()['id']}",
        headers=headers,
    )
    assert archive.status_code == 200
    assert archive.json()["status"] == "archived"

    listed = await client.get(
        "/api/approval-workflow-templates", headers=headers
    )
    ids = {row["id"] for row in listed.json()}
    assert a.json()["id"] in ids
    assert b.json()["id"] not in ids

    with_archived = await client.get(
        "/api/approval-workflow-templates?include_archived=true",
        headers=headers,
    )
    ids_all = {row["id"] for row in with_archived.json()}
    assert b.json()["id"] in ids_all


async def test_get_template_returns_ordered_steps(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]

    detail = await client.get(
        f"/api/approval-workflow-templates/{template_id}",
        headers=headers,
    )
    assert detail.status_code == 200
    body = detail.json()
    assert [s["step_order"] for s in body["steps"]] == [1, 2]


async def test_patch_template_updates_metadata(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]

    patched = await client.patch(
        f"/api/approval-workflow-templates/{template_id}",
        headers=headers,
        json={
            "name": "Renamed",
            "description": "Updated description",
            "template_type": "general",
        },
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["name"] == "Renamed"
    assert body["description"] == "Updated description"
    assert body["template_type"] == "general"


async def test_patch_template_can_unarchive(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]
    await client.delete(
        f"/api/approval-workflow-templates/{template_id}", headers=headers
    )
    revived = await client.patch(
        f"/api/approval-workflow-templates/{template_id}",
        headers=headers,
        json={"status": "active"},
    )
    assert revived.status_code == 200
    assert revived.json()["status"] == "active"


# ---------------------------------------------------------------------------
# Template steps
# ---------------------------------------------------------------------------


async def test_add_template_step_appends_to_end(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]
    added = await client.post(
        f"/api/approval-workflow-templates/{template_id}/steps",
        headers=headers,
        json={"title": "Exec sign-off", "due_in_days": 7},
    )
    assert added.status_code == 201
    assert added.json()["step_order"] == 3

    detail = await client.get(
        f"/api/approval-workflow-templates/{template_id}", headers=headers
    )
    orders = [s["step_order"] for s in detail.json()["steps"]]
    assert orders == [1, 2, 3]


async def test_add_template_step_rejects_duplicate_order(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]
    duplicate = await client.post(
        f"/api/approval-workflow-templates/{template_id}/steps",
        headers=headers,
        json={"title": "Dup", "step_order": 1},
    )
    assert duplicate.status_code == 409


async def test_patch_template_step_updates_fields(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]
    step_id = create.json()["steps"][0]["id"]
    patched = await client.patch(
        f"/api/approval-workflow-templates/{template_id}/steps/{step_id}",
        headers=headers,
        json={"title": "Refreshed legal review", "due_in_days": 1},
    )
    assert patched.status_code == 200
    assert patched.json()["title"] == "Refreshed legal review"
    assert patched.json()["due_in_days"] == 1


async def test_cannot_delete_last_remaining_template_step(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A template with zero steps is not instantiable; block last-step delete."""
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json={
            "name": "Single-step",
            "steps": [{"step_order": 1, "title": "Only step"}],
        },
    )
    template_id = create.json()["id"]
    only_step_id = create.json()["steps"][0]["id"]

    blocked = await client.delete(
        f"/api/approval-workflow-templates/{template_id}/steps/{only_step_id}",
        headers=headers,
    )
    assert blocked.status_code == 409
    # The step must still be present after the failed delete.
    detail = await client.get(
        f"/api/approval-workflow-templates/{template_id}", headers=headers
    )
    assert len(detail.json()["steps"]) == 1


async def test_delete_template_step_normalizes_remaining_orders(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    payload = _basic_payload()
    payload["steps"].append(
        {"step_order": 3, "title": "Exec sign-off", "due_in_days": 7}
    )
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=payload,
    )
    template_id = create.json()["id"]
    middle_step_id = create.json()["steps"][1]["id"]

    deleted = await client.delete(
        f"/api/approval-workflow-templates/{template_id}/steps/{middle_step_id}",
        headers=headers,
    )
    assert deleted.status_code == 200
    body = deleted.json()
    orders = [s["step_order"] for s in body["steps"]]
    titles = [s["title"] for s in body["steps"]]
    assert orders == [1, 2]
    assert titles == ["Legal review", "Exec sign-off"]


# ---------------------------------------------------------------------------
# Cross-org access
# ---------------------------------------------------------------------------


async def test_cross_org_template_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    headers_a = _headers(org_a.user)
    headers_b = _headers(org_b.user)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers_a,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]

    not_found = await client.get(
        f"/api/approval-workflow-templates/{template_id}",
        headers=headers_b,
    )
    assert not_found.status_code == 404
    patched = await client.patch(
        f"/api/approval-workflow-templates/{template_id}",
        headers=headers_b,
        json={"name": "stolen"},
    )
    assert patched.status_code == 404


# ---------------------------------------------------------------------------
# Instantiation
# ---------------------------------------------------------------------------


async def test_instantiate_template_for_request_creates_run_and_steps(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)

    template_resp = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = template_resp.json()["id"]
    template_name = template_resp.json()["name"]

    response = await client.post(
        f"/api/approval-workflow-templates/{template_id}/instantiate",
        headers=headers,
        json={
            "name": "Legal approval for Acme NDA",
            "request_id": str(request.id),
        },
    )
    assert response.status_code == 201
    body = response.json()

    assert body["status"] == "active"
    assert body["request_id"] == str(request.id)
    assert body["current_step_order"] == 1
    assert [s["title"] for s in body["steps"]] == [
        "Legal review",
        "Finance review",
    ]
    assert body["steps"][0]["status"] == "pending"
    assert body["steps"][1]["status"] == "pending"
    # First step gets an inbox item; later steps don't.
    assert body["steps"][0]["inbox_item_id"] is not None
    assert body["steps"][1]["inbox_item_id"] is None
    # Source workflow template metadata.
    assert body["metadata_json"]["source_workflow_template_id"] == template_id
    assert body["metadata_json"]["source_workflow_template_name"] == template_name

    inbox = await client.get(
        "/api/inbox-items?item_type=approval", headers=headers
    )
    items = inbox.json()
    assert len(items) == 1
    assert items[0]["title"] == "Approval needed: Legal review"
    assert items[0]["request_id"] == str(request.id)


async def test_instantiate_template_for_contract(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    contract = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload("Counsel review"),
    )
    template_id = create.json()["id"]

    response = await client.post(
        f"/api/approval-workflow-templates/{template_id}/instantiate",
        headers=headers,
        json={
            "name": "Counsel review run",
            "contract_id": str(contract.id),
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["contract_id"] == str(contract.id)


async def test_instantiate_requires_request_or_contract(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]
    response = await client.post(
        f"/api/approval-workflow-templates/{template_id}/instantiate",
        headers=headers,
        json={"name": "Floating"},
    )
    assert response.status_code == 422


async def test_instantiate_validates_cross_org_request(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    headers_a = _headers(org_a.user)
    other_request = await _make_request(db_session, org_b.org.id)

    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers_a,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]

    response = await client.post(
        f"/api/approval-workflow-templates/{template_id}/instantiate",
        headers=headers_a,
        json={
            "name": "Cross",
            "request_id": str(other_request.id),
        },
    )
    assert response.status_code == 422


async def test_instantiate_validates_cross_org_agreement_template(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    headers_a = _headers(org_a.user)
    request = await _make_request(db_session, org_a.org.id)
    other_template = AgreementTemplate(
        id=uuid.uuid4(),
        organization_id=org_b.org.id,
        name="Other",
        status="active",
    )
    db_session.add(other_template)
    await db_session.commit()

    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers_a,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]

    response = await client.post(
        f"/api/approval-workflow-templates/{template_id}/instantiate",
        headers=headers_a,
        json={
            "name": "Cross",
            "request_id": str(request.id),
            "agreement_template_id": str(other_template.id),
        },
    )
    assert response.status_code == 422


async def test_instantiate_archived_template_returns_409(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]
    await client.delete(
        f"/api/approval-workflow-templates/{template_id}", headers=headers
    )
    response = await client.post(
        f"/api/approval-workflow-templates/{template_id}/instantiate",
        headers=headers,
        json={"name": "After archive", "request_id": str(request.id)},
    )
    assert response.status_code == 409


async def test_instantiate_due_in_days_computes_due_date(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]

    today = datetime.now(UTC).date()
    response = await client.post(
        f"/api/approval-workflow-templates/{template_id}/instantiate",
        headers=headers,
        json={"name": "Due dates", "request_id": str(request.id)},
    )
    assert response.status_code == 201
    body = response.json()
    # Step 1 has due_in_days=3; step 2 has due_in_days=5.
    step_dates = {s["step_order"]: s["due_date"] for s in body["steps"]}
    expected_step_1 = (today + _delta(3)).isoformat()
    expected_step_2 = (today + _delta(5)).isoformat()
    assert step_dates[1] == expected_step_1
    assert step_dates[2] == expected_step_2


async def test_instantiate_step_with_no_due_in_days_has_null_due_date(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json={
            "name": "No-due template",
            "steps": [{"title": "Single step"}],
        },
    )
    template_id = create.json()["id"]
    response = await client.post(
        f"/api/approval-workflow-templates/{template_id}/instantiate",
        headers=headers,
        json={"name": "No dates", "request_id": str(request.id)},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["steps"][0]["due_date"] is None


async def test_template_edit_after_instantiation_does_not_mutate_run(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)

    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    template_id = create.json()["id"]
    instantiate = await client.post(
        f"/api/approval-workflow-templates/{template_id}/instantiate",
        headers=headers,
        json={"name": "Run", "request_id": str(request.id)},
    )
    run_id = instantiate.json()["id"]
    original_titles = [s["title"] for s in instantiate.json()["steps"]]

    # Mutate the template after instantiation.
    first_template_step_id = create.json()["steps"][0]["id"]
    patched = await client.patch(
        f"/api/approval-workflow-templates/{template_id}/steps/{first_template_step_id}",
        headers=headers,
        json={"title": "Updated post-instantiation"},
    )
    assert patched.status_code == 200

    # Re-fetch the existing run and confirm it didn't shift.
    run = await client.get(
        f"/api/approval-workflows/{run_id}", headers=headers
    )
    titles_now = [s["title"] for s in run.json()["steps"]]
    assert titles_now == original_titles


async def test_response_has_no_storage_internals(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    instantiate = await client.post(
        f"/api/approval-workflow-templates/{create.json()['id']}/instantiate",
        headers=headers,
        json={"name": "Audit", "request_id": str(request.id)},
    )
    for response in (create, instantiate):
        text = response.text
        for forbidden in (
            "storage_key",
            "wrapped_dek",
            "wrapped_master_key",
            "s3_key",
        ):
            assert forbidden not in text


async def test_instantiation_creates_only_first_inbox_item(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)
    create = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json=_basic_payload(),
    )
    instantiate = await client.post(
        f"/api/approval-workflow-templates/{create.json()['id']}/instantiate",
        headers=headers,
        json={"name": "Run", "request_id": str(request.id)},
    )
    run_id = instantiate.json()["id"]

    # Look directly at the DB: only one InboxItem should be linked to
    # this workflow run, regardless of how many steps were created.
    rows = (
        await db_session.execute(
            select(InboxItem).where(
                InboxItem.organization_id == user_org.org.id,
                InboxItem.item_type == "approval",
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].metadata_json is not None
    assert rows[0].metadata_json.get("workflow_run_id") == run_id
    assert rows[0].status == InboxItemStatus.OPEN.value


def _delta(days: int) -> Any:
    from datetime import timedelta

    return timedelta(days=days)


# Unused import guard so ``date`` isn't dropped by ruff if something
# changes above; we use it indirectly via ``datetime.now(UTC).date()``.
_ = date
