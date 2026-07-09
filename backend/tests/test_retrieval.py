"""Tests for `app.services.retrieval`.

`rrf_fuse` is pure and gets exhaustive unit coverage with no DB at all.
`search_clauses` is dialect-aware: the sqlite fallback (ILIKE substring,
org/contract-scoped) runs unconditionally against an in-memory sqlite
engine; the real hybrid legs (full-text, trigram, vector) only run
against a throwaway Postgres spun up by `testcontainers` and skip
cleanly without Docker, same convention as `test_migrations.py`.
"""
from __future__ import annotations

import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.database import Base
from app.models import Clause, Contract, Organization, User
from app.services.retrieval import ClauseSearchResult, rrf_fuse, search_clauses

try:
    from testcontainers.postgres import PostgresContainer
except ImportError:  # pragma: no cover
    PostgresContainer = None  # type: ignore[assignment,misc]

_PG_IMAGE = "pgvector/pgvector:pg16"
_EMBEDDING_DIM = 1024  # matches Clause.embedding = Vector(1024) in app.models


def _vec(*leading: float) -> list[float]:
    """Build a `Clause.embedding`-shaped vector: `leading` values, zero-padded
    to the column's fixed 1024 dimensions (pgvector enforces the exact
    declared dimension on insert)."""
    return list(leading) + [0.0] * (_EMBEDDING_DIM - len(leading))


# --------------------------------------------------------------------------
# rrf_fuse — pure function, no DB
# --------------------------------------------------------------------------


class TestRrfFuse:
    def test_empty_rankings_returns_empty(self) -> None:
        assert rrf_fuse([]) == []

    def test_single_ranking_preserves_order(self) -> None:
        assert rrf_fuse([["a", "b", "c"]]) == ["a", "b", "c"]

    def test_disjoint_rankings_are_interleaved_by_score(self) -> None:
        # Both "a" and "x" are rank-1 in their own ranking, so they tie;
        # first-seen order (ranking order, then position) breaks the tie.
        result = rrf_fuse([["a", "b"], ["x", "y"]])
        assert result == ["a", "x", "b", "y"]

    def test_item_ranked_high_in_multiple_lists_wins(self) -> None:
        # "b" is rank 1 in both rankings; nothing else can out-score it.
        result = rrf_fuse([["a", "b"], ["b", "c"]])
        assert result[0] == "b"

    def test_agreement_across_legs_beats_a_single_top_rank(self) -> None:
        # "shared" is rank 2 in both rankings: 2*(1/62). "solo" is rank 1
        # in only one: 1/61. 2/62 (~0.0323) > 1/61 (~0.0164).
        result = rrf_fuse([["solo", "shared"], ["other", "shared"]])
        assert result[0] == "shared"

    def test_missing_from_a_ranking_still_included(self) -> None:
        result = rrf_fuse([["a", "b"], ["a"]])
        assert set(result) == {"a", "b"}
        assert result[0] == "a"

    def test_smaller_k_amplifies_rank_differences(self) -> None:
        # With a much smaller k, rank 1 dominates far more over rank 2;
        # verify the score gap widens (indirectly, via a scenario where a
        # low k changes the winner between two candidates).
        rankings = [["a"], ["b", "a"]]
        # k=60 (default): a: 1/61 + 1/61 = 0.0328; b: 1/60 = 0.0167 -> a wins
        default_result = rrf_fuse(rankings)
        assert default_result[0] == "a"
        # k=0: a: 1/1 + 1/2 = 1.5; b: 1/1 = 1.0 -> a still wins, but by more
        tight_result = rrf_fuse(rankings, k=0)
        assert tight_result[0] == "a"

    def test_deterministic_given_same_input(self) -> None:
        rankings = [["a", "b", "c"], ["c", "a", "d"]]
        assert rrf_fuse(rankings) == rrf_fuse(rankings)

    def test_three_way_fusion(self) -> None:
        rankings = [
            ["a", "b", "c"],
            ["b", "c", "a"],
            ["c", "b", "a"],
        ]
        result = rrf_fuse(rankings)
        # "b" and "c" each appear at ranks {1,2} across the three legs and
        # both out-score "a" (ranks {1,3,3}).
        assert set(result[:2]) == {"b", "c"}
        assert result[2] == "a"


# --------------------------------------------------------------------------
# search_clauses — sqlite fallback (always runs)
# --------------------------------------------------------------------------


