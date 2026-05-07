"""Service-layer tests for the persisted-findings module.

Covers `run_and_persist_review` and `update_finding_status` against an
in-memory schema, with the matcher dataclass shape stubbed only where
that's cleaner than constructing real Clause rows. Most tests use
hand-built `Clause` rows so the span-fidelity invariant is verified
end-to-end (matcher → service → DB → readback).
"""
from __future__ import annotations

import inspect
import secrets
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.database import Base
from app.models import (
    Clause,
    Contract,
    DeviationFinding,
    FindingStatus,
    Organization,
    Playbook,
    PlaybookReviewRun,
    User,
)
from app.security.audit_log import AuditEvent
from app.security.encryption import create_org_master_key
from app.services import deviation_findings as svc
from app.services.deviation_findings import (
    InvalidFindingStatusError,
    run_and_persist_review,
    update_finding_status,
)
from app.services.playbook_loader import parse_playbook, serialize_playbook

_INSTANCE_KEY = secrets.token_bytes(32)


PLAYBOOK_YAML = """
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


SAMPLE_TEXT = (
    "1. Confidentiality. Each party shall hold confidential information.\n\n"
    "2. Governing Law. This Agreement is governed by Delaware law.\n\n"
    "3. Assignment. Neither party may assign without the prior written consent of the other.\n"
)


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
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

    @event.listens_for(eng.sync_engine, "connect")
    def _enable_sqlite_foreign_keys(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all, tables=tables)
        await conn.run_sync(Base.metadata.create_all, tables=tables)
    try:
        yield eng
    finally:
        async with eng.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all, tables=tables)
        await eng.dispose()


@pytest.fixture
async def session(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    maker = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    async with maker() as s:
        yield s
        await s.commit()


def _wrapped_org_key(org_id: uuid.UUID) -> bytes:
    return create_org_master_key(
        organization_id=str(org_id),
        instance_key=_INSTANCE_KEY,
    ).to_bytes()


async def _seed(
    session: AsyncSession, *, contract_text: str | None = SAMPLE_TEXT
) -> tuple[Organization, User, Contract, Playbook, list[Clause]]:
    org = Organization(
        id=uuid.uuid4(),
        name=f"Org {uuid.uuid4()}",
        wrapped_master_key=_wrapped_org_key(uuid.uuid4()),
    )
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Test",
        is_active=True,
    )
    session.add_all([org, user])
    await session.flush()

    parsed = parse_playbook(PLAYBOOK_YAML)
    playbook = Playbook(
        id=uuid.uuid4(),
        organization_id=org.id,
        name=parsed.name,
        description=parsed.description,
        jurisdiction=parsed.jurisdiction,
        contract_type=parsed.contract_type,
        version=parsed.version,
        yaml_source=PLAYBOOK_YAML,
        parsed_rules=serialize_playbook(parsed),
        is_active=True,
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
        seeds = [
            ("confidentiality", "1. Confidentiality. Each party shall hold confidential information."),
            ("governing_law", "2. Governing Law. This Agreement is governed by Delaware law."),
            (
                "assignment",
                "3. Assignment. Neither party may assign without the prior written consent of the other.",
            ),
        ]
        for ordinal, (clause_type, body) in enumerate(seeds):
            start = contract_text.index(body)
            clauses.append(
                Clause(
                    id=uuid.uuid4(),
                    organization_id=org.id,
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
        session.add_all(clauses)
        await session.flush()

    return org, user, contract, playbook, clauses


# --------------------------------------------------------------------------
# run_and_persist_review
# --------------------------------------------------------------------------


class TestRunAndPersistReview:
    async def test_creates_run_with_correct_counts(self, session: AsyncSession) -> None:
        org, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        run, findings, review = await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        assert run.organization_id == org.id
        assert run.contract_id == contract.id
        assert run.playbook_id == playbook.id
        # confidentiality pass, governing_law fail, assignment pass.
        assert run.rules_checked == 3
        assert run.passed_count == 2
        assert run.failed_count == 1
        # Only failures persisted.
        assert len(findings) == 1
        assert findings[0].rule_id == "governing-law-california"
        assert review.failed_count == run.failed_count
        # Verify the row landed in the DB.
        rows = (
            await session.execute(
                select(DeviationFinding).where(
                    DeviationFinding.review_run_id == run.id
                )
            )
        ).scalars().all()
        assert len(rows) == 1

    async def test_persists_only_failed_findings(self, session: AsyncSession) -> None:
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        rows = (await session.execute(select(DeviationFinding))).scalars().all()
        assert all(r.status == "fail" for r in rows)
        assert {r.rule_id for r in rows} == {"governing-law-california"}

    async def test_evidence_spans_copied_verbatim_from_clause(
        self, session: AsyncSession
    ) -> None:
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        _, findings, _ = await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        finding = findings[0]
        gov_clause = next(c for c in clauses if c.clause_type == "governing_law")
        assert finding.span_start == gov_clause.span_start
        assert finding.span_end == gov_clause.span_end
        assert finding.clause_id == gov_clause.id
        # `evidence_text` is the matcher's truncated excerpt; for this
        # short clause it equals the clause body.
        assert finding.evidence_text == gov_clause.text

    async def test_finding_default_status_is_open(self, session: AsyncSession) -> None:
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        _, findings, _ = await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        assert findings[0].finding_status == FindingStatus.OPEN.value

    async def test_does_not_mutate_contract_clauses_or_playbook(
        self, session: AsyncSession
    ) -> None:
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)

        contract_before = (contract.title, contract.status, contract.full_text)
        playbook_before = (playbook.yaml_source, playbook.is_active)
        clauses_before = [(c.text, c.span_start, c.span_end) for c in clauses]

        await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        await session.refresh(contract)
        await session.refresh(playbook)
        for c in clauses:
            await session.refresh(c)

        assert (contract.title, contract.status, contract.full_text) == contract_before
        assert (playbook.yaml_source, playbook.is_active) == playbook_before
        assert [(c.text, c.span_start, c.span_end) for c in clauses] == clauses_before


class TestRerunSupersedes:
    async def test_rerun_marks_prior_open_as_superseded(
        self, session: AsyncSession
    ) -> None:
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        # Second run.
        await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        rows = (
            await session.execute(
                select(DeviationFinding).order_by(DeviationFinding.created_at.asc())
            )
        ).scalars().all()
        # 2 runs * 1 fail each = 2 rows. The earlier should be superseded;
        # the later should be open.
        assert len(rows) == 2
        statuses = [r.finding_status for r in rows]
        assert statuses == [
            FindingStatus.SUPERSEDED.value,
            FindingStatus.OPEN.value,
        ]

    async def test_rerun_leaves_reviewed_and_ignored_alone(
        self, session: AsyncSession
    ) -> None:
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        _, findings, _ = await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        # Mark the only finding as reviewed.
        await update_finding_status(
            session, finding=findings[0], new_status=FindingStatus.REVIEWED.value
        )
        # Rerun.
        await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        rows = (
            await session.execute(
                select(DeviationFinding).order_by(DeviationFinding.created_at.asc())
            )
        ).scalars().all()
        assert len(rows) == 2
        statuses = [r.finding_status for r in rows]
        # Reviewed stays reviewed; the new run lands as open.
        assert statuses == [
            FindingStatus.REVIEWED.value,
            FindingStatus.OPEN.value,
        ]

    async def test_rerun_does_not_supersede_other_playbooks(
        self, session: AsyncSession
    ) -> None:
        org, _, contract, playbook, clauses = await _seed(session)
        # Second playbook in the same org.
        other_yaml = PLAYBOOK_YAML.replace(
            "Mutual NDA Review Playbook", "Other Playbook"
        )
        other_parsed = parse_playbook(other_yaml)
        other = Playbook(
            id=uuid.uuid4(),
            organization_id=org.id,
            name=other_parsed.name,
            description=other_parsed.description,
            jurisdiction=other_parsed.jurisdiction,
            contract_type=other_parsed.contract_type,
            version=other_parsed.version,
            yaml_source=other_yaml,
            parsed_rules=serialize_playbook(other_parsed),
            is_active=True,
        )
        session.add(other)
        await session.flush()
        parsed = parse_playbook(playbook.yaml_source)

        # First run for the original playbook.
        await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        # Run for the *other* playbook — must not supersede the first run's
        # findings.
        await run_and_persist_review(
            session, contract=contract, playbook=other, parsed_playbook=other_parsed, clauses=clauses
        )
        rows = (
            await session.execute(
                select(DeviationFinding).where(
                    DeviationFinding.playbook_id == playbook.id
                )
            )
        ).scalars().all()
        assert all(r.finding_status == FindingStatus.OPEN.value for r in rows)


# --------------------------------------------------------------------------
# update_finding_status
# --------------------------------------------------------------------------


class TestUpdateFindingStatus:
    async def test_open_to_reviewed_to_ignored_to_open(
        self, session: AsyncSession
    ) -> None:
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        _, findings, _ = await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        f = findings[0]
        for status in (
            FindingStatus.REVIEWED.value,
            FindingStatus.IGNORED.value,
            FindingStatus.OPEN.value,
        ):
            await update_finding_status(session, finding=f, new_status=status)
            assert f.finding_status == status

    async def test_rejects_invalid_status(self, session: AsyncSession) -> None:
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        _, findings, _ = await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        with pytest.raises(InvalidFindingStatusError):
            await update_finding_status(
                session, finding=findings[0], new_status="not-a-real-status"
            )

    async def test_rejects_superseded_from_caller(
        self, session: AsyncSession
    ) -> None:
        # `superseded` is owned by the rerun sweep — reviewers may not set it.
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        _, findings, _ = await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        with pytest.raises(InvalidFindingStatusError):
            await update_finding_status(
                session,
                finding=findings[0],
                new_status=FindingStatus.SUPERSEDED.value,
            )

    async def test_does_not_mutate_deterministic_fields(
        self, session: AsyncSession
    ) -> None:
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        _, findings, _ = await run_and_persist_review(
            session, contract=contract, playbook=playbook, parsed_playbook=parsed, clauses=clauses
        )
        f = findings[0]
        snapshot = (
            f.status,
            f.message,
            f.span_start,
            f.span_end,
            f.evidence_text,
            f.rule_id,
            f.rule_title,
            f.rule_type,
            f.clause_type,
            f.severity,
        )
        await update_finding_status(
            session, finding=f, new_status=FindingStatus.REVIEWED.value
        )
        assert (
            f.status,
            f.message,
            f.span_start,
            f.span_end,
            f.evidence_text,
            f.rule_id,
            f.rule_title,
            f.rule_type,
            f.clause_type,
            f.severity,
        ) == snapshot


# --------------------------------------------------------------------------
# Firm-authored playbook guidance fields
#
# These fields are sourced verbatim from the YAML rule data; the
# persistence path copies them off the matcher result without
# transformation. The Review tab surfaces them so a failed finding
# tells the reviewer not just *that* a clause failed but also the
# firm's preferred fallback language.
# --------------------------------------------------------------------------


GUIDANCE_PLAYBOOK_YAML = """
name: "Firm Playbook"
description: "Carries guidance/preferred_language across rule types."
version: "1.0"
contract_type: "mutual_nda"

