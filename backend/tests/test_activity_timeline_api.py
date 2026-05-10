"""API tests for the activity timeline endpoints (PR #58).

The timeline is read-only and audit-backed. The tests pin:

* approval workflow create/approve/reject/cancel writes the documented
  audit events,
* template instantiation writes a workflow_created event with the
  ``source="template"`` (or ``"policy"``) marker,
* the request endpoint surfaces approval events for runs attached to
  the request OR its linked contract, plus DocuSeal events on that
  linked contract,
* the contract endpoint surfaces approval events for runs attached
  directly to the contract plus DocuSeal events on it,
* cross-org access returns 404 on both endpoints,
* responses never leak storage_key / wrapped_dek / signer PII /
  document bytes.
"""
from __future__ import annotations

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
from app.security.audit_log import AuditEvent, AuditEventType  # noqa: E402
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


async def _create_workflow_via_api(
    client: httpx.AsyncClient,
    user: User,
    *,
    request_id: uuid.UUID,
    steps: list[dict[str, Any]] | None = None,
    name: str = "Legal approval",
) -> dict[str, Any]:
    payload = {
        "name": name,
        "request_id": str(request_id),
        "steps": steps
        or [
            {"title": "Legal review", "approver_email": "legal@example.com"},
            {"title": "Finance review"},
        ],
    }
    resp = await client.post(
        "/api/approval-workflows",
        headers=_headers(user),
        json=payload,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _audit_events_for_org(
    session: AsyncSession, org_id: uuid.UUID
) -> list[AuditEvent]:
    stmt = (
        select(AuditEvent)
        .where(AuditEvent.organization_id == org_id)
        .order_by(AuditEvent.sequence.asc())
    )
    return list((await session.execute(stmt)).scalars().all())


# ---------------------------------------------------------------------------
# Audit-write side effects
# ---------------------------------------------------------------------------


async def test_create_workflow_writes_workflow_created_and_first_step_activated(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    body = await _create_workflow_via_api(
        client, user_org.user, request_id=request.id
    )

    events = await _audit_events_for_org(db_session, user_org.org.id)
    types = [e.event_type for e in events]
    assert AuditEventType.APPROVAL_WORKFLOW_CREATED.value in types
    assert AuditEventType.APPROVAL_STEP_ACTIVATED.value in types

    created = next(
        e
        for e in events
        if e.event_type == AuditEventType.APPROVAL_WORKFLOW_CREATED.value
    )
    assert created.target_type == "approval_workflow_run"
    assert created.target_id == body["id"]
    assert created.details["source"] == "ad_hoc"
    assert created.details["request_id"] == str(request.id)

    activated = next(
        e
        for e in events
        if e.event_type == AuditEventType.APPROVAL_STEP_ACTIVATED.value
    )
    # Step 1 is the activated step at create time.
    assert activated.details["step_order"] == 1
    assert activated.details["step_title"] == "Legal review"


async def test_approving_step_writes_step_approved_and_next_activated(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    body = await _create_workflow_via_api(
        client, user_org.user, request_id=request.id
    )
    workflow_id = body["id"]
    step1_id = body["steps"][0]["id"]

    resp = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step1_id}/approve",
        headers=_headers(user_org.user),
        json={"decision_note": "fine"},
    )
    assert resp.status_code == 200, resp.text

    events = await _audit_events_for_org(db_session, user_org.org.id)
    types = [e.event_type for e in events]
    # Order: workflow_created, step_activated(1), step_approved(1), step_activated(2)
    assert types[-2:] == [
        AuditEventType.APPROVAL_STEP_APPROVED.value,
        AuditEventType.APPROVAL_STEP_ACTIVATED.value,
    ]
    activated = events[-1]
    assert activated.details["step_order"] == 2
    approved = events[-2]
    # decision_note text NOT stored — only its presence.
    assert "decision_note" not in approved.details
    assert approved.details.get("decision_note_present") is True


async def test_approving_final_step_writes_workflow_completed(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    body = await _create_workflow_via_api(
        client,
        user_org.user,
        request_id=request.id,
        steps=[{"title": "Only step"}],
    )
    workflow_id = body["id"]
    step_id = body["steps"][0]["id"]

    resp = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step_id}/approve",
        headers=_headers(user_org.user),
        json={},
    )
    assert resp.status_code == 200, resp.text

    events = await _audit_events_for_org(db_session, user_org.org.id)
    types = [e.event_type for e in events]
    assert types[-1] == AuditEventType.APPROVAL_WORKFLOW_COMPLETED.value


