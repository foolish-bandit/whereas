"""Hybrid search indexes: pg_trgm extension, full-text and trigram GIN indexes.

Adds the index support `app.services.retrieval.search_clauses` needs for
its full-text and trigram legs:

1. `pg_trgm` — the extension backing trigram similarity (`%` operator /
   `similarity()`), used for fuzzy/typo-tolerant matching over clause and
   contract text.
2. A GIN expression index on `to_tsvector('english', clauses.text)` so
   `to_tsvector('english', text) @@ plainto_tsquery(...)` full-text
   queries don't sequential-scan `clauses`. This is an expression index,
   not a generated column: Postgres can index the *result* of an
   IMMUTABLE-for-index-purposes expression directly, so there is no
   extra column to keep in sync with `clauses.text`.
3. A GIN trigram index on `contracts.title` so title search (used by the
   existing `?q=` contract-list filter as well as future retrieval work)
   isn't a sequential scan either.

Both indexes are Postgres-only, matching the rest of the hybrid-search
design: `app.services.retrieval` falls back to a plain `ILIKE` scan on
sqlite, where neither `pg_trgm` nor `to_tsvector` exist.

Revision ID: 0018_search_indexes
Revises: 0017_integration_connections
Create Date: 2026-07-09
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0018_search_indexes"
down_revision: str | Sequence[str] | None = "0017_integration_connections"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_clauses_text_fts "
        "ON clauses USING gin (to_tsvector('english', text))"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_contracts_title_trgm "
        "ON contracts USING gin (title gin_trgm_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_contracts_title_trgm")
    op.execute("DROP INDEX IF EXISTS ix_clauses_text_fts")

    # Intentionally NOT dropped: DROP EXTENSION pg_trgm — cluster-level,
    # may be shared with other databases on the same Postgres instance
    # (same rationale as the `vector` extension in 0001's downgrade).
