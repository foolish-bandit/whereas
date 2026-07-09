"""Hybrid clause retrieval for Q&A (see `app.api.qa`).

Three independent ranking legs, fused with Reciprocal Rank Fusion (RRF):

1. Full-text search: Postgres `to_tsvector('english', text) @@
   plainto_tsquery(...)`, ranked by `ts_rank_cd`. Backed by the GIN
   expression index from migration `0018_search_indexes`.
2. Trigram similarity: Postgres `pg_trgm`'s `similarity(text, query)`,
   ranked descending. Typo/paraphrase-tolerant where full-text's
   stemmed-token matching misses.
3. Vector similarity: pgvector cosine distance between `Clause.embedding`
   and a caller-supplied query embedding, when one is provided and the
   column is populated. Skipped entirely otherwise (see
   `app.services.embeddings.populate_clause_embeddings` — embeddings are
   best-effort at ingest time, so this leg may simply have nothing to
   rank against for some or all clauses).

Every leg over-fetches (`_OVERFETCH`) beyond the caller's `limit` so RRF
has enough candidates to fuse across legs before truncating.

**Permission scoping happens in the `WHERE` clause of every leg, not as
a post-filter.** `organization_id` (and, when scoping to one contract,
`contract_id`) are applied before any ranking or fusion runs, so a
cross-tenant row is never fetched in the first place — it can't leak
through a fusion bug or a truncated result set.

On sqlite (unit tests; no `pg_trgm`, `tsvector`, or pgvector operators
available) this falls back to a plain case-insensitive substring scan
over clause text, still org- and contract-scoped in the `WHERE` clause,
so `app.api.qa` is exercisable without Postgres.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, TypeVar

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Clause, Contract

_OVERFETCH = 20
_RRF_K = 60

_T = TypeVar("_T")


@dataclass(frozen=True)
class ClauseSearchResult:
    """One clause candidate returned by `search_clauses`.

    `score` is the fused relevance score (higher is better) produced by
    RRF across whichever legs actually ran — it is not comparable across
    calls or to any single leg's raw ranking metric.
    """

    clause_id: uuid.UUID
    contract_id: uuid.UUID
    contract_title: str
    heading: str | None
    text: str
    span_start: int
    span_end: int
    score: float


def rrf_fuse(rankings: list[list[_T]], k: int = 60) -> list[_T]:
    """Fuse multiple rankings into one via Reciprocal Rank Fusion.

    Each element of `rankings` is an ordered list of ids (best first,
    rank 1). An id's fused score is the sum, over every ranking it
    appears in, of `1 / (k + rank)`. The returned list is every distinct
    id across all rankings, ordered by fused score descending.

    Ties are broken by first-appearance order across `rankings` (in the
    order the rankings themselves are given, then by position within
    each ranking) so the result is deterministic given deterministic
    inputs — important for tests and for not shuffling equally-ranked
    clauses between requests.
    """
    return list(_rrf_scores(rankings, k=k).keys())


def _rrf_scores(rankings: list[list[_T]], *, k: int) -> dict[_T, float]:
    scores: dict[_T, float] = {}
    first_seen: dict[_T, int] = {}
    position = 0
    for ranking in rankings:
        for rank, item in enumerate(ranking, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank)
            if item not in first_seen:
                first_seen[item] = position
                position += 1
    ordered_ids = sorted(scores, key=lambda item: (-scores[item], first_seen[item]))
    return {item: scores[item] for item in ordered_ids}


async def search_clauses(
    session: AsyncSession,
    organization_id: uuid.UUID,
    query: str,
    *,
    limit: int = 10,
    embedding: list[float] | None = None,
    contract_id: uuid.UUID | None = None,
) -> list[ClauseSearchResult]:
    """Search an organization's clauses, fusing full-text/trigram/vector legs.

    `organization_id` is mandatory and always applied in every leg's
    `WHERE` clause. `contract_id`, if given, additionally restricts
    every leg to that one contract (used when a Q&A question is scoped
    to a single document). `embedding`, if given, enables the vector
    leg; without it, only full-text and trigram run (Postgres) or the
    substring fallback runs (sqlite).
    """
    query = query.strip()
    if not query or limit <= 0:
        return []

    dialect_name = session.get_bind().dialect.name
    if dialect_name != "postgresql":
        return await _search_clauses_sqlite(
            session, organization_id, query, limit=limit, contract_id=contract_id
        )
    return await _search_clauses_postgres(
        session,
        organization_id,
        query,
        limit=limit,
        embedding=embedding,
        contract_id=contract_id,
    )


def _base_query(organization_id: uuid.UUID, contract_id: uuid.UUID | None) -> Select[Any]:
    stmt = (
        select(
            Clause.id,
            Clause.contract_id,
            Contract.title,
            Clause.heading,
            Clause.text,
            Clause.span_start,
            Clause.span_end,
        )
        .join(Contract, Contract.id == Clause.contract_id)
        .where(Clause.organization_id == organization_id)
    )
    if contract_id is not None:
        stmt = stmt.where(Clause.contract_id == contract_id)
    return stmt


async def _search_clauses_postgres(
    session: AsyncSession,
    organization_id: uuid.UUID,
    query: str,
    *,
    limit: int,
    embedding: list[float] | None,
    contract_id: uuid.UUID | None,
) -> list[ClauseSearchResult]:
    rows_by_id: dict[uuid.UUID, Any] = {}
    rankings: list[list[uuid.UUID]] = []

    # Every leg breaks ties on (contract_id, ordinal) — deterministic and
    # meaningful (earlier clauses in a document win ties) rather than
    # left to whatever order Postgres happens to return equally-ranked
    # rows in.
    tiebreak = (Clause.contract_id, Clause.ordinal)

    # Leg 1: full-text search.
    tsvector = func.to_tsvector("english", Clause.text)
    tsquery = func.plainto_tsquery("english", query)
    rank = func.ts_rank_cd(tsvector, tsquery)
    fts_stmt = (
        _base_query(organization_id, contract_id)
        .where(tsvector.op("@@")(tsquery))
        .order_by(rank.desc(), *tiebreak)
        .limit(_OVERFETCH)
    )
    fts_rows = (await session.execute(fts_stmt)).all()
    rankings.append(_collect(fts_rows, rows_by_id))

    # Leg 2: trigram similarity. Guarded by `pg_trgm`'s `similarity()`
    # function (enabled by migration 0018); no WHERE threshold so short
    # queries against longer clause text still return candidates —
    # ranking, not filtering, is what RRF needs from this leg.
    similarity = func.similarity(Clause.text, query)
    trgm_stmt = (
        _base_query(organization_id, contract_id)
        .order_by(similarity.desc(), *tiebreak)
        .limit(_OVERFETCH)
    )
    trgm_rows = (await session.execute(trgm_stmt)).all()
    rankings.append(_collect(trgm_rows, rows_by_id))

    # Leg 3: vector similarity, only if the caller has a query embedding.
    if embedding is not None:
        distance = Clause.embedding.cosine_distance(embedding)
        vector_stmt = (
            _base_query(organization_id, contract_id)
            .where(Clause.embedding.is_not(None))
            .order_by(distance.asc(), *tiebreak)
            .limit(_OVERFETCH)
        )
        vector_rows = (await session.execute(vector_stmt)).all()
        rankings.append(_collect(vector_rows, rows_by_id))

    scores = _rrf_scores(rankings, k=_RRF_K)
    return [
        _to_result(rows_by_id[clause_id], score)
        for clause_id, score in list(scores.items())[:limit]
    ]


def _collect(rows: list[Any], rows_by_id: dict[uuid.UUID, Any]) -> list[uuid.UUID]:
    ordered_ids: list[uuid.UUID] = []
    for row in rows:
        rows_by_id[row.id] = row
        ordered_ids.append(row.id)
    return ordered_ids


def _to_result(row: Any, score: float) -> ClauseSearchResult:
    return ClauseSearchResult(
        clause_id=row.id,
        contract_id=row.contract_id,
        contract_title=row.title,
        heading=row.heading,
        text=row.text,
        span_start=row.span_start,
        span_end=row.span_end,
        score=score,
    )


async def _search_clauses_sqlite(
    session: AsyncSession,
    organization_id: uuid.UUID,
    query: str,
    *,
    limit: int,
    contract_id: uuid.UUID | None,
) -> list[ClauseSearchResult]:
    """ILIKE-substring fallback so `app.api.qa` is exercisable without Postgres.

    `.ilike()` compiles to `lower(x) LIKE lower(?)` on dialects without a
    native `ILIKE` operator (sqlite included), so this stays
    case-insensitive without any Postgres-specific SQL.
    """
    stmt = (
        _base_query(organization_id, contract_id)
        .where(Clause.text.ilike(f"%{query}%"))
        .order_by(Clause.contract_id, Clause.ordinal)
        .limit(limit)
    )
    rows = (await session.execute(stmt)).all()
    # No real ranking signal available; every match gets an equal score
    # scaled by position so downstream consumers still get a monotonic
    # "best first" ordering to sort or threshold on.
    total = len(rows)
    return [
        _to_result(row, score=(total - position) / total if total else 0.0)
        for position, row in enumerate(rows)
    ]
