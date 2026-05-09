"""API tests for the dashboard summary endpoint.

The dashboard is small but a load-bearing read surface: every CLM page
links here, so a mistake in scoping or filtering is immediately
user-visible. The tests pin:

* org scoping for every count and list (cross-org rows must not leak),
* the cancelled / dismissed / completed exclusions,
* the today-relative "due soon" / "overdue" windows,
* limit handling,
* presence/absence flags for ``generated_docx`` and ``signed_pdf``,
* and the no-storage-internals invariant on the serialized response.
"""
from __future__ import annotations

import secrets
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
import pytest
from sqlalchemy import event
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
    AgreementTemplateStatus,
    Contract,
    ContractArtifact,
    ContractRequest,
    ContractRequestStatus,
    ContractStatus,
    InboxItem,
    InboxItemStatus,
    Organization,
    User,
)
from app.security.audit_log import AuditEvent  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)
_DOCX_MIME = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


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
        return sync_url.replace(
            "postgresql+psycopg2://", "postgresql+asyncpg://", 1
        )
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
            ContractArtifact.__table__,
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


def _headers(user_id: uuid.UUID) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user_id)}


def _today() -> date:
    return datetime.now(UTC).date()


# ---------------------------------------------------------------------------
# Test data builders
# ---------------------------------------------------------------------------


async def _make_request(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    created_by: uuid.UUID,
    title: str = "NDA with Acme",
    status: str = ContractRequestStatus.OPEN.value,
    priority: str | None = None,
    due_date: date | None = None,
    request_type: str | None = None,
    contract_type: str | None = None,
    counterparty_name: str | None = None,
    linked_contract_id: uuid.UUID | None = None,
) -> ContractRequest:
    row = ContractRequest(
        organization_id=org_id,
        title=title,
        status=status,
        priority=priority,
        due_date=due_date,
        request_type=request_type,
        contract_type=contract_type,
        counterparty_name=counterparty_name,
        linked_contract_id=linked_contract_id,
        created_by=created_by,
    )
    session.add(row)
    await session.commit()
    return row


async def _make_inbox(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    created_by: uuid.UUID,
    title: str = "Review",
    item_type: str = "general",
    status: str = InboxItemStatus.OPEN.value,
    priority: str | None = None,
    due_date: date | None = None,
    request_id: uuid.UUID | None = None,
    contract_id: uuid.UUID | None = None,
    template_id: uuid.UUID | None = None,
) -> InboxItem:
    row = InboxItem(
        organization_id=org_id,
        title=title,
        item_type=item_type,
        status=status,
        priority=priority,
        due_date=due_date,
        request_id=request_id,
        contract_id=contract_id,
        template_id=template_id,
        created_by=created_by,
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
    status: str = ContractStatus.READY.value,
    docuseal_submission_id: str | None = None,
    artifact_types: list[str] | None = None,
) -> Contract:
    contract = Contract(
        organization_id=org_id,
        uploaded_by=uploaded_by,
        title=title,
        status=status,
        s3_key=f"docs/{uuid.uuid4()}.bin",
        mime_type=_DOCX_MIME,
        file_hash_sha256="0" * 64,
        page_count=None,
        full_text=None,
        docuseal_submission_id=docuseal_submission_id,
    )
    session.add(contract)
    await session.commit()
    for at in artifact_types or []:
        session.add(
            ContractArtifact(
                organization_id=org_id,
                contract_id=contract.id,
                artifact_type=at,
                storage_backend="s3",
                storage_key=f"artifacts/{uuid.uuid4()}.bin",
                filename="x.bin",
                mime_type=_DOCX_MIME,
                file_hash_sha256="a" * 64,
                size_bytes=1,
                source="test",
                is_official=True,
                created_by=uploaded_by,
            )
        )
    if artifact_types:
        await session.commit()
    return contract


