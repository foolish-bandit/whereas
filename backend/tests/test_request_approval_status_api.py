"""API tests for ``GET /api/requests/{request_id}/approval-status`` (PR #56).

This is a read-only visibility surface; the goal is to confirm:

- it stitches together matching policies + workflow runs + a gate-aligned
  summary,
- the summary cannot drift away from the live DocuSeal gate (the
  ``ready_for_signature`` / ``blocking_reason`` codes match
  ``approval_gating.can_send_contract_to_docuseal``),
- cross-org access returns 404,
- storage internals (``storage_key`` / ``wrapped_dek`` / ``s3_key``)
  never appear in the serialized response.
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
    ApprovalStepStatus,
    ApprovalWorkflowRun,
    ApprovalWorkflowRunStatus,
    ApprovalWorkflowTemplate,
    ApprovalWorkflowTemplateStep,
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


async def _create_request_with_workflow(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    request_kwargs: dict[str, Any] | None = None,
    workflow_status: str = ApprovalWorkflowRunStatus.ACTIVE.value,
    source_policy: ApprovalPolicy | None = None,
) -> tuple[ContractRequest, ApprovalWorkflowRun, ApprovalStep]:
    base_kwargs: dict[str, Any] = {
        "organization_id": org_id,
        "title": "NDA with Acme",
        "request_type": "new_contract",
        "contract_type": "NDA",
        "priority": "high",
    }
    base_kwargs.update(request_kwargs or {})
    request = ContractRequest(**base_kwargs)
    contract_id = base_kwargs.get("linked_contract_id")
    session.add(request)
    await session.flush()

    metadata: dict[str, Any] = {}
    if source_policy is not None:
        metadata["source_approval_policy_id"] = str(source_policy.id)
        metadata["source_approval_policy_name"] = source_policy.name
        metadata["source_workflow_template_id"] = str(
            source_policy.workflow_template_id
        )

    run = ApprovalWorkflowRun(
        organization_id=org_id,
        name="Legal review",
        status=workflow_status,
        request_id=request.id,
        contract_id=contract_id,
        current_step_order=1
        if workflow_status == ApprovalWorkflowRunStatus.ACTIVE.value
        else None,
        metadata_json=metadata or None,
    )
    session.add(run)
    await session.flush()
    step = ApprovalStep(
        organization_id=org_id,
        workflow_run_id=run.id,
        step_order=1,
        title="Legal review",
        approver_email="legal@example.com",
        status=(
            ApprovalStepStatus.PENDING.value
            if workflow_status == ApprovalWorkflowRunStatus.ACTIVE.value
            else (
                ApprovalStepStatus.APPROVED.value
                if workflow_status == ApprovalWorkflowRunStatus.COMPLETED.value
                else ApprovalStepStatus.REJECTED.value
            )
        ),
    )
    session.add(step)
    await session.flush()
    return request, run, step


async def _create_policy(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    name: str = "Standard NDA Policy",
    request_type: str | None = "new_contract",
    contract_type: str | None = "NDA",
    priority: str | None = "high",
    applies_to_generated_contracts: bool = True,
    auto_attach: bool = True,
) -> ApprovalPolicy:
    template = ApprovalWorkflowTemplate(
        organization_id=org_id,
        name=f"Template {uuid.uuid4().hex[:8]}",
        status="active",
    )
    session.add(template)
    await session.flush()
    session.add(
        ApprovalWorkflowTemplateStep(
            organization_id=org_id,
            workflow_template_id=template.id,
            step_order=1,
            title="Legal review",
        )
    )
    await session.flush()

    policy = ApprovalPolicy(
        organization_id=org_id,
        name=name,
        status="active",
        workflow_template_id=template.id,
        request_type=request_type,
        contract_type=contract_type,
        priority=priority,
        applies_to_generated_contracts=applies_to_generated_contracts,
        auto_attach=auto_attach,
    )
    session.add(policy)
    await session.commit()
    return policy


async def _create_contract(
    session: AsyncSession, *, org_id: uuid.UUID, uploaded_by: uuid.UUID
) -> Contract:
    contract = Contract(
        organization_id=org_id,
        uploaded_by=uploaded_by,
        title="Generated NDA",
        status="ready",
        s3_key="dummy/key",
        mime_type="application/pdf",
        file_hash_sha256="0" * 64,
    )
    session.add(contract)
    await session.commit()
    return contract


# ---------------------------------------------------------------------------
# Visibility — policy/workflow projections
# ---------------------------------------------------------------------------


async def test_request_with_no_policy_or_workflow_shows_no_approvals_required(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request = ContractRequest(
        organization_id=user_org.org.id,
        title="No-approval intake",
        request_type="other",
    )
    db_session.add(request)
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["request_id"] == str(request.id)
    assert body["matching_policies"] == []
    assert body["workflow_runs"] == []
    assert body["summary"]["has_required_policies"] is False
    assert body["summary"]["has_active_workflows"] is False
    assert body["summary"]["has_rejected_workflows"] is False
    assert body["summary"]["blocking_reason"] is None
    # No linked contract -> ready_for_signature is None (the gate
    # doesn't run without a contract).
    assert body["summary"]["ready_for_signature"] is None


async def test_request_with_matching_policy_lists_policy(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    policy = await _create_policy(db_session, org_id=user_org.org.id)
    request = ContractRequest(
        organization_id=user_org.org.id,
        title="NDA with Acme",
        request_type="new_contract",
        contract_type="NDA",
        priority="high",
    )
    db_session.add(request)
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["matching_policy_ids"] == [str(policy.id)]
    assert len(body["matching_policies"]) == 1
    assert body["matching_policies"][0]["id"] == str(policy.id)
    assert body["matching_policies"][0]["name"] == policy.name
    assert body["summary"]["has_required_policies"] is True
    # No workflow yet, so the required-policy is unmet.
    assert body["summary"]["all_required_policy_workflows_completed"] is False


async def test_request_with_active_workflow_shows_active_step(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request, run, step = await _create_request_with_workflow(
        db_session, org_id=user_org.org.id
    )
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    body = response.json()
    assert response.status_code == 200, body
    assert len(body["workflow_runs"]) == 1
    wf = body["workflow_runs"][0]
    assert wf["id"] == str(run.id)
    assert wf["status"] == "active"
    assert wf["current_step_order"] == 1
    assert len(wf["steps"]) == 1
    assert wf["steps"][0]["status"] == "pending"
    assert wf["steps"][0]["title"] == "Legal review"
    assert body["summary"]["has_active_workflows"] is True
    assert body["summary"]["blocking_reason"] == "active_approval_workflows"


async def test_request_with_completed_workflow_shows_completed_status(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request, run, _ = await _create_request_with_workflow(
        db_session,
        org_id=user_org.org.id,
        workflow_status=ApprovalWorkflowRunStatus.COMPLETED.value,
    )
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    body = response.json()
    assert response.status_code == 200
    assert body["summary"]["has_completed_workflows"] is True
    assert body["summary"]["has_active_workflows"] is False
    assert body["summary"]["blocking_reason"] is None


async def test_request_with_rejected_workflow_shows_blocking_reason(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request, _, _ = await _create_request_with_workflow(
        db_session,
        org_id=user_org.org.id,
        workflow_status=ApprovalWorkflowRunStatus.REJECTED.value,
    )
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    body = response.json()
    assert response.status_code == 200
    assert body["summary"]["has_rejected_workflows"] is True
    assert body["summary"]["blocking_reason"] == "rejected_approval_workflows"
    assert body["summary"]["blocking_reason_text"]


# ---------------------------------------------------------------------------
# Gate alignment when there's a linked contract
# ---------------------------------------------------------------------------


async def test_summary_aligns_with_gate_for_active_workflow(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """The summary's ready_for_signature must match the gate exactly."""
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    contract = await _create_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    request, _, _ = await _create_request_with_workflow(
        db_session,
        org_id=user_org.org.id,
        request_kwargs={"linked_contract_id": contract.id},
    )
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    body = response.json()
    assert response.status_code == 200
    assert body["linked_contract_id"] == str(contract.id)
    assert body["summary"]["ready_for_signature"] is False
    assert body["summary"]["blocking_reason"] == "active_approval_workflows"