async def test_rejecting_step_writes_step_rejected_and_workflow_rejected(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    body = await _create_workflow_via_api(
        client, user_org.user, request_id=request.id
    )
    workflow_id = body["id"]
    step1_id = body["steps"][0]["id"]

    resp = await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step1_id}/reject",
        headers=_headers(user_org.user),
        json={"decision_note": "missing exhibit"},
    )
    assert resp.status_code == 200, resp.text

    events = await _audit_events_for_org(db_session, user_org.org.id)
    types = [e.event_type for e in events]
    assert types[-2:] == [
        AuditEventType.APPROVAL_STEP_REJECTED.value,
        AuditEventType.APPROVAL_WORKFLOW_REJECTED.value,
    ]


async def test_cancelling_workflow_writes_workflow_cancelled(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    request = await _make_request(db_session, user_org.org.id)
    body = await _create_workflow_via_api(
        client, user_org.user, request_id=request.id
    )

    resp = await client.patch(
        f"/api/approval-workflows/{body['id']}/cancel",
        headers=_headers(user_org.user),
    )
    assert resp.status_code == 200, resp.text

    events = await _audit_events_for_org(db_session, user_org.org.id)
    types = [e.event_type for e in events]
    assert types[-1] == AuditEventType.APPROVAL_WORKFLOW_CANCELLED.value


async def test_template_instantiation_writes_source_template_marker(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)

    tmpl = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json={
            "name": "Standard NDA",
            "steps": [{"step_order": 1, "title": "Legal review"}],
        },
    )
    assert tmpl.status_code == 201

    inst = await client.post(
        f"/api/approval-workflow-templates/{tmpl.json()['id']}/instantiate",
        headers=headers,
        json={"name": "NDA approval", "request_id": str(request.id)},
    )
    assert inst.status_code == 201

    events = await _audit_events_for_org(db_session, user_org.org.id)
    created = [
        e
        for e in events
        if e.event_type == AuditEventType.APPROVAL_WORKFLOW_CREATED.value
    ]
    assert len(created) == 1
    assert created[0].details["source"] == "template"
    assert "source_workflow_template_id" in created[0].details