async def _make_template(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    created_by: uuid.UUID,
    name: str = "NDA",
    status: str = AgreementTemplateStatus.ACTIVE.value,
) -> AgreementTemplate:
    row = AgreementTemplate(
        organization_id=org_id,
        name=name,
        status=status,
        created_by=created_by,
    )
    session.add(row)
    await session.commit()
    return row


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_summary_returns_zero_counts_for_empty_org(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    response = await client.get(
        "/api/dashboard/summary", headers=_headers(user_org.user.id)
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["counts"] == {
        "open_requests": 0,
        "in_progress_requests": 0,
        "urgent_or_high_priority_requests": 0,
        "open_inbox_items": 0,
        "overdue_inbox_items": 0,
        "contracts_total": 0,
        "contracts_sent_for_signature": 0,
        "contracts_executed": 0,
        "templates_active": 0,
    }
    assert body["upcoming"]["requests_due_soon"] == []
    assert body["upcoming"]["inbox_items_due_soon"] == []
    assert body["recent_activity"]["recent_contracts"] == []
    assert body["recent_activity"]["recent_requests"] == []
    assert body["recent_activity"]["recent_signed_contracts"] == []


async def test_summary_counts_match_state(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    today = _today()

    # Requests across every status + priority combination we count.
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Open low",
        status=ContractRequestStatus.OPEN.value,
        priority="low",
    )
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Open high",
        status=ContractRequestStatus.OPEN.value,
        priority="high",
    )
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="In-progress urgent",
        status=ContractRequestStatus.IN_PROGRESS.value,
        priority="urgent",
    )
    # Cancelled and completed must NOT contribute to the open /
    # in-progress counts.
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Cancelled",
        status=ContractRequestStatus.CANCELLED.value,
        priority="urgent",
    )
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Completed",
        status=ContractRequestStatus.COMPLETED.value,
        priority="high",
    )

    # Inbox items: open + overdue, dismissed/completed must be excluded.
    await _make_inbox(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Open today",
        status=InboxItemStatus.OPEN.value,
    )
    await _make_inbox(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Open overdue",
        status=InboxItemStatus.OPEN.value,
        due_date=today - timedelta(days=3),
    )
    await _make_inbox(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Dismissed overdue",
        status=InboxItemStatus.DISMISSED.value,
        due_date=today - timedelta(days=3),
    )
    await _make_inbox(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Completed overdue",
        status=InboxItemStatus.COMPLETED.value,
        due_date=today - timedelta(days=3),
    )

    # Contracts in three statuses; counts cover total / sent / executed.
    await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Draft",
        status=ContractStatus.READY.value,
    )
    await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Out for signature",
        status=ContractStatus.SENT_FOR_SIGNATURE.value,
    )
    await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Done",
        status=ContractStatus.EXECUTED.value,
    )

    # Templates: one active, one archived (only the active one counts).
    await _make_template(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        name="Active",
        status=AgreementTemplateStatus.ACTIVE.value,
    )
    await _make_template(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        name="Archived",
        status=AgreementTemplateStatus.ARCHIVED.value,
    )

    response = await client.get(
        "/api/dashboard/summary", headers=_headers(user_org.user.id)
    )
    assert response.status_code == 200
    counts = response.json()["counts"]

    assert counts["open_requests"] == 2  # Open low + Open high
    assert counts["in_progress_requests"] == 1  # In-progress urgent
    # Open high + In-progress urgent. Cancelled + completed urgents are
    # excluded by the status filter.
    assert counts["urgent_or_high_priority_requests"] == 2
    assert counts["open_inbox_items"] == 2
    assert counts["overdue_inbox_items"] == 1
    assert counts["contracts_total"] == 3
    assert counts["contracts_sent_for_signature"] == 1
    assert counts["contracts_executed"] == 1
    assert counts["templates_active"] == 1


