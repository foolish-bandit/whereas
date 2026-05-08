"""Tests for the suggested-redline pipeline.

Covers the prompt builder, the JSON parser/validator, the LiteLLM-
calling service, the status update, and the HTTP surface end-to-end.

Fixture style mirrors ``test_findings_api.py``: a real Postgres via
testcontainers when Docker is reachable, otherwise SQLite with the
relevant tables. The service-layer cases that don't need a session
(prompt builder, JSON validator) live in their own classes and run
unconditionally.
"""
from __future__ import annotations

import json
import secrets
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from types import SimpleNamespace
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
    PlaybookReviewRun,
    SuggestedRedline,
    SuggestedRedlineStatus,
    User,
)
from app.prompts.redline import build_redline_messages  # noqa: E402
from app.security.audit_log import AuditEvent  # noqa: E402
from app.security.encryption import create_org_master_key  # noqa: E402
from app.services import redline_generator  # noqa: E402
from app.services.redline_generator import (  # noqa: E402
    GeneratedRedline,
    InvalidRedlineStatusError,
    RedlineGenerationError,
    _parse_and_validate,
    generate_redline_for_finding,
    update_redline_status,
)

_PG_IMAGE = "pgvector/pgvector:pg16"
_INSTANCE_KEY = secrets.token_bytes(32)


# --------------------------------------------------------------------------
# Pure unit tests: prompt builder
# --------------------------------------------------------------------------


class TestBuildRedlineMessages:
    """The prompt is the contract between the LLM and the rest of
    the pipeline. Regressions here silently degrade output quality, so
    keep these assertions specific.
    """

    def test_minimal_prompt_omits_empty_extras(self) -> None:
        messages = build_redline_messages(
            rule_title="Governing law should be California",
            rule_message="Governing law is Delaware, expected California.",
            rule_type="preferred_value",
            clause_type="governing_law",
            clause_text="This Agreement is governed by Delaware law.",
        )
        assert len(messages) == 2
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] == "user"
        user = messages[1]["content"]
        assert "Governing law should be California" in user
        assert "Delaware, expected California" in user
        assert "This Agreement is governed by Delaware law." in user
        # When firm fields are not provided the prompt should not
        # render placeholder lines for them.
        assert "Expected value" not in user
        assert "Required terms" not in user
        assert "Firm guidance" not in user
        assert "Firm preferred language" not in user

    def test_full_prompt_includes_firm_guidance(self) -> None:
        messages = build_redline_messages(
            rule_title="Assignment should require consent",
            rule_message="Assignment clause does not include the required language.",
            rule_type="text_contains",
            clause_type="assignment",
            clause_text="Either party may assign this Agreement.",
            expected_value=None,
            required_terms=["consent", "prior written"],
            guidance="Always require the counterparty's prior written consent.",
            preferred_language="Neither party may assign without the prior written consent of the other.",
        )
        user = messages[1]["content"]
        assert "consent" in user
        assert "prior written" in user
        assert "Always require the counterparty" in user
        assert "Neither party may assign" in user

    def test_preferred_language_is_quoted_block(self) -> None:
        """The triple-quoted block keeps the model from blending the
        preferred template with the surrounding rule metadata."""
        messages = build_redline_messages(
            rule_title="t",
            rule_message="m",
            rule_type="text_contains",
            clause_type="x",
            clause_text="c",
            preferred_language="REPLACE WITH THIS EXACT TEXT.",
        )
        user = messages[1]["content"]
        assert '"""\nREPLACE WITH THIS EXACT TEXT.\n"""' in user


# --------------------------------------------------------------------------
# Pure unit tests: parse + validate
# --------------------------------------------------------------------------


def _llm_response(payload: dict[str, Any] | str) -> str:
    return payload if isinstance(payload, str) else json.dumps(payload)


