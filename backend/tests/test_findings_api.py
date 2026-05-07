"""End-to-end tests for the persisted-findings HTTP surface.

Mirrors the fixture style of `test_playbook_review_api.py`: prefer a
real Postgres via testcontainers when Docker is reachable, otherwise
fall back to SQLite with the persisted-review tables only. The
findings logic itself is exercised at the service layer in
`test_deviation_findings.py`; this file is about the HTTP edge —
auth, scoping, status codes, response shape, and the wire-level
guarantees.
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
    Clause,
    Contract,
    DeviationFinding,
    FindingStatus,
    Organization,
    Playbook,
    PlaybookReviewRun,
    User,
)
from app.security.audit_log import AuditEvent  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402
from app.services.playbook_loader import parse_playbook, serialize_playbook  # noqa: E402

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)


VALID_PLAYBOOK_YAML = """
name: "Mutual NDA Review Playbook"
description: "Baseline review rules for mutual NDAs."
version: "1.0"
jurisdiction: "California"
contract_type: "mutual_nda"

rules:
  - id: "confidentiality-required"
    title: "Confidentiality clause should be present"
    clause_type: "confidentiality"
    severity: "high"
    rule_type: "required_clause"

  - id: "governing-law-california"
    title: "Governing law should be California"
    clause_type: "governing_law"
    severity: "medium"
    rule_type: "preferred_value"
    expected_value: "California"

  - id: "assignment-consent"
    title: "Assignment should require consent"
    clause_type: "assignment"
    severity: "medium"
    rule_type: "text_contains"
    required_terms:
      - "consent"
      - "prior written"
