"""End-to-end tests for the playbook-review endpoint.

The matcher itself is unit tested in `test_playbook_matcher.py`. This
suite exercises the HTTP surface: auth, org scoping, the inactive
playbook 404, the empty-clauses 409, response shape and the
non-persistence guarantee that PR #21 is built around.
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
    Organization,
    Playbook,
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
        # Only what the playbook-review path touches.
        tables = [
            Organization.__table__,
            User.__table__,
            AuditEvent.__table__,
            Playbook.__table__,
            Contract.__table__,
            Clause.__table__,
            DeviationFinding.__table__,
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


def _seed_clauses(contract: Contract, text: str) -> list[Clause]:
    """Hand-build clauses for the sample contract.

    We avoid running the full segmenter here because we want predictable
    clause types and spans for the API-level assertions; the matcher's
    own behavior is already covered in the matcher unit tests.
    """
    seeds = [
        ("confidentiality", "1. Confidentiality. Each party shall hold confidential information."),
        ("governing_law", "2. Governing Law. This Agreement is governed by Delaware law."),
        ("assignment", "3. Assignment. Neither party may assign without the prior written consent of the other."),
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


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


def _review_url(contract_id: uuid.UUID) -> str:
    return f"/api/contracts/{contract_id}/playbook-review"


# --------------------------------------------------------------------------
# Happy path
# --------------------------------------------------------------------------


class TestHappyPath:
    async def test_returns_review_result_with_pass_and_fail_counts(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _review_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["playbook_id"] == str(ws.playbook.id)
        assert body["contract_id"] == str(ws.contract.id)
        assert body["rules_checked"] == 3
        # confidentiality required_clause -> pass
        # governing_law preferred_value=California -> fail (Delaware in clause)
        # assignment text_contains [consent, prior written] -> pass
        assert body["passed_count"] == 2
        assert body["failed_count"] == 1
        ids = {(r["rule_id"], r["status"]) for r in body["results"]}
        assert ids == {
            ("confidentiality-required", "pass"),
            ("governing-law-california", "fail"),
            ("assignment-consent", "pass"),
        }

    async def test_evidence_spans_match_seeded_clauses(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _review_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 200
        clause_by_type = {c.clause_type: c for c in ws.clauses}
        for r in response.json()["results"]:
            if r["clause_id"] is None:
                continue
            expected = clause_by_type[r["clause_type"]]
            assert r["span_start"] == expected.span_start
            assert r["span_end"] == expected.span_end


# --------------------------------------------------------------------------
# Auth and org scoping
# --------------------------------------------------------------------------


class TestAuthAndScoping:
    async def test_missing_dev_user_header_returns_401(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _review_url(ws.contract.id),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 401

    async def test_cross_org_contract_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session, email="a@example.com")
        _, other_user = await _create_org_user(db_session, email="b@example.com")
        await db_session.commit()
        response = await client.post(
            _review_url(ws.contract.id),
            headers=_headers(other_user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 404

    async def test_cross_org_playbook_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        # Two separate orgs; the caller's contract exists, but the playbook
        # lives in the other org — must 404, not leak existence.
        ws_a = await _create_workspace(db_session, email="a@example.com")
        ws_b = await _create_workspace(db_session, email="b@example.com")
        response = await client.post(
            _review_url(ws_a.contract.id),
            headers=_headers(ws_a.user),
            json={"playbook_id": str(ws_b.playbook.id)},
        )
        assert response.status_code == 404

    async def test_inactive_playbook_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session, playbook_active=False)
        response = await client.post(
            _review_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 404

    async def test_unknown_contract_id_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _review_url(uuid.uuid4()),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 404

    async def test_unknown_playbook_id_returns_404(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _review_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(uuid.uuid4())},
        )
        assert response.status_code == 404


# --------------------------------------------------------------------------
# Preconditions
# --------------------------------------------------------------------------


class TestPreconditions:
    async def test_contract_with_no_clauses_returns_409(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session, contract_text=None)
        response = await client.post(
            _review_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 409
        assert "no segmented clauses" in response.json()["detail"].lower()

    async def test_malformed_body_returns_422(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _review_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"not_a_field": "x"},
        )
        assert response.status_code == 422


# --------------------------------------------------------------------------
# Non-persistence and security guarantees
# --------------------------------------------------------------------------


class TestNonPersistence:
    async def test_review_does_not_create_deviation_findings(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _review_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        assert response.status_code == 200
        # Persisted findings are explicitly out of scope for PR #21. If
        # this assert ever fires, someone has reintroduced state into a
        # transient endpoint.
        result = await db_session.execute(select(DeviationFinding))
        assert result.scalar_one_or_none() is None

    async def test_review_does_not_mutate_playbook(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        before_yaml = ws.playbook.yaml_source
        before_active = ws.playbook.is_active
        playbook_id = ws.playbook.id
        await client.post(
            _review_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        # Refresh to observe any persisted change. `refresh` issues a fresh
        # SELECT through the async session, so we don't need expire_all.
        await db_session.refresh(ws.playbook)
        assert ws.playbook.id == playbook_id
        assert ws.playbook.yaml_source == before_yaml
        assert ws.playbook.is_active == before_active

    async def test_review_does_not_mutate_clauses(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        before_count = len(ws.clauses)
        before_texts = sorted(c.text for c in ws.clauses)
        await client.post(
            _review_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        result = await db_session.execute(
            select(Clause).where(Clause.contract_id == ws.contract.id)
        )
        rows = list(result.scalars())
        assert len(rows) == before_count
        assert sorted(c.text for c in rows) == before_texts

    async def test_response_does_not_leak_storage_or_encryption_material(
        self, client: httpx.AsyncClient, db_session: AsyncSession
    ) -> None:
        ws = await _create_workspace(db_session)
        response = await client.post(
            _review_url(ws.contract.id),
            headers=_headers(ws.user),
            json={"playbook_id": str(ws.playbook.id)},
        )
        body = response.text
        for forbidden in (
            "wrapped_dek",
            "wrapped_master_key",
            "s3_key",
            "presigned_url",
        ):
            assert forbidden not in body, (
                f"response contained forbidden key {forbidden!r}: {body[:200]}"
            )


# --------------------------------------------------------------------------
# LLM-call sentinel
#
# The matcher itself is verified to be free of LLM SDK imports in
# `test_playbook_matcher.py`. Here we assert something narrower:
# `app.services.playbook_matcher` and `app.schemas.playbook_review`
# (the two modules introduced by this PR) do not reference any LLM
# client. The contracts router as a whole is not in scope — the
# upload endpoint legitimately uses litellm for metadata extraction.
# --------------------------------------------------------------------------


def test_review_modules_do_not_import_llm_clients() -> None:
    import inspect

    import app.schemas.playbook_review as schema_mod
    import app.services.playbook_matcher as matcher_mod

    forbidden = ("litellm", "openai.", "anthropic.", "ollama")
    for module in (schema_mod, matcher_mod):
        src = inspect.getsource(module)
        for token in forbidden:
            assert token not in src, (
                f"{module.__name__} references {token!r}; matcher path must "
                "remain LLM-free in PR #21"
            )