class TestParseAndValidate:
    def test_happy_path(self) -> None:
        result = _parse_and_validate(
            _llm_response(
                {
                    "redline_text": "Neither party may assign without consent.",
                    "rationale": "Adds the required consent language.",
                    "confidence": 0.82,
                }
            )
        )
        assert isinstance(result, GeneratedRedline)
        assert result.redline_text == "Neither party may assign without consent."
        assert result.rationale == "Adds the required consent language."
        assert result.confidence == 0.82

    def test_strips_redline_and_rationale(self) -> None:
        result = _parse_and_validate(
            _llm_response(
                {
                    "redline_text": "  hello.  ",
                    "rationale": "  why.  ",
                    "confidence": 0.5,
                }
            )
        )
        assert result.redline_text == "hello."
        assert result.rationale == "why."

    def test_rejects_invalid_json(self) -> None:
        with pytest.raises(RedlineGenerationError, match="Invalid JSON"):
            _parse_and_validate("not json at all")

    def test_rejects_top_level_array(self) -> None:
        with pytest.raises(RedlineGenerationError, match="not a JSON object"):
            _parse_and_validate("[]")

    def test_rejects_empty_redline_text(self) -> None:
        with pytest.raises(
            RedlineGenerationError, match="redline_text is missing or empty"
        ):
            _parse_and_validate(
                _llm_response(
                    {"redline_text": "   ", "rationale": "x", "confidence": 0.5}
                )
            )

    def test_rejects_missing_redline_text(self) -> None:
        with pytest.raises(
            RedlineGenerationError, match="redline_text is missing or empty"
        ):
            _parse_and_validate(_llm_response({"confidence": 0.5}))

    def test_rejects_non_string_redline_text(self) -> None:
        with pytest.raises(
            RedlineGenerationError, match="redline_text is missing or empty"
        ):
            _parse_and_validate(
                _llm_response({"redline_text": 42, "confidence": 0.5})
            )

    def test_rejects_non_numeric_confidence(self) -> None:
        with pytest.raises(RedlineGenerationError, match="confidence is missing"):
            _parse_and_validate(
                _llm_response(
                    {"redline_text": "x", "confidence": "very high"}
                )
            )

    def test_rejects_nan_confidence(self) -> None:
        with pytest.raises(RedlineGenerationError, match="confidence is not finite"):
            _parse_and_validate(
                _llm_response(
                    {"redline_text": "x", "confidence": float("nan")}
                )
            )

    def test_rejects_out_of_range_confidence(self) -> None:
        with pytest.raises(RedlineGenerationError, match="out of range"):
            _parse_and_validate(
                _llm_response({"redline_text": "x", "confidence": 1.5})
            )
        with pytest.raises(RedlineGenerationError, match="out of range"):
            _parse_and_validate(
                _llm_response({"redline_text": "x", "confidence": -0.01})
            )

    def test_rejects_non_string_rationale(self) -> None:
        with pytest.raises(
            RedlineGenerationError, match="rationale, if present, must be a string"
        ):
            _parse_and_validate(
                _llm_response(
                    {
                        "redline_text": "x",
                        "rationale": ["not", "a", "string"],
                        "confidence": 0.5,
                    }
                )
            )

    def test_blank_rationale_becomes_none(self) -> None:
        result = _parse_and_validate(
            _llm_response(
                {"redline_text": "x", "rationale": "   ", "confidence": 0.5}
            )
        )
        assert result.rationale is None


# --------------------------------------------------------------------------
# Test-database fixtures (mirror test_findings_api.py)
# --------------------------------------------------------------------------


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
            SuggestedRedline.__table__,
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


# --------------------------------------------------------------------------
# Workspace seeding
# --------------------------------------------------------------------------


SAMPLE_CONTRACT_TEXT = (
    "1. Confidentiality. Each party shall hold confidential information.\n\n"
    "2. Governing Law. This Agreement is governed by Delaware law.\n\n"
    "3. Assignment. Neither party may assign without the prior written consent of the other.\n"
)


@dataclass
class Workspace:
    org: Organization
    user: User
    contract: Contract
    finding: DeviationFinding
    review_run: PlaybookReviewRun


def _wrapped_org_key(org_id: uuid.UUID) -> bytes:
    return create_org_master_key(
        organization_id=str(org_id),
        instance_key=_INSTANCE_KEY,
    ).to_bytes()