async def test_summary_aligns_with_gate_for_completed_required_policy(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A completed policy-derived workflow flips ready_for_signature true."""
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    policy = await _create_policy(db_session, org_id=user_org.org.id)
    contract = await _create_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    request, _, _ = await _create_request_with_workflow(
        db_session,
        org_id=user_org.org.id,
        request_kwargs={"linked_contract_id": contract.id},
        workflow_status=ApprovalWorkflowRunStatus.COMPLETED.value,
        source_policy=policy,
    )
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    body = response.json()
    assert response.status_code == 200
    assert body["summary"]["ready_for_signature"] is True
    assert body["summary"]["blocking_reason"] is None
    assert body["summary"]["all_required_policy_workflows_completed"] is True


async def test_summary_unmet_required_policy_when_no_completed_run(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """Required policy with no policy-derived completed workflow -> blocked."""
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    await _create_policy(db_session, org_id=user_org.org.id)
    contract = await _create_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    # The request matches the policy but has no workflow attached at all.
    request = ContractRequest(
        organization_id=user_org.org.id,
        title="NDA with Acme",
        request_type="new_contract",
        contract_type="NDA",
        priority="high",
        linked_contract_id=contract.id,
    )
    db_session.add(request)
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    body = response.json()
    assert response.status_code == 200
    assert body["summary"]["ready_for_signature"] is False
    assert body["summary"]["blocking_reason"] == "required_approval_policy_unmet"


# ---------------------------------------------------------------------------
# Source policy metadata is surfaced on the workflow
# ---------------------------------------------------------------------------


async def test_workflow_carries_source_policy_metadata(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    policy = await _create_policy(db_session, org_id=user_org.org.id)
    request, _, _ = await _create_request_with_workflow(
        db_session,
        org_id=user_org.org.id,
        source_policy=policy,
    )
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    body = response.json()
    wf = body["workflow_runs"][0]
    assert wf["source_approval_policy_id"] == str(policy.id)
    assert wf["source_approval_policy_name"] == policy.name


async def test_ad_hoc_workflow_has_null_source_policy(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """Workflows created without a policy should report null source ids."""
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request, _, _ = await _create_request_with_workflow(
        db_session, org_id=user_org.org.id
    )
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    body = response.json()
    wf = body["workflow_runs"][0]
    assert wf["source_approval_policy_id"] is None
    assert wf["source_approval_policy_name"] is None


# ---------------------------------------------------------------------------
# Cross-org access + invariants
# ---------------------------------------------------------------------------


async def test_cross_org_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")
    headers_a = _headers(org_a.user)
    headers_b = _headers(org_b.user)
    request, _, _ = await _create_request_with_workflow(
        db_session, org_id=org_a.org.id
    )
    await db_session.commit()
    request_id = str(request.id)

    not_found = await client.get(
        f"/api/requests/{request_id}/approval-status", headers=headers_b
    )
    assert not_found.status_code == 404
    # Same id with the right org returns 200.
    found = await client.get(
        f"/api/requests/{request_id}/approval-status", headers=headers_a
    )
    assert found.status_code == 200


async def test_response_has_no_storage_internals(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    contract = await _create_contract(
        db_session, org_id=user_org.org.id, uploaded_by=user_org.user.id
    )
    request, _, _ = await _create_request_with_workflow(
        db_session,
        org_id=user_org.org.id,
        request_kwargs={"linked_contract_id": contract.id},
    )
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    text = response.text
    for forbidden in (
        "storage_key",
        "wrapped_dek",
        "wrapped_master_key",
        "s3_key",
        "presigned_url",
    ):
        assert forbidden not in text


async def test_steps_are_sorted_by_step_order_then_id(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """Step ordering matches the ApprovalWorkflowTemplate page convention."""
    user_org = await _create_user_org(db_session)
    headers = _headers(user_org.user)
    request, run, _ = await _create_request_with_workflow(
        db_session, org_id=user_org.org.id
    )
    # Add a second step with a higher step_order
    db_session.add(
        ApprovalStep(
            organization_id=user_org.org.id,
            workflow_run_id=run.id,
            step_order=2,
            title="Finance review",
            status=ApprovalStepStatus.PENDING.value,
        )
    )
    await db_session.commit()

    response = await client.get(
        f"/api/requests/{request.id}/approval-status", headers=headers
    )
    body = response.json()
    orders = [s["step_order"] for s in body["workflow_runs"][0]["steps"]]
    assert orders == [1, 2]
