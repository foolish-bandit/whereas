"""Reshape clauses table for v1 segmentation pipeline.

Adds the columns the heuristic clause segmentation service needs:
organization_id (denormalized for fast scoping/auditing without a
contracts join), ordinal (stable position within a contract), heading,
clause_type_source, segmentation_method, model_name, prompt_version,
and updated_at. Renames classification_confidence to confidence and
makes both confidence and clause_type nullable: v1's heuristic
segmenter does not honestly produce a numeric confidence, and many
clauses won't be classified at all.

The clauses table has never been populated (no service writes to it on
main), so the up-migration treats existing rows as legacy debris and
backfills with safe defaults before tightening NOT NULL constraints.

Revision ID: 0003_clause_segmentation
Revises: 0002_add_contract_wrapped_dek
Create Date: 2026-05-07
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0003_clause_segmentation"
down_revision: str | Sequence[str] | None = "0002_add_contract_wrapped_dek"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the v1 segmentation columns and reshape existing ones."""
    # ------------------------------------------------------------------
    # 1. Add new columns as nullable so existing rows (if any) can stay.
    # ------------------------------------------------------------------
    op.add_column(
        "clauses",
        sa.Column(
            "organization_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.add_column(
        "clauses",
        sa.Column("ordinal", sa.Integer(), nullable=True),
    )
    op.add_column(
        "clauses",
        sa.Column("heading", sa.String(length=500), nullable=True),
    )
    op.add_column(
        "clauses",
        sa.Column("clause_type_source", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "clauses",
        sa.Column("segmentation_method", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "clauses",
        sa.Column("model_name", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "clauses",
        sa.Column("prompt_version", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "clauses",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
    )

    # ------------------------------------------------------------------
    # 2. Backfill safe defaults for any pre-existing rows. None expected
    #    on main, but writing this defensively keeps the migration safe
    #    against forks or developer branches that may have inserted rows.
    # ------------------------------------------------------------------
    op.execute(
        """
        UPDATE clauses
           SET organization_id = c.organization_id
          FROM contracts c
         WHERE clauses.contract_id = c.id
           AND clauses.organization_id IS NULL
        """
    )
    op.execute(
        """
        UPDATE clauses
           SET ordinal = sub.row_num - 1
          FROM (
              SELECT id,
                     ROW_NUMBER() OVER (
                         PARTITION BY contract_id
                         ORDER BY span_start, id
                     ) AS row_num
                FROM clauses
          ) AS sub
         WHERE clauses.id = sub.id
           AND clauses.ordinal IS NULL
        """
    )
    op.execute(
        "UPDATE clauses SET segmentation_method = 'heuristic_v1' "
        "WHERE segmentation_method IS NULL"
    )
    op.execute(
        "UPDATE clauses SET updated_at = now() WHERE updated_at IS NULL"
    )

    # ------------------------------------------------------------------
    # 3. Tighten NOT NULL on the now-backfilled columns.
    # ------------------------------------------------------------------
    op.alter_column("clauses", "organization_id", nullable=False)
    op.alter_column("clauses", "ordinal", nullable=False)
    op.alter_column("clauses", "segmentation_method", nullable=False)
    op.alter_column("clauses", "updated_at", nullable=False)

    # ------------------------------------------------------------------
    # 4. Rename classification_confidence -> confidence and relax to NULL.
    #    clause_type also relaxes to nullable: heuristic segmentation
    #    deliberately leaves "I don't know" as null rather than guessing.
    # ------------------------------------------------------------------
    op.alter_column(
        "clauses",
        "classification_confidence",
        new_column_name="confidence",
        existing_type=sa.Float(),
        nullable=True,
    )
    op.alter_column(
        "clauses",
        "clause_type",
        existing_type=sa.String(length=128),
        type_=sa.String(length=64),
        existing_nullable=False,
        nullable=True,
    )

    # ------------------------------------------------------------------
    # 5. New constraints and indexes.
    # ------------------------------------------------------------------
    op.create_foreign_key(
        "fk_clauses_organization_id",
        "clauses",
        "organizations",
        ["organization_id"],
        ["id"],
    )
    op.create_unique_constraint(
        "uq_clauses_contract_ordinal",
        "clauses",
        ["contract_id", "ordinal"],
    )
    op.create_index(
        "ix_clauses_org_contract",
        "clauses",
        ["organization_id", "contract_id"],
        unique=False,
    )


def downgrade() -> None:
    """Reverse the v1 segmentation reshape.

    Recreates the legacy NOT NULL invariants on `clause_type` and
    `classification_confidence`. Any rows whose segmentation method is
    not the legacy default will fail the NOT NULL constraint on
    downgrade — an explicit signal that we are throwing away v1
    segmentation data, which is the intended behavior for a downgrade.
    """
    op.drop_index("ix_clauses_org_contract", table_name="clauses")
    op.drop_constraint(
        "uq_clauses_contract_ordinal", "clauses", type_="unique"
    )
    op.drop_constraint(
        "fk_clauses_organization_id", "clauses", type_="foreignkey"
    )

    # Restore the legacy column shape. Any rows with NULL clause_type or
    # NULL confidence would violate the restored NOT NULL — but a
    # downgrade is an explicit "drop the v1 data" choice, so we set
    # placeholders before the alter so the migration completes.
    op.execute("UPDATE clauses SET clause_type = 'other' WHERE clause_type IS NULL")
    op.execute("UPDATE clauses SET confidence = 0.0 WHERE confidence IS NULL")
    op.alter_column(
        "clauses",
        "clause_type",
        existing_type=sa.String(length=64),
        type_=sa.String(length=128),
        existing_nullable=True,
        nullable=False,
    )
    op.alter_column(
        "clauses",
        "confidence",
        new_column_name="classification_confidence",
        existing_type=sa.Float(),
        nullable=False,
    )

    op.drop_column("clauses", "updated_at")
    op.drop_column("clauses", "prompt_version")
    op.drop_column("clauses", "model_name")
    op.drop_column("clauses", "segmentation_method")
    op.drop_column("clauses", "clause_type_source")
    op.drop_column("clauses", "heading")
    op.drop_column("clauses", "ordinal")
    op.drop_column("clauses", "organization_id")