async def test_due_soon_window_is_two_weeks_inclusive(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    today = _today()

    # Inside window: today, +1 day, +14 days. Outside: yesterday, +15.
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Today",
        due_date=today,
    )
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Tomorrow",
        due_date=today + timedelta(days=1),
    )
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Edge of window",
        due_date=today + timedelta(days=14),
    )
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Yesterday",
        due_date=today - timedelta(days=1),
    )
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Just outside",
        due_date=today + timedelta(days=15),
    )
    # Cancelled in-window must NOT show up.
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Cancelled in-window",
        status=ContractRequestStatus.CANCELLED.value,
        due_date=today + timedelta(days=2),
    )
    # Completed in-window also drops out — only open/in_progress count.
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Completed in-window",
        status=ContractRequestStatus.COMPLETED.value,
        due_date=today + timedelta(days=2),
    )

    response = await client.get(
        "/api/dashboard/summary", headers=_headers(user_org.user.id)
    )
    titles = [r["title"] for r in response.json()["upcoming"]["requests_due_soon"]]
    assert titles == ["Today", "Tomorrow", "Edge of window"]


async def test_inbox_due_soon_excludes_dismissed_and_completed(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    today = _today()

    await _make_inbox(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Open due tomorrow",
        status=InboxItemStatus.OPEN.value,
        due_date=today + timedelta(days=1),
    )
    await _make_inbox(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Dismissed in-window",
        status=InboxItemStatus.DISMISSED.value,
        due_date=today + timedelta(days=1),
    )
    await _make_inbox(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Completed in-window",
        status=InboxItemStatus.COMPLETED.value,
        due_date=today + timedelta(days=1),
    )

    response = await client.get(
        "/api/dashboard/summary", headers=_headers(user_org.user.id)
    )
    titles = [
        i["title"]
        for i in response.json()["upcoming"]["inbox_items_due_soon"]
    ]
    assert titles == ["Open due tomorrow"]


async def test_recent_lists_are_ordered_and_limited(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)

    # Six contracts; default limit is 5, so the oldest must drop off.
    # SQLite's ``server_default=func.now()`` has second-level resolution,
    # so rows committed in the same second carry identical timestamps
    # and the row order falls through to a tie-breaker. We pin explicit
    # increasing ``created_at`` values so the "newest first" assertion
    # is deterministic on SQLite as well as Postgres.
    base = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
    for i in range(6):
        contract = await _make_contract(
            db_session,
            org_id=user_org.org.id,
            uploaded_by=user_org.user.id,
            title=f"Contract {i}",
        )
        contract.created_at = base + timedelta(minutes=i)
        contract.updated_at = contract.created_at
    await db_session.commit()

    # Six requests, then cancel one to confirm cancellations don't show up
    # in the "recent requests" feed.
    for i in range(6):
        request = await _make_request(
            db_session,
            org_id=user_org.org.id,
            created_by=user_org.user.id,
            title=f"Request {i}",
        )
        request.created_at = base + timedelta(minutes=i)
        request.updated_at = request.created_at
    cancelled = await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
        title="Cancelled latest",
        status=ContractRequestStatus.CANCELLED.value,
    )
    cancelled.created_at = base + timedelta(minutes=99)
    cancelled.updated_at = cancelled.created_at
    await db_session.commit()
    assert cancelled.status == ContractRequestStatus.CANCELLED.value

    response = await client.get(
        "/api/dashboard/summary", headers=_headers(user_org.user.id)
    )
    body = response.json()

    contract_titles = [
        c["title"] for c in body["recent_activity"]["recent_contracts"]
    ]
    assert len(contract_titles) == 5
    assert contract_titles[0] == "Contract 5"  # newest first
    assert "Contract 0" not in contract_titles  # oldest dropped

    request_titles = [
        r["title"] for r in body["recent_activity"]["recent_requests"]
    ]
    assert len(request_titles) == 5
    assert "Cancelled latest" not in request_titles


async def test_recent_signed_contracts_only_includes_executed(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)

    await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Draft",
        status=ContractStatus.READY.value,
    )
    await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Out",
        status=ContractStatus.SENT_FOR_SIGNATURE.value,
    )
    await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Signed",
        status=ContractStatus.EXECUTED.value,
        artifact_types=["signed_pdf"],
    )

    response = await client.get(
        "/api/dashboard/summary", headers=_headers(user_org.user.id)
    )
    signed = response.json()["recent_activity"]["recent_signed_contracts"]
    assert len(signed) == 1
    assert signed[0]["title"] == "Signed"
    assert signed[0]["status"] == "executed"
    assert signed[0]["has_signed_pdf"] is True
    assert signed[0]["has_generated_docx"] is False