async def _seed_workspace(
    session: AsyncSession,
    *,
    finding_status_field: str = "fail",
    has_evidence: bool = True,
    email: str | None = None,
) -> Workspace:
    """Seed a workspace with one failed finding ready to redline.

    The finding row is constructed directly rather than going through
    the matcher so the test isolates the redline pipeline. ``finding_status_field``
    sets the deterministic ``status`` column ("fail" by default);
    ``has_evidence`` toggles whether the finding carries a clause-level
    span (mirrors the difference between a `text_contains` failure on
    a present clause and a `required_clause` failure on a missing one).
    """
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

    contract = Contract(
        id=uuid.uuid4(),
        organization_id=org.id,
        uploaded_by=user.id,
        title="Sample contract",
        status="ready",
        s3_key="contracts/sample.pdf",
        mime_type="application/pdf",
        file_hash_sha256="a" * 64,
        full_text=SAMPLE_CONTRACT_TEXT,
    )
    playbook = Playbook(
        id=uuid.uuid4(),
        organization_id=org.id,
        name="NDA review",
        version="1.0",
        yaml_source="name: x",
        parsed_rules={},
        is_active=True,
    )
    session.add_all([contract, playbook])
    await session.flush()

    clause: Clause | None = None
    span_start: int | None = None
    span_end: int | None = None
    evidence: str | None = None
    if has_evidence:
        body = "3. Assignment. Neither party may assign without the prior written consent of the other."
        span_start = SAMPLE_CONTRACT_TEXT.index(body)
        span_end = span_start + len(body)
        evidence = body
        clause = Clause(
            id=uuid.uuid4(),
            organization_id=org.id,
            contract_id=contract.id,
            ordinal=0,
            heading=None,
            clause_type="assignment",
            clause_type_source="heuristic",
            text=body,
            span_start=span_start,
            span_end=span_end,
            confidence=None,
            segmentation_method="heuristic_v1",
            model_name=None,
            prompt_version=None,
        )
        session.add(clause)
        await session.flush()

    review_run = PlaybookReviewRun(
        id=uuid.uuid4(),
        organization_id=org.id,
        contract_id=contract.id,
        playbook_id=playbook.id,
        rules_checked=1,
        failed_count=1,
        passed_count=0,
    )
    session.add(review_run)
    await session.flush()

    finding = DeviationFinding(
        id=uuid.uuid4(),
        organization_id=org.id,
        contract_id=contract.id,
        playbook_id=playbook.id,
        review_run_id=review_run.id,
        rule_id="assignment-consent",
        rule_title="Assignment should require consent",
        rule_type="text_contains",
        clause_type="assignment",
        severity="medium",
        status=finding_status_field,
        message="Assignment clause does not include 'consent'.",
        clause_id=clause.id if clause else None,
        evidence_text=evidence,
        span_start=span_start,
        span_end=span_end,
        matched_terms=["consent", "prior written"],
        expected_value=None,
        guidance="Always require the counterparty's prior written consent.",
        preferred_language="Neither party may assign without the prior written consent of the other.",
    )
    session.add(finding)
    await session.flush()
    await session.commit()
    return Workspace(
        org=org,
        user=user,
        contract=contract,
        finding=finding,
        review_run=review_run,
    )


def _headers(user: User) -> dict[str, str]:
    return {"X-Whereas-Dev-User": str(user.id)}


def _redline_url(contract_id: uuid.UUID, finding_id: uuid.UUID) -> str:
    return f"/api/contracts/{contract_id}/findings/{finding_id}/redline"


def _redlines_url(contract_id: uuid.UUID, finding_id: uuid.UUID) -> str:
    return f"/api/contracts/{contract_id}/findings/{finding_id}/redlines"


def _redline_item_url(
    contract_id: uuid.UUID, finding_id: uuid.UUID, redline_id: uuid.UUID
) -> str:
    return (
        f"/api/contracts/{contract_id}/findings/{finding_id}/redlines/{redline_id}"
    )


# --------------------------------------------------------------------------
# Litellm mock
# --------------------------------------------------------------------------


def _make_litellm_response(payload: dict[str, Any] | str) -> SimpleNamespace:
    content = payload if isinstance(payload, str) else json.dumps(payload)
    return SimpleNamespace(
        choices=[
            SimpleNamespace(message=SimpleNamespace(content=content))
        ]
    )