@pytest.fixture
async def sqlite_engine() -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    tables = [
        Organization.__table__,
        User.__table__,
        Contract.__table__,
        Clause.__table__,
    ]

    @event.listens_for(engine.sync_engine, "connect")
    def _enable_sqlite_foreign_keys(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=tables)
    try:
        yield engine
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all, tables=tables)
        await engine.dispose()


@pytest.fixture
async def sqlite_session(sqlite_engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    maker = async_sessionmaker(sqlite_engine, expire_on_commit=False, autoflush=False)
    async with maker() as session:
        yield session


def _make_contract(org_id: uuid.UUID, user_id: uuid.UUID, title: str) -> Contract:
    return Contract(
        id=uuid.uuid4(),
        organization_id=org_id,
        uploaded_by=user_id,
        title=title,
        s3_key=f"contracts/{uuid.uuid4()}.pdf",
        mime_type="application/pdf",
        file_hash_sha256="a" * 64,
    )


def _make_clause(
    org_id: uuid.UUID,
    contract_id: uuid.UUID,
    *,
    ordinal: int,
    text: str,
    heading: str | None = None,
) -> Clause:
    return Clause(
        id=uuid.uuid4(),
        organization_id=org_id,
        contract_id=contract_id,
        ordinal=ordinal,
        heading=heading,
        text=text,
        span_start=0,
        span_end=len(text),
        segmentation_method="heuristic_v1",
    )


class TestSearchClausesSqliteFallback:
    async def test_matches_substring_case_insensitively(
        self, sqlite_session: AsyncSession
    ) -> None:
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        org = Organization(id=org_id, name="Acme Legal")
        user = User(
            id=user_id,
            organization_id=org_id,
            email="a@example.com",
            password_hash="x",
            display_name="A",
        )
        sqlite_session.add_all([org, user])
        await sqlite_session.flush()
        contract = _make_contract(org_id, user_id, "Vendor MSA")
        clause = _make_clause(
            org_id,
            contract.id,
            ordinal=0,
            text="This Agreement is GOVERNED BY the laws of Delaware.",
            heading="Governing Law",
        )
        sqlite_session.add_all([contract, clause])
        await sqlite_session.flush()

        results = await search_clauses(sqlite_session, org_id, "governed by")

        assert len(results) == 1
        result = results[0]
        assert isinstance(result, ClauseSearchResult)
        assert result.clause_id == clause.id
        assert result.contract_id == contract.id
        assert result.contract_title == "Vendor MSA"
        assert result.heading == "Governing Law"

    async def test_no_match_returns_empty(self, sqlite_session: AsyncSession) -> None:
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        sqlite_session.add(Organization(id=org_id, name="Acme Legal"))
        sqlite_session.add(
            User(
                id=user_id,
                organization_id=org_id,
                email="a@example.com",
                password_hash="x",
                display_name="A",
            )
        )
        await sqlite_session.flush()
        contract = _make_contract(org_id, user_id, "Vendor MSA")
        clause = _make_clause(org_id, contract.id, ordinal=0, text="Confidentiality terms.")
        sqlite_session.add_all([contract, clause])
        await sqlite_session.flush()

        results = await search_clauses(sqlite_session, org_id, "indemnification")

        assert results == []

    async def test_blank_query_returns_empty_without_querying(
        self, sqlite_session: AsyncSession
    ) -> None:
        results = await search_clauses(sqlite_session, uuid.uuid4(), "   ")
        assert results == []

    async def test_scoped_to_calling_organization(self, sqlite_session: AsyncSession) -> None:
        org_a = uuid.uuid4()
        org_b = uuid.uuid4()
        user_a = uuid.uuid4()
        user_b = uuid.uuid4()
        sqlite_session.add_all(
            [
                Organization(id=org_a, name="Org A"),
                Organization(id=org_b, name="Org B"),
                User(
                    id=user_a,
                    organization_id=org_a,
                    email="a@example.com",
                    password_hash="x",
                    display_name="A",
                ),
                User(
                    id=user_b,
                    organization_id=org_b,
                    email="b@example.com",
                    password_hash="x",
                    display_name="B",
                ),
            ]
        )
        await sqlite_session.flush()
        contract_a = _make_contract(org_a, user_a, "Org A Contract")
        contract_b = _make_contract(org_b, user_b, "Org B Contract")
        clause_a = _make_clause(org_a, contract_a.id, ordinal=0, text="Limitation of liability clause.")
        clause_b = _make_clause(org_b, contract_b.id, ordinal=0, text="Limitation of liability clause.")
        sqlite_session.add_all([contract_a, contract_b, clause_a, clause_b])
        await sqlite_session.flush()

        results = await search_clauses(sqlite_session, org_a, "limitation of liability")

        assert [r.clause_id for r in results] == [clause_a.id]

    async def test_scoped_to_a_single_contract_when_given(
        self, sqlite_session: AsyncSession
    ) -> None:
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        sqlite_session.add(Organization(id=org_id, name="Acme Legal"))
        sqlite_session.add(
            User(
                id=user_id,
                organization_id=org_id,
                email="a@example.com",
                password_hash="x",
                display_name="A",
            )
        )
        await sqlite_session.flush()
        contract_1 = _make_contract(org_id, user_id, "Contract One")
        contract_2 = _make_contract(org_id, user_id, "Contract Two")
        clause_1 = _make_clause(org_id, contract_1.id, ordinal=0, text="Termination for convenience.")
        clause_2 = _make_clause(org_id, contract_2.id, ordinal=0, text="Termination for convenience.")
        sqlite_session.add_all([contract_1, contract_2, clause_1, clause_2])
        await sqlite_session.flush()

        results = await search_clauses(
            sqlite_session, org_id, "termination", contract_id=contract_2.id
        )

        assert [r.clause_id for r in results] == [clause_2.id]

    async def test_limit_is_respected(self, sqlite_session: AsyncSession) -> None:
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        sqlite_session.add(Organization(id=org_id, name="Acme Legal"))
        sqlite_session.add(
            User(
                id=user_id,
                organization_id=org_id,
                email="a@example.com",
                password_hash="x",
                display_name="A",
            )
        )
        await sqlite_session.flush()
        contract = _make_contract(org_id, user_id, "Vendor MSA")
        clauses = [
            _make_clause(org_id, contract.id, ordinal=i, text=f"Clause {i} about payment terms.")
            for i in range(5)
        ]
        sqlite_session.add_all([contract, *clauses])
        await sqlite_session.flush()

        results = await search_clauses(sqlite_session, org_id, "payment terms", limit=2)

        assert len(results) == 2


# --------------------------------------------------------------------------
# search_clauses — real Postgres hybrid legs (skips without Docker)
# --------------------------------------------------------------------------


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
def postgres_container() -> Iterator[Any]:
    if not _docker_available():
        pytest.skip("Docker daemon not reachable; skipping Postgres retrieval tests")
    container = PostgresContainer(_PG_IMAGE)
    container.start()
    try:
        yield container
    finally:
        container.stop()


@pytest.fixture
async def postgres_engine(postgres_container: Any) -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(_container_async_url(postgres_container), echo=False)
    tables = [
        Organization.__table__,
        User.__table__,
        Contract.__table__,
        Clause.__table__,
    ]
    async with engine.begin() as conn:
        await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")
        await conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        await conn.run_sync(Base.metadata.drop_all, tables=tables)
        await conn.run_sync(Base.metadata.create_all, tables=tables)
    try:
        yield engine
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all, tables=tables)
        await engine.dispose()


