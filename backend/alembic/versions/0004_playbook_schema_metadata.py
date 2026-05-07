"""Add playbook schema metadata columns and composite indexes.

The genesis migration created the playbooks table with the bare
minimum: id, organization_id, name, description, yaml_source,
parsed_rules, is_active, and timestamps. This migration extends the
table with metadata fields the v1 YAML schema captures
(`jurisdiction`, `contract_type`, `version`) and adds composite
indexes for the lookup paths the playbooks API exercises.

The `version` column is non-NULL with a default of "1.0". Existing
rows (none expected on main; defensive backfill below) get "1.0".

Indexes added:
  ix_playbooks_org_name       — org-scoped lookup by name (and "is this
                                name already taken in the org?" checks).
  ix_playbooks_org_active     — list "active playbooks for this org",
                                which is the common UI fetch.

The single-column `ix_playbooks_organization_id` already exists from
0001 and is left in place. It is retained because individual joins
against organization_id without name or is_active filters still
benefit from it; the composite indexes are not a strict superset for
inequality filters.

Revision ID: 0004_playbook_schema_metadata
Revises: 0003_clause_segmentation
Create Date: 2026-05-07
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004_playbook_schema_metadata"
down_revision: str | Sequence[str] | None = "0003_clause_segmentation"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add metadata columns and composite indexes to playbooks."""
    # ------------------------------------------------------------------
    # 1. Add jurisdiction / contract_type / version. `version` is added
    #    nullable first so any pre-existing rows can be backfilled before
    #    the NOT NULL constraint is tightened.
    # ------------------------------------------------------------------
    op.add_column(
        "playbooks",
        sa.Column("jurisdiction", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "playbooks",
        sa.Column("contract_type", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "playbooks",
        sa.Column(
            "version",
            sa.String(length=32),
            nullable=True,
            server_default="1.0",
        ),
    )

    # Defensive backfill: no rows expected on main, but a developer
    # branch might have inserted some.
    op.execute("UPDATE playbooks SET version = '1.0' WHERE version IS NULL")

    op.alter_column("playbooks", "version", nullable=False)

    # ------------------------------------------------------------------
    # 2. Composite indexes for the org-scoped query paths.
    # ------------------------------------------------------------------
    op.create_index(
        "ix_playbooks_org_name",
        "playbooks",
        ["organization_id", "name"],
        unique=False,
    )
    op.create_index(
        "ix_playbooks_org_active",
        "playbooks",
        ["organization_id", "is_active"],
        unique=False,
    )


def downgrade() -> None:
    """Reverse the playbook metadata extension."""
    op.drop_index("ix_playbooks_org_active", table_name="playbooks")
    op.drop_index("ix_playbooks_org_name", table_name="playbooks")
    op.drop_column("playbooks", "version")
    op.drop_column("playbooks", "contract_type")
    op.drop_column("playbooks", "jurisdiction")