async def test_policy_auto_attached_workflow_writes_source_policy_marker(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """When a request matches an active auto-attach policy, the
    policy service routes through ``instantiate_workflow_template``.
    The audit detail must surface ``source="policy"`` plus the
    ``source_approval_policy_id`` / ``source_approval_policy_name``
    pointers, so the timeline can label policy-derived runs distinctly
    from ad-hoc / template ones.
    """
    from app.models import ApprovalPolicy, ApprovalWorkflowTemplate

    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)

    # Create a workflow template + a matching policy.
    tmpl_resp = await client.post(
        "/api/approval-workflow-templates",
        headers=headers,
        json={
            "name": "Standard NDA Template",
            "steps": [{"step_order": 1, "title": "Legal review"}],
        },
    )
    assert tmpl_resp.status_code == 201
    tmpl_id = uuid.UUID(tmpl_resp.json()["id"])

    policy = ApprovalPolicy(
        organization_id=user_org.org.id,
        name="NDA Policy",
        status="active",
        workflow_template_id=tmpl_id,
        request_type="new_contract",
        contract_type="NDA",
        priority="high",
        applies_to_generated_contracts=True,
        auto_attach=True,
    )
    db_session.add(policy)
    await db_session.commit()
    policy_id = str(policy.id)
    policy_name = policy.name

    # Creating a matching request triggers auto-attach via
    # ``apply_approval_policies_to_request``, which calls
    # ``instantiate_workflow_template`` with the policy metadata.
    req_resp = await client.post(
        "/api/requests",
        headers=headers,
        json={
            "title": "NDA with Acme",
            "request_type": "new_contract",
            "contract_type": "NDA",
            "priority": "high",
        },
    )
    assert req_resp.status_code == 201, req_resp.text

    events = await _audit_events_for_org(db_session, user_org.org.id)
    created = [
        e
        for e in events
        if e.event_type == AuditEventType.APPROVAL_WORKFLOW_CREATED.value
    ]
    assert len(created) == 1
    detail = created[0].details
    assert detail["source"] == "policy"
    assert detail["source_approval_policy_id"] == policy_id
    assert detail["source_approval_policy_name"] == policy_name
    # The workflow run should also pick up the source_workflow_template_id
    # the policy stamps on it.
    assert "source_workflow_template_id" in detail
    # And we still emit a step_activated for the first step.
    activated = [
        e
        for e in events
        if e.event_type == AuditEventType.APPROVAL_STEP_ACTIVATED.value
    ]
    assert len(activated) == 1
    # Reference the template model so the linter knows the import is
    # exercised — it's also implicitly used via the policy FK.
    _ = ApprovalWorkflowTemplate


# ---------------------------------------------------------------------------
# Request activity endpoint
# ---------------------------------------------------------------------------


