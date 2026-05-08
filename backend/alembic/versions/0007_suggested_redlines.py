"""add suggested redlines

Adds the ``suggested_redlines`` table that stores LLM-generated
replacement-language suggestions for failed ``DeviationFinding`` rows,
and registers the table in the RLS policy set so cross-org reads are
refused at the database layer.

Why a separate table (and not columns on ``deviation_findings``)
----------------------------------------------------------------

A redline is the output of a non-deterministic LLM call. Storing it
inline on ``deviation_findings`` would conflate the deterministic
matcher's audit row (status, message, span — immutable through the
API) with a regenerable, model-versioned suggestion. Keeping them
apart means:

  * regenerating a redline doesn't churn the finding row's
    ``updated_at``;
  * the history of suggestions a reviewer saw is preserved (each
    generation creates a new row);
  * the ``model_name`` / ``prompt_version`` / ``confidence`` columns
    sit next to the text they describe, mirroring the
    ``extracted_fields`` pattern.

Span citations live on the parent ``DeviationFinding`` row; redlines
inherit that citation by FK. The redline text itself is *replacement*
language and does not get its own span — there is, by construction,
nothing in the source document for it to cite.

Revision ID: 0007_suggested_redlines
Revises: 0006_clause_templates
Create Date: 2026-05-08
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.security.rls import build_full_migration_sql

# revision identifiers, used by Alembic.
revision: str = "0007_suggested_redlines"
down_revision: str | Sequence[str] | None = "0006_clause_templates"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "suggested_redlines",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "organization_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("finding_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("redline_text", sa.Text(), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("model_name", sa.String(length=128), nullable=False),
        sa.Column("prompt_version", sa.String(length=64), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'proposed'"),
        ),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(
            ["contract_id"], ["contracts.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["finding_id"], ["deviation_findings.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_suggested_redlines_organization_id",
        "suggested_redlines",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_suggested_redlines_contract_id",
        "suggested_redlines",
        ["contract_id"],
        unique=False,
    )
    op.create_index(
        "ix_suggested_redlines_finding_id",
        "suggested_redlines",
        ["finding_id"],
        unique=False,
    )
    op.create_index(
        "ix_suggested_redlines_finding_status",
        "suggested_redlines",
        ["finding_id", "status"],
        unique=False,
    )

    # Re-apply RLS so the new table picks up its tenant-isolation
    # policy. `build_full_migration_sql` is idempotent and also reads
    # the (updated) `_DIRECT_ORG_TABLES` list in `app.security.rls`,
    # which now includes `suggested_redlines`.
    op.execute(build_full_migration_sql())


def downgrade() -> None:
    # Drop the policy explicitly before the table so a future tear-down
    # of `_DIRECT_ORG_TABLES` doesn't leave a dangling policy.
    op.execute(
        "DROP POLICY IF EXISTS suggested_redlines_tenant_isolation "
        "ON suggested_redlines"
    )
    op.execute(
        "ALTER TABLE suggested_redlines DISABLE ROW LEVEL SECURITY"
    )
    op.drop_index(
        "ix_suggested_redlines_finding_status", table_name="suggested_redlines"
    )
    op.drop_index(
        "ix_suggested_redlines_finding_id", table_name="suggested_redlines"
    )
    op.drop_index(
        "ix_suggested_redlines_contract_id", table_name="suggested_redlines"
    )
    op.drop_index(
        "ix_suggested_redlines_organization_id",
        table_name="suggested_redlines",
    )
    op.drop_table("suggested_redlines")
