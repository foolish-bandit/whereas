"""PR #76 — duplicate-merge bookkeeping on contracts.

Adds three nullable columns to ``contracts`` so a duplicate Repository
record can be merged into a canonical one without deleting data:

* ``merged_into_contract_id`` — FK to ``contracts.id``. Set on the
  source record when it has been merged. The target record's own
  column stays NULL — it is the canonical record.
* ``merged_at`` — when the merge happened.
* ``merged_by_user_id`` — who performed the merge. Nullable FK to
  ``users.id``; nullable because future automated paths (none today)
  may need to record a merge with no user.

A partial index on ``merged_into_contract_id`` lets the default list
filter merged rows out cheaply.

The column is nullable on purpose: every existing contract is by
definition not-yet-merged.

Revision ID: 0016_contract_duplicate_merge
Revises: 0015_approval_policies
Create Date: 2026-05-11
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0016_contract_duplicate_merge"
down_revision = "0015_approval_policies"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "contracts",
        sa.Column(
            "merged_into_contract_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.add_column(
        "contracts",
        sa.Column(
            "merged_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "contracts",
        sa.Column(
            "merged_by_user_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "fk_contracts_merged_into_contract_id",
        "contracts",
        "contracts",
        ["merged_into_contract_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_contracts_merged_by_user_id",
        "contracts",
        "users",
        ["merged_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_contracts_merged_into_contract_id",
        "contracts",
        ["merged_into_contract_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_contracts_merged_into_contract_id", table_name="contracts")
    op.drop_constraint(
        "fk_contracts_merged_by_user_id", "contracts", type_="foreignkey"
    )
    op.drop_constraint(
        "fk_contracts_merged_into_contract_id", "contracts", type_="foreignkey"
    )
    op.drop_column("contracts", "merged_by_user_id")
    op.drop_column("contracts", "merged_at")
    op.drop_column("contracts", "merged_into_contract_id")