async def test_request_activity_orders_by_occurred_at_desc_and_renders_titles(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)
    body = await _create_workflow_via_api(
        client, user_org.user, request_id=request.id
    )
    workflow_id = body["id"]
    step1_id = body["steps"][0]["id"]
    await client.post(
        f"/api/approval-workflows/{workflow_id}/steps/{step1_id}/approve",
        headers=headers,
        json={},
    )

    resp = await client.get(
        f"/api/requests/{request.id}/activity", headers=headers
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    types = [item["event_type"] for item in body["items"]]
    # DESC order — most recent first.
    assert types[0] == AuditEventType.APPROVAL_STEP_ACTIVATED.value
    assert types[-1] == AuditEventType.APPROVAL_WORKFLOW_CREATED.value

    # Server-rendered titles + safe identifier fields.
    titles = [item["title"] for item in body["items"]]
    assert any("Step approved" in t for t in titles)
    assert any("Approval workflow created" in t for t in titles)
    for item in body["items"]:
        assert item["request_id"] == str(request.id)
        assert item["workflow_run_id"] == workflow_id


async def test_request_activity_includes_linked_contract_docuseal_events(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A DocuSeal send/completion audit event on the request's linked
    contract must surface on the request timeline.
    """
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    contract = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    request = await _make_request(
        db_session, user_org.org.id, linked_contract_id=contract.id
    )
    # Synthesize a CONTRACT_SENT_FOR_SIGNATURE audit event directly so
    # we don't need to wire up the DocuSeal stack here.
    from app.security.audit_log import record_event

    await record_event(
        db_session,
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
    await db_session.commit()

    resp = await client.get(
        f"/api/requests/{request.id}/activity", headers=headers
    )
    types = [i["event_type"] for i in resp.json()["items"]]
    assert AuditEventType.CONTRACT_SENT_FOR_SIGNATURE.value in types


async def test_request_activity_cross_org_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    headers_b = _headers(org_b.user)
    request = await _make_request(db_session, org_a.org.id)
    request_id = str(request.id)

    resp = await client.get(
        f"/api/requests/{request_id}/activity", headers=headers_b
    )
    assert resp.status_code == 404


async def test_request_activity_limit_is_clamped(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)
    await _create_workflow_via_api(
        client, user_org.user, request_id=request.id
    )
    # Default limit returns at most DEFAULT_LIMIT (=25). Asking limit=1
    # returns exactly one item.
    resp = await client.get(
        f"/api/requests/{request.id}/activity?limit=1", headers=headers
    )
    body = resp.json()
    assert len(body["items"]) == 1
    # limit=200 is a 422 (FastAPI Query(le=100) rejects).
    over = await client.get(
        f"/api/requests/{request.id}/activity?limit=200", headers=headers
    )
    assert over.status_code == 422


# ---------------------------------------------------------------------------
# Contract activity endpoint
# ---------------------------------------------------------------------------


async def test_contract_activity_returns_workflow_and_docuseal_events(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    contract = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    # Workflow attached to contract directly (no request).
    create = await client.post(
        "/api/approval-workflows",
        headers=headers,
        json={
            "name": "Counsel review",
            "contract_id": str(contract.id),
            "steps": [{"title": "Counsel review"}],
        },
    )
    assert create.status_code == 201

    from app.security.audit_log import record_event

    await record_event(
        db_session,
        organization_id=user_org.org.id,
        event_type=AuditEventType.CONTRACT_EXECUTED,
        actor_user_id=None,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "submission_id": "ds-2",
        },
    )
    await db_session.commit()

    resp = await client.get(
        f"/api/contracts/{contract.id}/activity", headers=headers
    )
    assert resp.status_code == 200, resp.text
    types = [i["event_type"] for i in resp.json()["items"]]
    assert AuditEventType.APPROVAL_WORKFLOW_CREATED.value in types
    assert AuditEventType.CONTRACT_EXECUTED.value in types


async def test_contract_activity_cross_org_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    headers_b = _headers(org_b.user)
    contract = await _make_contract(
        db_session, org_id=org_a.org.id, uploaded_by=org_a.user.id
    )
    contract_id = str(contract.id)

    resp = await client.get(
        f"/api/contracts/{contract_id}/activity", headers=headers_b
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Safety invariants
# ---------------------------------------------------------------------------


async def test_timeline_response_has_no_storage_internals(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    contract = await _make_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    request = await _make_request(
        db_session, user_org.org.id, linked_contract_id=contract.id
    )
    await _create_workflow_via_api(
        client, user_org.user, request_id=request.id
    )

    for url in (
        f"/api/requests/{request.id}/activity",
        f"/api/contracts/{contract.id}/activity",
    ):
        resp = await client.get(url, headers=headers)
        assert resp.status_code == 200
        text = resp.text
        for forbidden in (
            "storage_key",
            "wrapped_dek",
            "wrapped_master_key",
            "s3_key",
            "presigned_url",
            "decision_note",
        ):
            assert forbidden not in text


async def test_decision_note_text_never_stored_in_audit_details(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """The decision-note text the user typed must not end up in the
    audit chain — only ``decision_note_present: bool`` is recorded.
    """
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = await _make_request(db_session, user_org.org.id)
    body = await _create_workflow_via_api(
        client, user_org.user, request_id=request.id
    )
    secret = "the contract value is $1.5M"  # noqa: S105
    resp = await client.post(
        f"/api/approval-workflows/{body['id']}/steps/{body['steps'][0]['id']}/approve",
        headers=headers,
        json={"decision_note": secret},
    )
    assert resp.status_code == 200

    events = await _audit_events_for_org(db_session, user_org.org.id)
    for e in events:
        # The text must not appear anywhere in the canonical details.
        assert secret not in str(e.details)


def test_timeline_event_types_are_complete() -> None:
    """If a new APPROVAL_* event type is added, this test fails until the
    timeline projection learns to render it. Pins the (event_type,
    title-rendering) contract tested above.
    """
    expected = {
        "approval.workflow.created",
        "approval.step.activated",
        "approval.step.approved",
        "approval.step.rejected",
        "approval.workflow.completed",
        "approval.workflow.rejected",
        "approval.workflow.cancelled",
    }
    actual = {
        e.value
        for e in AuditEventType
        if e.value.startswith("approval.")
    }
    assert actual == expected


# Unused import guard
_ = datetime
_ = UTC
