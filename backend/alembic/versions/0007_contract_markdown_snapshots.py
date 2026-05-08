"""add contract markdown snapshots

Revision ID: 0007_contract_markdown_snapshots
Revises: 0006_clause_templates
Create Date: 2026-05-08
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "0007_contract_markdown_snapshots"
down_revision = "0006_clause_templates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "contract_markdown_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("contract_version_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("markdown_text", sa.Text(), nullable=False),
        sa.Column("source_kind", sa.String(length=32), nullable=False),
        sa.Column("converter_name", sa.String(length=64), nullable=False),
        sa.Column("converter_version", sa.String(length=64), nullable=True),
        sa.Column("conversion_status", sa.String(length=16), nullable=False),
        sa.Column("conversion_warnings", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["contract_id"], ["contracts.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_contract_markdown_snapshots_contract_id",
        "contract_markdown_snapshots",
        ["contract_id"],
    )
    op.create_index(
        "ix_contract_markdown_snapshots_organization_id",
        "contract_markdown_snapshots",
        ["organization_id"],
    )
    op.create_index(
        "ix_contract_markdown_snapshots_created_at",
        "contract_markdown_snapshots",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_contract_markdown_snapshots_created_at",
        table_name="contract_markdown_snapshots",
    )
    op.drop_index(
        "ix_contract_markdown_snapshots_organization_id",
        table_name="contract_markdown_snapshots",
    )
    op.drop_index(
        "ix_contract_markdown_snapshots_contract_id",
        table_name="contract_markdown_snapshots",
    )
    op.drop_table("contract_markdown_snapshots")