@pytest.fixture
async def postgres_session(postgres_engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    maker = async_sessionmaker(postgres_engine, expire_on_commit=False, autoflush=False)
    async with maker() as session:
        yield session


class TestSearchClausesPostgresHybridLegs:
    async def test_full_text_leg_matches_stemmed_terms(
        self, postgres_session: AsyncSession
    ) -> None:
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        postgres_session.add(Organization(id=org_id, name="Acme Legal"))
        postgres_session.add(
            User(
                id=user_id,
                organization_id=org_id,
                email="a@example.com",
                password_hash="x",
                display_name="A",
            )
        )
        await postgres_session.flush()
        contract = _make_contract(org_id, user_id, "Vendor MSA")
        clause = _make_clause(
            org_id,
            contract.id,
            ordinal=0,
            text="The parties shall indemnify and hold harmless each other.",
            heading="Indemnification",
        )
        postgres_session.add_all([contract, clause])
        await postgres_session.flush()

        # "indemnification" (query) vs "indemnify" (clause) — full-text
        # stemming should match these as the same lexeme.
        results = await search_clauses(postgres_session, org_id, "indemnification")

        assert [r.clause_id for r in results] == [clause.id]

    async def test_trigram_leg_tolerates_minor_typos(
        self, postgres_session: AsyncSession
    ) -> None:
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        postgres_session.add(Organization(id=org_id, name="Acme Legal"))
        postgres_session.add(
            User(
                id=user_id,
                organization_id=org_id,
                email="a@example.com",
                password_hash="x",
                display_name="A",
            )
        )
        await postgres_session.flush()
        contract = _make_contract(org_id, user_id, "Vendor MSA")
        clause = _make_clause(
            org_id,
            contract.id,
            ordinal=0,
            text="Governing law is the State of Delaware.",
            heading="Governing Law",
        )
        unrelated = _make_clause(
            org_id, contract.id, ordinal=1, text="Payment terms are net thirty days."
        )
        postgres_session.add_all([contract, clause, unrelated])
        await postgres_session.flush()

        # Misspelled so `plainto_tsquery`'s stemmed-lexeme matching won't
        # find it — the full-text leg contributes nothing, so a correct
        # ranking here can only come from trigram similarity.
        results = await search_clauses(postgres_session, org_id, "governning law")

        assert results
        assert results[0].clause_id == clause.id

    async def test_vector_leg_ranks_by_cosine_distance_when_embedding_given(
        self, postgres_session: AsyncSession
    ) -> None:
        org_id = uuid.uuid4()
        user_id = uuid.uuid4()
        postgres_session.add(Organization(id=org_id, name="Acme Legal"))
        postgres_session.add(
            User(
                id=user_id,
                organization_id=org_id,
                email="a@example.com",
                password_hash="x",
                display_name="A",
            )
        )
        await postgres_session.flush()
        contract = _make_contract(org_id, user_id, "Vendor MSA")
        # Text is identical for both clauses so the full-text and trigram
        # legs cannot distinguish them (same rank/similarity for both) —
        # the only signal that can separate them is the vector leg's
        # cosine distance, isolating what this test is meant to check.
        close_clause = _make_clause(
            org_id, contract.id, ordinal=0, text="Sample clause about liability."
        )
        far_clause = _make_clause(
            org_id, contract.id, ordinal=1, text="Sample clause about liability."
        )
        close_clause.embedding = _vec(1.0, 0.0, 0.0)
        far_clause.embedding = _vec(0.0, 1.0, 0.0)
        postgres_session.add_all([contract, close_clause, far_clause])
        await postgres_session.flush()

        results = await search_clauses(
            postgres_session,
            org_id,
            "liability",
            embedding=_vec(0.9, 0.1, 0.0),
        )

        assert [r.clause_id for r in results] == [close_clause.id, far_clause.id]

    async def test_org_scoping_applies_across_all_legs(
        self, postgres_session: AsyncSession
    ) -> None:
        org_a = uuid.uuid4()
        org_b = uuid.uuid4()
        user_a = uuid.uuid4()
        user_b = uuid.uuid4()
        postgres_session.add_all(
            [
                Organization(id=org_a, name="Org A"),
                Organization(id=org_b, name="Org B"),
                User(
                    id=user_a,
                    organization_id=org_a,
                    email="a@example.com",
                    password_hash="x",
                    display_name="A",
                ),
                User(
                    id=user_b,
                    organization_id=org_b,
                    email="b@example.com",
                    password_hash="x",
                    display_name="B",
                ),
            ]
        )
        await postgres_session.flush()
        contract_a = _make_contract(org_a, user_a, "Org A Contract")
        contract_b = _make_contract(org_b, user_b, "Org B Contract")
        clause_a = _make_clause(
            org_a, contract_a.id, ordinal=0, text="Confidential information clause."
        )
        clause_b = _make_clause(
            org_b, contract_b.id, ordinal=0, text="Confidential information clause."
        )
        clause_a.embedding = _vec(1.0, 0.0)
        clause_b.embedding = _vec(1.0, 0.0)
        postgres_session.add_all([contract_a, contract_b, clause_a, clause_b])
        await postgres_session.flush()

        results = await search_clauses(
            postgres_session, org_a, "confidential information", embedding=_vec(1.0, 0.0)
        )

        assert [r.clause_id for r in results] == [clause_a.id]
