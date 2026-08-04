"""Create typed, tenant-scoped links from findings to Inbox remediation tasks.

Revision ID: 0020_finding_remediation_tasks
Revises: 0019_rls_backfill_0006_0017
Create Date: 2026-08-04
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0020_finding_remediation_tasks"
down_revision: str | Sequence[str] | None = "0019_rls_backfill_0006_0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "finding_remediation_tasks"
_POLICY = "finding_remediation_tasks_tenant_isolation"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "organization_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("organizations.id"),
            nullable=False,
        ),
        sa.Column(
            "finding_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("deviation_findings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "inbox_item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("inbox_items.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column(
            "source_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "organization_id",
            "finding_id",
            name="uq_finding_remediation_tasks_org_finding",
        ),
        sa.UniqueConstraint(
            "inbox_item_id",
            name="uq_finding_remediation_tasks_inbox_item",
        ),
    )
    op.create_index(
        "ix_finding_remediation_tasks_org_created",
        _TABLE,
        ["organization_id", "created_at"],
    )

    org_match = (
        "organization_id = "
        "current_setting('app.current_organization_id', true)::uuid"
    )
    op.execute(f"ALTER TABLE {_TABLE} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {_TABLE} FORCE ROW LEVEL SECURITY")
    op.execute(f"DROP POLICY IF EXISTS {_POLICY} ON {_TABLE}")
    op.execute(
        f"CREATE POLICY {_POLICY} ON {_TABLE} "
        f"USING ({org_match}) WITH CHECK ({org_match})"
    )
    op.execute(
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON {_TABLE} TO whereas_app"
    )


def downgrade() -> None:
    op.execute(f"DROP POLICY IF EXISTS {_POLICY} ON {_TABLE}")
    op.execute(f"ALTER TABLE {_TABLE} DISABLE ROW LEVEL SECURITY")
    op.drop_index("ix_finding_remediation_tasks_org_created", table_name=_TABLE)
    op.drop_table("finding_remediation_tasks")