"""


SAMPLE_CONTRACT_TEXT = (
    "1. Confidentiality. Each party shall hold confidential information.\n\n"
    "2. Governing Law. This Agreement is governed by Delaware law.\n\n"
    "3. Assignment. Neither party may assign without the prior written consent of the other.\n"
)


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
        tables = [
            Organization.__table__,
            User.__table__,
            AuditEvent.__table__,
            Playbook.__table__,
            Contract.__table__,
            Clause.__table__,
            PlaybookReviewRun.__table__,
            DeviationFinding.__table__,
        ]
    else:
        engine = create_async_engine(
            _container_async_url(postgres_container), echo=False
        )
        tables = list(Base.metadata.sorted_tables)

    if engine.dialect.name == "sqlite":
        @event.listens_for(engine.sync_engine, "connect")
        def _enable_sqlite_foreign_keys(
            dbapi_connection: Any, _record: Any
        ) -> None:
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
class Workspace:
    org: Organization
    user: User
    contract: Contract
    clauses: list[Clause]
    playbook: Playbook


def _wrapped_org_key(org_id: uuid.UUID) -> bytes:
    return create_org_master_key(
        organization_id=str(org_id),
        instance_key=_INSTANCE_KEY,
    ).to_bytes()


async def _create_org_user(
    session: AsyncSession,
    *,
    email: str | None = None,
) -> tuple[Organization, User]:
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
        is_active=True,
    )
    session.add_all([org, user])
    await session.flush()
    return org, user


def _seed_clauses(contract: Contract, text: str) -> list[Clause]:
    seeds = [
        ("confidentiality", "1. Confidentiality. Each party shall hold confidential information."),
        ("governing_law", "2. Governing Law. This Agreement is governed by Delaware law."),
        (
            "assignment",
            "3. Assignment. Neither party may assign without the prior written consent of the other.",
        ),
    ]
    rows: list[Clause] = []
    for ordinal, (clause_type, body) in enumerate(seeds):
        start = text.index(body)
        rows.append(
            Clause(
                id=uuid.uuid4(),
                organization_id=contract.organization_id,
                contract_id=contract.id,
                ordinal=ordinal,
                heading=None,
                clause_type=clause_type,
                clause_type_source="heuristic",
                text=body,
                span_start=start,
                span_end=start + len(body),
                confidence=None,
                segmentation_method="heuristic_v1",
                model_name=None,
                prompt_version=None,
            )
        )
    return rows


async def _create_workspace(
    session: AsyncSession,
    *,
    yaml_source: str = VALID_PLAYBOOK_YAML,
    contract_text: str | None = SAMPLE_CONTRACT_TEXT,
    playbook_active: bool = True,
    email: str | None = None,
) -> Workspace:
    org, user = await _create_org_user(session, email=email)
    parsed = parse_playbook(yaml_source)
    playbook = Playbook(
        id=uuid.uuid4(),
        organization_id=org.id,
        name=parsed.name,
        description=parsed.description,
        jurisdiction=parsed.jurisdiction,
        contract_type=parsed.contract_type,
        version=parsed.version,
        yaml_source=yaml_source,
        parsed_rules=serialize_playbook(parsed),
        is_active=playbook_active,
    )
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=org.id,
        uploaded_by=user.id,
        title="Sample contract",
        status="ready",
        s3_key="contracts/sample.pdf",
        mime_type="application/pdf",
        file_hash_sha256="a" * 64,
        full_text=contract_text,
    )
    session.add_all([playbook, contract])
    await session.flush()

    clauses: list[Clause] = []
    if contract_text is not None:
        clauses = _seed_clauses(contract, contract_text)
        session.add_all(clauses)
        await session.flush()
    await session.commit()
    return Workspace(
        org=org, user=user, contract=contract, clauses=clauses, playbook=playbook
    )


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


def _runs_url(contract_id: uuid.UUID) -> str:
    return f"/api/contracts/{contract_id}/playbook-review/runs"


def _run_url(contract_id: uuid.UUID, run_id: uuid.UUID) -> str:
    return f"/api/contracts/{contract_id}/playbook-review/runs/{run_id}"


def _findings_url(contract_id: uuid.UUID) -> str:
    return f"/api/contracts/{contract_id}/findings"


def _finding_url(contract_id: uuid.UUID, finding_id: uuid.UUID) -> str:
    return f"/api/contracts/{contract_id}/findings/{finding_id}"


# --------------------------------------------------------------------------
# Create run
# --------------------------------------------------------------------------


class TestCreateRun:
    async def test_happy_path_persists_run_and_failed_findings(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["contract_id"] == str(ws.contract.id)
        assert body["playbook_id"] == str(ws.playbook.id)
        assert body["playbook_name"] == ws.playbook.name
        assert body["rules_checked"] == 3
        assert body["passed_count"] == 2
        assert body["failed_count"] == 1
        # Persisted findings = failures only.
        assert len(body["findings"]) == 1
        assert body["findings"][0]["rule_id"] == "governing-law-california"
        assert body["findings"][0]["status"] == "fail"
        assert body["findings"][0]["finding_status"] == "open"
        # Per-rule results includes passes too.
        assert len(body["results"]) == 3
        # Verify rows landed.
        runs = (await db_session.execute(select(PlaybookReviewRun))).scalars().all()
        findings = (
            await db_session.execute(select(DeviationFinding))
        ).scalars().all()
        assert len(runs) == 1
        assert len(findings) == 1

    async def test_evidence_spans_match_seeded_clauses(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 201
        finding = response.json()["findings"][0]
        gov = next(c for c in ws.clauses if c.clause_type == "governing_law")
        assert finding["span_start"] == gov.span_start
        assert finding["span_end"] == gov.span_end
        assert finding["clause_id"] == str(gov.id)

    async def test_response_excludes_storage_and_encryption_fields(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        body = response.text
        for forbidden in (
            "wrapped_dek",
            "wrapped_master_key",
            "s3_key",
            "presigned_url",
            "presigned_uri",
        ):
            assert forbidden not in body, (
                f"response contained forbidden key {forbidden!r}: {body[:200]}"
            )

    async def test_persists_only_failed_findings(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 201
        body = response.json()
        rows = (
            await db_session.execute(select(DeviationFinding))
        ).scalars().all()
        assert len(rows) == body["failed_count"]
        assert all(r.status == "fail" for r in rows)

    async def test_rerun_supersedes_prior_open_findings(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        run_ids: list[str] = []
        for _ in range(2):
            response = await client.post(
                _runs_url(ws.contract.id),
                headers=_headers(ws.user),
                json={"playbook_id": str(ws.playbook.id)},
            )
            assert response.status_code == 201
            run_ids.append(response.json()["id"])
        await db_session.commit()
        rows = (
            await db_session.execute(select(DeviationFinding))
        ).scalars().all()
        assert len(rows) == 2
        statuses_by_run = {r.review_run_id: r.finding_status for r in rows}
        # The newer run's finding stays open; the older run's flips to
        # superseded. We use the response-returned `id`s rather than a
        # timestamp ordering, because in sqlite `now()` can collide
        # across two flushes in the same test.
        first_run_id, second_run_id = (
            uuid.UUID(run_ids[0]),
            uuid.UUID(run_ids[1]),
        )
        assert (
            statuses_by_run[first_run_id] == FindingStatus.SUPERSEDED.value
        )
        assert statuses_by_run[second_run_id] == FindingStatus.OPEN.value


class TestCreateRunAuthAndScoping:
    async def test_missing_dev_user_returns_401(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _runs_url(ws.contract.id),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 401

    async def test_cross_org_contract_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session, email="a@example.com")
        _, other = await _create_org_user(db_session, email="b@example.com")
        await db_session.commit()
        response = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(other),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 404

    async def test_cross_org_playbook_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws_a = await _create_workspace(db_session, email="a@example.com")
        ws_b = await _create_workspace(db_session, email="b@example.com")
        response = await client.post(
            _runs_url(ws_a.contract.id),
            headers=_headers(ws_a.user),
            json={"playbook_id": str(ws_b.playbook.id)},
        )
        assert response.status_code == 404

    async def test_inactive_playbook_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session, playbook_active=False)
        response = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 404

    async def test_no_clauses_returns_409(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session, contract_text=None)
        response = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 409

    async def test_malformed_body_returns_422(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"not_a_field": "x"},
        )
        assert response.status_code == 422


# --------------------------------------------------------------------------
# List / get runs
# --------------------------------------------------------------------------


class TestListAndGetRuns:
    async def test_list_runs_org_scoped(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session, email="a@example.com")
        # Create a run.
        await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        # Caller in another org sees a 404 (cross-org contract).
        _, other = await _create_org_user(db_session, email="b@example.com")
        await db_session.commit()
        response = await client.get(
            _runs_url(ws.contract.id), headers=_headers(other)
        )
        assert response.status_code == 404

    async def test_list_runs_returns_newest_first(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        for _ in range(2):
            r = await client.post(
                _runs_url(ws.contract.id),
                headers=_headers(ws.user),
                json={"playbook_id": str(ws.playbook.id)},
            )
            assert r.status_code == 201
        listing = await client.get(_runs_url(ws.contract.id), headers=_headers(ws.user))
        assert listing.status_code == 200
        runs = listing.json()
        assert len(runs) == 2
        # Both runs reference the same contract / playbook.
        for run in runs:
            assert run["contract_id"] == str(ws.contract.id)
            assert run["playbook_id"] == str(ws.playbook.id)
            assert run["playbook_name"] == ws.playbook.name

    async def test_get_run_returns_findings_and_results(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        created = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert created.status_code == 201
        run_id = created.json()["id"]
        response = await client.get(
            _run_url(ws.contract.id, uuid.UUID(run_id)),
            headers=_headers(ws.user),
        )
        assert response.status_code == 200
        body = response.json()
        assert body["id"] == run_id
        assert len(body["findings"]) == 1
        assert len(body["results"]) == 3

    async def test_get_run_cross_org_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session, email="a@example.com")
        created = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        run_id = uuid.UUID(created.json()["id"])
        _, other = await _create_org_user(db_session, email="b@example.com")
        await db_session.commit()
        response = await client.get(
            _run_url(ws.contract.id, run_id),
            headers=_headers(other),
        )
        assert response.status_code == 404


# --------------------------------------------------------------------------
# List findings
# --------------------------------------------------------------------------


class TestListFindings:
    async def test_default_excludes_superseded(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        for _ in range(2):
            await client.post(
                _runs_url(ws.contract.id),
                headers=_headers(ws.user),
                json={"playbook_id": str(ws.playbook.id)},
            )
        listing = await client.get(
            _findings_url(ws.contract.id), headers=_headers(ws.user)
        )
        assert listing.status_code == 200
        findings = listing.json()
        # 2 runs * 1 fail each = 2 rows; the older was superseded so
        # default response shows just 1.
        assert len(findings) == 1
        assert findings[0]["finding_status"] == "open"

    async def test_include_superseded_returns_all(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        for _ in range(2):
            await client.post(
                _runs_url(ws.contract.id),
                headers=_headers(ws.user),
                json={"playbook_id": str(ws.playbook.id)},
            )
        listing = await client.get(
            f"{_findings_url(ws.contract.id)}?include_superseded=true",
            headers=_headers(ws.user),
        )
        assert listing.status_code == 200
        findings = listing.json()
        assert len(findings) == 2

    async def test_filter_by_finding_status(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        listing = await client.get(
            f"{_findings_url(ws.contract.id)}?finding_status=ignored",
            headers=_headers(ws.user),
        )
        assert listing.status_code == 200
        assert listing.json() == []

    async def test_filter_by_severity(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        listing = await client.get(
            f"{_findings_url(ws.contract.id)}?severity=medium",
            headers=_headers(ws.user),
        )
        assert listing.status_code == 200
        assert len(listing.json()) == 1
        none = await client.get(
            f"{_findings_url(ws.contract.id)}?severity=blocker",
            headers=_headers(ws.user),
        )
        assert none.json() == []

    async def test_filter_by_review_run_and_playbook(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        first = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        second = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        run_id_1 = first.json()["id"]
        run_id_2 = second.json()["id"]
        # Filter on the older run; the row on it should be present even
        # though it has been superseded (explicit run filter overrides
        # default exclusion).
        for_first = await client.get(
            f"{_findings_url(ws.contract.id)}?review_run_id={run_id_1}&include_superseded=true",
            headers=_headers(ws.user),
        )
        assert for_first.status_code == 200
        assert len(for_first.json()) == 1
        # Sanity check: the newer run finding is still visible by default.
        listing = await client.get(
            f"{_findings_url(ws.contract.id)}?review_run_id={run_id_2}",
            headers=_headers(ws.user),
        )
        assert len(listing.json()) == 1

    async def test_cross_org_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session, email="a@example.com")
        _, other = await _create_org_user(db_session, email="b@example.com")
        await db_session.commit()
        response = await client.get(
            _findings_url(ws.contract.id), headers=_headers(other)
        )
        assert response.status_code == 404


# --------------------------------------------------------------------------
# Update finding status
# --------------------------------------------------------------------------


class TestUpdateFinding:
    async def test_open_to_reviewed_to_ignored_to_open(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        run = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        finding_id = run.json()["findings"][0]["id"]
        for status in ("reviewed", "ignored", "open"):
            response = await client.patch(
                _finding_url(ws.contract.id, uuid.UUID(finding_id)),
                headers=_headers(ws.user),
                json={"finding_status": status},
            )
            assert response.status_code == 200, response.text
            assert response.json()["finding_status"] == status

    async def test_invalid_status_returns_422(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        run = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        finding_id = run.json()["findings"][0]["id"]
        response = await client.patch(
            _finding_url(ws.contract.id, uuid.UUID(finding_id)),
            headers=_headers(ws.user),
            json={"finding_status": "wat"},
        )
        assert response.status_code == 422

    async def test_superseded_rejected_via_api(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        run = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        finding_id = run.json()["findings"][0]["id"]
        # The Pydantic literal forbids `superseded` on the request body,
        # so the server must reject with 422.
        response = await client.patch(
            _finding_url(ws.contract.id, uuid.UUID(finding_id)),
            headers=_headers(ws.user),
            json={"finding_status": "superseded"},
        )
        assert response.status_code == 422

    async def test_cross_org_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session, email="a@example.com")
        run = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        finding_id = uuid.UUID(run.json()["findings"][0]["id"])
        _, other = await _create_org_user(db_session, email="b@example.com")
        await db_session.commit()
        response = await client.patch(
            _finding_url(ws.contract.id, finding_id),
            headers=_headers(other),
            json={"finding_status": "reviewed"},
        )
        assert response.status_code == 404

    async def test_does_not_mutate_deterministic_fields(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        run = await client.post(
            _runs_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        finding = run.json()["findings"][0]
        finding_id = uuid.UUID(finding["id"])
        # Snapshot deterministic fields.
        keys = (
            "rule_id",
            "rule_title",
            "rule_type",
            "clause_type",
            "severity",
            "status",
            "message",
            "span_start",
            "span_end",
            "evidence_text",
        )
        before = {k: finding[k] for k in keys}
        response = await client.patch(
            _finding_url(ws.contract.id, finding_id),
            headers=_headers(ws.user),
            json={"finding_status": "reviewed"},
        )
        assert response.status_code == 200
        after = response.json()
        for k in keys:
            assert after[k] == before[k]
