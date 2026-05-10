"""API tests for ``GET /api/contracts/{contract_id}/approval-gate`` (PR #59).

PR #52 added the gate logic and the endpoint started returning
``required_policy_ids`` / ``missing_policy_ids``. PR #59 layers
*named* ``required_policies`` / ``missing_policies`` summaries on top so
the UI can render policy names without a follow-up fetch.

These tests:

- confirm the new fields are present on the wire,
- confirm they're aligned element-by-element with the back-compat id lists,
- confirm the back-compat id fields are still present,
- confirm storage internals / signer PII / ``metadata_json`` / ``created_by``
  never appear in the JSON response,
- confirm the gate's allow/block *codes* are unchanged for the same
  scenarios (PR #59 is response polish only — no new gate semantics).
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
    ApprovalWorkflowRun,
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


async def _create_user_org(session: AsyncSession) -> UserOrg:
    org = Organization(
        id=uuid.uuid4(),
        name=f"Org {uuid.uuid4()}",
        wrapped_master_key=_wrapped_org_key(uuid.uuid4()),
    )
    org.wrapped_master_key = _wrapped_org_key(org.id)
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Test User",
        is_active=True,
    )
    session.add_all([org, user])
    await session.commit()
    return UserOrg(org=org, user=user)


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


async def _create_policy(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    name: str,
    request_type: str | None = "new_contract",
    contract_type: str | None = "NDA",
    priority: str | None = "high",
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
        applies_to_generated_contracts=True,
        auto_attach=True,
    )
    session.add(policy)
    await session.commit()
    return policy


async def _create_contract_with_request(
    session: AsyncSession,
    *,
    org: Organization,
    user: User,
    request_kwargs: dict[str, Any] | None = None,
) -> tuple[Contract, ContractRequest]:
    contract = Contract(
        organization_id=org.id,
        uploaded_by=user.id,
        title="Generated NDA",
        status="ready",
        s3_key="dummy/key",
        mime_type="application/pdf",
        file_hash_sha256="0" * 64,
    )
    session.add(contract)
    await session.flush()
    base = {
        "organization_id": org.id,
        "title": "NDA with Acme",
        "request_type": "new_contract",
        "contract_type": "NDA",
        "priority": "high",
        "linked_contract_id": contract.id,
    }
    base.update(request_kwargs or {})
    request = ContractRequest(**base)
    session.add(request)
    await session.commit()
    return contract, request


# ---------------------------------------------------------------------------
# Allow path: contract with no linked request still passes through and
# the new fields are present and empty (UI relies on this).
# ---------------------------------------------------------------------------


async def test_contract_with_no_linked_request_includes_empty_summary_lists(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    contract = Contract(
        organization_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Standalone PDF",
        status="ready",
        s3_key="dummy/key",
        mime_type="application/pdf",
        file_hash_sha256="0" * 64,
    )
    db_session.add(contract)
    await db_session.commit()

    response = await client.get(
        f"/api/contracts/{contract.id}/approval-gate",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["allowed"] is True
    assert body["code"] == "no_linked_request"
    # Back-compat fields preserved.
    assert body["required_policy_ids"] == []
    assert body["missing_policy_ids"] == []
    # New summary fields are present and parallel.
    assert body["required_policies"] == []
    assert body["missing_policies"] == []


# ---------------------------------------------------------------------------
# Block path: required policy unmet — names appear and align with ids.
# ---------------------------------------------------------------------------


async def test_required_policy_unmet_returns_named_summaries_aligned_with_ids(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    # Two matching policies — both required, both unmet (no workflows).
    legal_policy = await _create_policy(
        db_session, org_id=user_org.org.id, name="Standard Legal Review"
    )
    exec_policy = await _create_policy(
        db_session,
        org_id=user_org.org.id,
        name="High Priority Executive Approval",
    )
    contract, _request = await _create_contract_with_request(
        db_session, org=user_org.org, user=user_org.user
    )

    response = await client.get(
        f"/api/contracts/{contract.id}/approval-gate",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["allowed"] is False
    assert body["code"] == "required_approval_policy_unmet"

    # Back-compat id fields still present and contain both policies.
    assert sorted(body["required_policy_ids"]) == sorted(
        [str(legal_policy.id), str(exec_policy.id)]
    )
    assert sorted(body["missing_policy_ids"]) == sorted(
        [str(legal_policy.id), str(exec_policy.id)]
    )

    # Names appear and align with ids element-by-element. (The gate sorts
    # by name; that ordering is asserted separately to keep this test
    # focused on alignment.)
    assert [p["id"] for p in body["required_policies"]] == body["required_policy_ids"]
    assert [p["id"] for p in body["missing_policies"]] == body["missing_policy_ids"]
    names = {p["name"] for p in body["missing_policies"]}
    assert names == {"Standard Legal Review", "High Priority Executive Approval"}


async def test_missing_policies_render_in_stable_name_sorted_order(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    # Insert in non-alphabetical order on purpose.
    await _create_policy(db_session, org_id=user_org.org.id, name="Zeta Reviewer")
    await _create_policy(db_session, org_id=user_org.org.id, name="Alpha Reviewer")
    contract, _ = await _create_contract_with_request(
        db_session, org=user_org.org, user=user_org.user
    )

    response = await client.get(
        f"/api/contracts/{contract.id}/approval-gate",
        headers=_headers(user_org.user),
    )
    body = response.json()
    assert [p["name"] for p in body["missing_policies"]] == [
        "Alpha Reviewer",
        "Zeta Reviewer",
    ]


# ---------------------------------------------------------------------------
# Safety: the response must never carry storage internals / PII / secrets.
# ---------------------------------------------------------------------------


async def test_gate_response_never_includes_storage_or_signer_pii(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    policy = await _create_policy(
        db_session, org_id=user_org.org.id, name="Standard Legal Review"
    )
    contract, _ = await _create_contract_with_request(
        db_session, org=user_org.org, user=user_org.user
    )

    response = await client.get(
        f"/api/contracts/{contract.id}/approval-gate",
        headers=_headers(user_org.user),
    )
    assert response.status_code == 200
    raw = response.text
    for forbidden in (
        "storage_key",
        "wrapped_dek",
        "s3_key",
        "metadata_json",
        "created_by",
        "signer_email",
        "signer_name",
        "DOCUSEAL_AUTH_BRIDGE_SECRET",
    ):
        assert forbidden not in raw, f"Gate response leaks {forbidden}"

    body = response.json()
    summary = body["missing_policies"][0]
    # Allowlist: a future column on ApprovalPolicy must NOT silently
    # leak through this surface. Pydantic ``extra="forbid"`` plus this
    # explicit set keeps the contract narrow.
    assert set(summary.keys()) == {
        "id",
        "name",
        "workflow_template_id",
        "auto_attach",
        "applies_to_generated_contracts",
        "request_type",
        "contract_type",
        "priority",
        "agreement_template_id",
    }
    assert summary["id"] == str(policy.id)


# ---------------------------------------------------------------------------
# No-logic-change: gate codes for the same scenarios stay the same after
# PR #59. This guards against accidentally rewiring allow/block rules
# while polishing the response shape.
# ---------------------------------------------------------------------------


async def test_pr59_does_not_change_allow_block_codes(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)

    # Standalone contract -> allowed/no_linked_request.
    standalone = Contract(
        organization_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Standalone",
        status="ready",
        s3_key="dummy/key",
        mime_type="application/pdf",
        file_hash_sha256="0" * 64,
    )
    db_session.add(standalone)
    await db_session.commit()
    r = await client.get(
        f"/api/contracts/{standalone.id}/approval-gate",
        headers=_headers(user_org.user),
    )
    assert r.json()["allowed"] is True
    assert r.json()["code"] == "no_linked_request"

    # Contract with linked request and matching policy but no workflow ->
    # blocked/required_approval_policy_unmet (unchanged from PR #53).
    await _create_policy(
        db_session, org_id=user_org.org.id, name="Standard Legal Review"
    )
    contract, _ = await _create_contract_with_request(
        db_session, org=user_org.org, user=user_org.user
    )
    r2 = await client.get(
        f"/api/contracts/{contract.id}/approval-gate",
        headers=_headers(user_org.user),
    )
    assert r2.json()["allowed"] is False
    assert r2.json()["code"] == "required_approval_policy_unmet"


async def test_cross_org_access_returns_404(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    # An org-A user must not be able to read the gate of an org-B
    # contract — the endpoint resolves the contract through
    # _get_contract_for_org, which scopes by organization_id and
    # returns 404 (not 403, so the endpoint can't be used to probe
    # for the existence of a contract id).
    org_a = await _create_user_org(db_session)
    org_b = await _create_user_org(db_session)
    contract = Contract(
        organization_id=org_b.org.id,
        uploaded_by=org_b.user.id,
        title="Org B contract",
        status="ready",
        s3_key="dummy/key",
        mime_type="application/pdf",
        file_hash_sha256="0" * 64,
    )
    db_session.add(contract)
    await db_session.commit()

    response = await client.get(
        f"/api/contracts/{contract.id}/approval-gate",
        headers=_headers(org_a.user),
    )
    assert response.status_code == 404