def _patch_litellm(
    monkeypatch: pytest.MonkeyPatch,
    payload: dict[str, Any] | str,
) -> list[dict[str, Any]]:
    """Patch litellm.acompletion to return a fixed payload.

    Returns the (mutable) list of captured calls so a test can assert
    the prompt the model received.
    """
    monkeypatch.setattr(
        redline_generator.settings, "LITELLM_PROVIDER", "ollama"
    )
    monkeypatch.setattr(
        redline_generator.settings, "EXTRACTION_MODEL", "llama3.1:70b"
    )
    captured: list[dict[str, Any]] = []

    async def fake_acompletion(**kwargs: Any) -> SimpleNamespace:
        captured.append(kwargs)
        return _make_litellm_response(payload)

    monkeypatch.setattr(
        redline_generator.litellm, "acompletion", fake_acompletion
    )
    return captured


# --------------------------------------------------------------------------
# Service: generate_redline_for_finding
# --------------------------------------------------------------------------


class TestGenerateRedlineForFinding:
    async def test_happy_path_persists_redline(
        self, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(
            monkeypatch,
            {
                "redline_text": (
                    "Neither party may assign this Agreement without the "
                    "prior written consent of the other party."
                ),
                "rationale": "Adds the required consent language.",
                "confidence": 0.86,
            },
        )

        redline = await generate_redline_for_finding(
            db_session,
            contract=ws.contract,
            finding=ws.finding,
            actor_user_id=ws.user.id,
        )

        assert redline.id is not None
        assert redline.finding_id == ws.finding.id
        assert redline.contract_id == ws.contract.id
        assert redline.organization_id == ws.org.id
        assert redline.created_by == ws.user.id
        assert redline.status == SuggestedRedlineStatus.PROPOSED.value
        assert redline.confidence == 0.86
        assert redline.model_name == "ollama/llama3.1:70b"
        assert redline.prompt_version.startswith("redline-v")
        assert "consent" in redline.redline_text
        assert redline.rationale == "Adds the required consent language."

        # And it lands in the table.
        rows = (
            await db_session.execute(
                select(SuggestedRedline).where(
                    SuggestedRedline.finding_id == ws.finding.id
                )
            )
        ).scalars().all()
        assert len(rows) == 1

    async def test_passes_firm_guidance_into_prompt(
        self, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ws = await _seed_workspace(db_session)
        captured = _patch_litellm(
            monkeypatch,
            {
                "redline_text": "ok",
                "rationale": "ok",
                "confidence": 0.5,
            },
        )

        await generate_redline_for_finding(
            db_session,
            contract=ws.contract,
            finding=ws.finding,
            actor_user_id=ws.user.id,
        )

        assert len(captured) == 1
        messages = captured[0]["messages"]
        user_content = messages[1]["content"]
        # The firm-authored fields end up verbatim in the user prompt.
        assert "Always require the counterparty" in user_content
        assert "Neither party may assign" in user_content
        # And the cited clause text travels through unchanged.
        assert "Assignment" in user_content

    async def test_rejects_pass_finding(
        self, db_session: AsyncSession
    ) -> None:
        ws = await _seed_workspace(db_session, finding_status_field="pass")
        with pytest.raises(
            RedlineGenerationError, match="failed findings"
        ):
            await generate_redline_for_finding(
                db_session,
                contract=ws.contract,
                finding=ws.finding,
                actor_user_id=ws.user.id,
            )

    async def test_rejects_finding_without_evidence(
        self, db_session: AsyncSession
    ) -> None:
        ws = await _seed_workspace(db_session, has_evidence=False)
        with pytest.raises(
            RedlineGenerationError,
            match="no clause-level evidence",
        ):
            await generate_redline_for_finding(
                db_session,
                contract=ws.contract,
                finding=ws.finding,
                actor_user_id=ws.user.id,
            )

    async def test_propagates_validation_failures(
        self, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(
            monkeypatch,
            {"redline_text": "x", "confidence": 1.5},
        )
        with pytest.raises(RedlineGenerationError, match="out of range"):
            await generate_redline_for_finding(
                db_session,
                contract=ws.contract,
                finding=ws.finding,
                actor_user_id=ws.user.id,
            )
        # Nothing got persisted on the failure path.
        rows = (
            await db_session.execute(select(SuggestedRedline))
        ).scalars().all()
        assert rows == []

    async def test_invalid_json_surfaces_as_generation_error(
        self, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(monkeypatch, "not json")
        with pytest.raises(RedlineGenerationError):
            await generate_redline_for_finding(
                db_session,
                contract=ws.contract,
                finding=ws.finding,
                actor_user_id=ws.user.id,
            )


# --------------------------------------------------------------------------
# Service: status update
# --------------------------------------------------------------------------


class TestUpdateRedlineStatus:
    async def test_accept_then_reject_then_propose(
        self, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(
            monkeypatch,
            {"redline_text": "x.", "rationale": "y.", "confidence": 0.5},
        )
        redline = await generate_redline_for_finding(
            db_session,
            contract=ws.contract,
            finding=ws.finding,
            actor_user_id=ws.user.id,
        )
        await update_redline_status(
            db_session,
            redline=redline,
            new_status=SuggestedRedlineStatus.ACCEPTED.value,
        )
        assert redline.status == "accepted"
        await update_redline_status(
            db_session,
            redline=redline,
            new_status=SuggestedRedlineStatus.REJECTED.value,
        )
        assert redline.status == "rejected"
        await update_redline_status(
            db_session,
            redline=redline,
            new_status=SuggestedRedlineStatus.PROPOSED.value,
        )
        assert redline.status == "proposed"

    async def test_invalid_status_raises(
        self, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(
            monkeypatch,
            {"redline_text": "x.", "rationale": "y.", "confidence": 0.5},
        )
        redline = await generate_redline_for_finding(
            db_session,
            contract=ws.contract,
            finding=ws.finding,
            actor_user_id=ws.user.id,
        )
        with pytest.raises(InvalidRedlineStatusError):
            await update_redline_status(
                db_session, redline=redline, new_status="superseded"
            )


# --------------------------------------------------------------------------
# HTTP surface
# --------------------------------------------------------------------------


class TestRedlineApi:
    async def test_post_creates_and_returns_redline(
        self,
        client: httpx.AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(
            monkeypatch,
            {
                "redline_text": "Neither party may assign without consent.",
                "rationale": "Adds the consent language.",
                "confidence": 0.77,
            },
        )
        response = await client.post(
            _redline_url(ws.contract.id, ws.finding.id),
            headers=_headers(ws.user),
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["finding_id"] == str(ws.finding.id)
        assert body["contract_id"] == str(ws.contract.id)
        assert body["status"] == "proposed"
        assert body["confidence"] == 0.77
        assert "consent" in body["redline_text"]
        assert body["model_name"]
        assert body["prompt_version"]

    async def test_post_for_pass_finding_returns_422(
        self,
        client: httpx.AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        ws = await _seed_workspace(db_session, finding_status_field="pass")
        response = await client.post(
            _redline_url(ws.contract.id, ws.finding.id),
            headers=_headers(ws.user),
        )
        assert response.status_code == 422
        assert "failed findings" in response.json()["detail"]

    async def test_post_for_finding_without_evidence_returns_422(
        self,
        client: httpx.AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        ws = await _seed_workspace(db_session, has_evidence=False)
        response = await client.post(
            _redline_url(ws.contract.id, ws.finding.id),
            headers=_headers(ws.user),
        )
        assert response.status_code == 422
        assert "evidence" in response.json()["detail"].lower()

    async def test_post_with_malformed_llm_response_returns_502(
        self,
        client: httpx.AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(monkeypatch, "not json at all")
        response = await client.post(
            _redline_url(ws.contract.id, ws.finding.id),
            headers=_headers(ws.user),
        )
        assert response.status_code == 502

    async def test_post_cross_org_returns_404(
        self,
        client: httpx.AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws_a = await _seed_workspace(db_session, email="a@example.com")
        ws_b = await _seed_workspace(db_session, email="b@example.com")
        _patch_litellm(
            monkeypatch,
            {"redline_text": "x.", "rationale": "y.", "confidence": 0.5},
        )
        # User A trying to redline B's finding.
        response = await client.post(
            _redline_url(ws_b.contract.id, ws_b.finding.id),
            headers=_headers(ws_a.user),
        )
        assert response.status_code == 404

    async def test_get_lists_history_newest_first(
        self,
        client: httpx.AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(
            monkeypatch,
            {"redline_text": "v1.", "rationale": "r1.", "confidence": 0.5},
        )
        first = await client.post(
            _redline_url(ws.contract.id, ws.finding.id),
            headers=_headers(ws.user),
        )
        assert first.status_code == 201
        _patch_litellm(
            monkeypatch,
            {"redline_text": "v2.", "rationale": "r2.", "confidence": 0.6},
        )
        second = await client.post(
            _redline_url(ws.contract.id, ws.finding.id),
            headers=_headers(ws.user),
        )
        assert second.status_code == 201

        listing = await client.get(
            _redlines_url(ws.contract.id, ws.finding.id),
            headers=_headers(ws.user),
        )
        assert listing.status_code == 200
        rows = listing.json()
        assert len(rows) == 2
        # Newest first.
        assert rows[0]["id"] == second.json()["id"]
        assert rows[1]["id"] == first.json()["id"]

    async def test_patch_updates_status(
        self,
        client: httpx.AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(
            monkeypatch,
            {"redline_text": "x.", "rationale": "r.", "confidence": 0.5},
        )
        created = (
            await client.post(
                _redline_url(ws.contract.id, ws.finding.id),
                headers=_headers(ws.user),
            )
        ).json()
        rid = uuid.UUID(created["id"])
        updated = await client.patch(
            _redline_item_url(ws.contract.id, ws.finding.id, rid),
            headers=_headers(ws.user),
            json={"status": "accepted"},
        )
        assert updated.status_code == 200
        assert updated.json()["status"] == "accepted"
        # Generation-time fields are unchanged.
        assert updated.json()["redline_text"] == created["redline_text"]
        assert updated.json()["confidence"] == created["confidence"]

    async def test_patch_invalid_status_returns_422(
        self,
        client: httpx.AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(
            monkeypatch,
            {"redline_text": "x.", "rationale": "r.", "confidence": 0.5},
        )
        created = (
            await client.post(
                _redline_url(ws.contract.id, ws.finding.id),
                headers=_headers(ws.user),
            )
        ).json()
        rid = uuid.UUID(created["id"])
        # Pydantic rejects values outside the literal at the boundary.
        response = await client.patch(
            _redline_item_url(ws.contract.id, ws.finding.id, rid),
            headers=_headers(ws.user),
            json={"status": "superseded"},
        )
        assert response.status_code == 422

    async def test_patch_cross_org_returns_404(
        self,
        client: httpx.AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws_a = await _seed_workspace(db_session, email="a@example.com")
        ws_b = await _seed_workspace(db_session, email="b@example.com")
        _patch_litellm(
            monkeypatch,
            {"redline_text": "x.", "rationale": "r.", "confidence": 0.5},
        )
        created = (
            await client.post(
                _redline_url(ws_b.contract.id, ws_b.finding.id),
                headers=_headers(ws_b.user),
            )
        ).json()
        rid = uuid.UUID(created["id"])
        response = await client.patch(
            _redline_item_url(ws_b.contract.id, ws_b.finding.id, rid),
            headers=_headers(ws_a.user),
            json={"status": "accepted"},
        )
        assert response.status_code == 404

    async def test_response_excludes_storage_and_encryption_fields(
        self,
        client: httpx.AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        ws = await _seed_workspace(db_session)
        _patch_litellm(
            monkeypatch,
            {"redline_text": "x.", "rationale": "r.", "confidence": 0.5},
        )
        response = await client.post(
            _redline_url(ws.contract.id, ws.finding.id),
            headers=_headers(ws.user),
        )
        body = response.text
        for forbidden in (
            "wrapped_dek",
            "wrapped_master_key",
            "s3_key",
            "presigned_url",
        ):
            assert forbidden not in body, (
                f"response leaked forbidden key {forbidden!r}: {body[:200]}"
            )