async def test_artifact_flags_set_for_recent_contracts(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)

    await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Has both",
        artifact_types=["generated_docx", "signed_pdf"],
    )
    await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="Has nothing",
    )

    response = await client.get(
        "/api/dashboard/summary", headers=_headers(user_org.user.id)
    )
    rows = {
        c["title"]: c
        for c in response.json()["recent_activity"]["recent_contracts"]
    }
    assert rows["Has both"]["has_generated_docx"] is True
    assert rows["Has both"]["has_signed_pdf"] is True
    assert rows["Has nothing"]["has_generated_docx"] is False
    assert rows["Has nothing"]["has_signed_pdf"] is False


async def test_cross_org_data_does_not_leak(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    today = _today()
    org_a = await _create_user_org(db_session, email="a@example.com")
    org_b = await _create_user_org(db_session, email="b@example.com")

    # Stuff every kind of row into org B; org A's dashboard must show
    # zeros and empty lists.
    await _make_request(
        db_session,
        org_id=org_b.org.id,
        created_by=org_b.user.id,
        title="B request",
        priority="urgent",
        due_date=today + timedelta(days=1),
    )
    await _make_inbox(
        db_session,
        org_id=org_b.org.id,
        created_by=org_b.user.id,
        title="B inbox",
        due_date=today - timedelta(days=1),
    )
    await _make_contract(
        db_session,
        org_id=org_b.org.id,
        uploaded_by=org_b.user.id,
        title="B contract",
        status=ContractStatus.EXECUTED.value,
    )
    await _make_template(
        db_session,
        org_id=org_b.org.id,
        created_by=org_b.user.id,
        name="B template",
    )

    response = await client.get(
        "/api/dashboard/summary", headers=_headers(org_a.user.id)
    )
    body = response.json()
    assert all(v == 0 for v in body["counts"].values())
    assert body["upcoming"]["requests_due_soon"] == []
    assert body["upcoming"]["inbox_items_due_soon"] == []
    assert body["recent_activity"]["recent_contracts"] == []
    assert body["recent_activity"]["recent_requests"] == []
    assert body["recent_activity"]["recent_signed_contracts"] == []


async def test_response_does_not_leak_storage_internals(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)

    await _make_contract(
        db_session,
        org_id=user_org.org.id,
        uploaded_by=user_org.user.id,
        title="With artifact",
        artifact_types=["generated_docx"],
    )
    await _make_request(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
    )
    await _make_inbox(
        db_session,
        org_id=user_org.org.id,
        created_by=user_org.user.id,
    )

    response = await client.get(
        "/api/dashboard/summary", headers=_headers(user_org.user.id)
    )
    text = response.text
    for forbidden in (
        "storage_key",
        "wrapped_dek",
        "s3_key",
        "wrapped_master_key",
        "full_text",
    ):
        assert forbidden not in text, f"{forbidden!r} leaked into dashboard response"


async def test_limit_parameter_clamped_to_max(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    user_org = await _create_user_org(db_session)
    for i in range(25):
        await _make_contract(
            db_session,
            org_id=user_org.org.id,
            uploaded_by=user_org.user.id,
            title=f"C{i}",
        )

    # max accepted limit is 20.
    ok = await client.get(
        "/api/dashboard/summary?limit=20", headers=_headers(user_org.user.id)
    )
    assert ok.status_code == 200
    assert len(ok.json()["recent_activity"]["recent_contracts"]) == 20

    # Above max -> 422 from FastAPI's Query(le=20).
    bad = await client.get(
        "/api/dashboard/summary?limit=21", headers=_headers(user_org.user.id)
    )
    assert bad.status_code == 422


async def test_summary_requires_dev_user(
    client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    response = await client.get("/api/dashboard/summary")
    assert response.status_code == 401