rules:
  - id: "governing-law-california"
    title: "Governing law should be California"
    clause_type: "governing_law"
    severity: "medium"
    rule_type: "preferred_value"
    expected_value: "California"
    guidance: "We require California governing law for this contract type."
    preferred_language: |
      This Agreement shall be governed by the laws of the State of California,
      without regard to conflict of laws principles.
  - id: "assignment-consent"
    title: "Assignment requires consent"
    clause_type: "assignment"
    severity: "medium"
    rule_type: "text_contains"
    required_terms:
      - "consent"
      - "prior written"
    guidance: "Assignment without prior written consent is unacceptable."
    preferred_language: "Neither Party may assign this Agreement without prior written consent of the other Party."
"""


# Contract text that fails both rules: governing law is Delaware and
# the assignment clause mentions only "consent" without "prior written".
GUIDANCE_CONTRACT_TEXT = (
    "1. Governing Law. This Agreement is governed by Delaware law.\n\n"
    "2. Assignment. Either Party may assign on consent of the counterparty.\n"
)


async def _seed_guidance_workspace(
    session: AsyncSession,
) -> tuple[Contract, Playbook, list[Clause]]:
    org = Organization(
        id=uuid.uuid4(),
        name=f"Org {uuid.uuid4()}",
        wrapped_master_key=_wrapped_org_key(uuid.uuid4()),
    )
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=f"{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Test",
        is_active=True,
    )
    session.add_all([org, user])
    await session.flush()

    parsed = parse_playbook(GUIDANCE_PLAYBOOK_YAML)
    playbook = Playbook(
        id=uuid.uuid4(),
        organization_id=org.id,
        name=parsed.name,
        description=parsed.description,
        jurisdiction=parsed.jurisdiction,
        contract_type=parsed.contract_type,
        version=parsed.version,
        yaml_source=GUIDANCE_PLAYBOOK_YAML,
        parsed_rules=serialize_playbook(parsed),
        is_active=True,
    )
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=org.id,
        uploaded_by=user.id,
        title="Sample contract",
        status="ready",
        s3_key="contracts/sample.pdf",
        mime_type="application/pdf",
        file_hash_sha256="b" * 64,
        full_text=GUIDANCE_CONTRACT_TEXT,
    )
    session.add_all([playbook, contract])
    await session.flush()

    seeds = [
        ("governing_law", "1. Governing Law. This Agreement is governed by Delaware law."),
        (
            "assignment",
            "2. Assignment. Either Party may assign on consent of the counterparty.",
        ),
    ]
    clauses: list[Clause] = []
    for ordinal, (clause_type, body) in enumerate(seeds):
        start = GUIDANCE_CONTRACT_TEXT.index(body)
        clauses.append(
            Clause(
                id=uuid.uuid4(),
                organization_id=org.id,
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
    session.add_all(clauses)
    await session.flush()
    return contract, playbook, clauses


class TestPlaybookGuidanceFields:
    async def test_guidance_and_preferred_language_round_trip_to_db(
        self, session: AsyncSession
    ) -> None:
        contract, playbook, clauses = await _seed_guidance_workspace(session)
        parsed = parse_playbook(playbook.yaml_source)
        run, findings, _ = await run_and_persist_review(
            session,
            contract=contract,
            playbook=playbook,
            parsed_playbook=parsed,
            clauses=clauses,
        )
        # Re-read from the DB so we exercise the column round-trip, not
        # just the in-memory return value.
        rows = (
            await session.execute(
                select(DeviationFinding)
                .where(DeviationFinding.review_run_id == run.id)
                .order_by(DeviationFinding.rule_id.asc())
            )
        ).scalars().all()
        by_rule = {row.rule_id: row for row in rows}
        # Both rules should fail given the seeded contract text.
        assert {row.rule_id for row in rows} == {
            "governing-law-california",
            "assignment-consent",
        }
        assert len(findings) == len(rows)

        gov = by_rule["governing-law-california"]
        assert gov.guidance == (
            "We require California governing law for this contract type."
        )
        assert gov.preferred_language is not None
        assert "State of California" in gov.preferred_language
        assert gov.expected_value == "California"

        assign = by_rule["assignment-consent"]
        assert assign.guidance == (
            "Assignment without prior written consent is unacceptable."
        )
        assert assign.preferred_language == (
            "Neither Party may assign this Agreement without "
            "prior written consent of the other Party."
        )
        # `text_contains` records the partial match the contract had.
        assert assign.matched_terms == ["consent"]

    async def test_rule_without_guidance_persists_null_fields(
        self, session: AsyncSession
    ) -> None:
        # Sanity check the inverse: the original PLAYBOOK_YAML has no
        # `preferred_language` or `guidance` on its rules, so persisted
        # findings must read NULL on those columns rather than empty
        # strings or fabricated text.
        _, _, contract, playbook, clauses = await _seed(session)
        parsed = parse_playbook(playbook.yaml_source)
        _, findings, _ = await run_and_persist_review(
            session,
            contract=contract,
            playbook=playbook,
            parsed_playbook=parsed,
            clauses=clauses,
        )
        assert len(findings) == 1
        f = findings[0]
        assert f.guidance is None
        assert f.preferred_language is None


# --------------------------------------------------------------------------
# Source-level sentinel: the persistence module must not import any LLM SDK.
# --------------------------------------------------------------------------


def test_module_does_not_import_llm_clients() -> None:
    src = inspect.getsource(svc)
    forbidden = ("litellm", "openai.", "anthropic.", "ollama")
    for token in forbidden:
        assert token not in src, (
            f"app.services.deviation_findings references {token!r}; the "
            "persistence path must remain LLM-free."
        )
