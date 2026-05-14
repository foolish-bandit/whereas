"""add clause templates

Revision ID: 0006_clause_templates
Revises: 0005_deviation_findings_persistence
Create Date: 2026-05-07
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "0006_clause_templates"
down_revision = "0005_deviation_findings_persistence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "clause_templates",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("clause_type", sa.String(length=64), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("jurisdiction", sa.String(length=128), nullable=True),
        sa.Column("contract_type", sa.String(length=64), nullable=True),
        sa.Column("version", sa.String(length=32), nullable=True),
        sa.Column("source", sa.String(length=255), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_clause_templates_org_active", "clause_templates", ["organization_id", "is_active"])
    op.create_index("ix_clause_templates_clause_type", "clause_templates", ["clause_type"])
    op.create_index("ix_clause_templates_jurisdiction", "clause_templates", ["jurisdiction"])
    op.create_index("ix_clause_templates_contract_type", "clause_templates", ["contract_type"])
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute(
            "CREATE INDEX ix_clause_templates_tags_gin "
            "ON clause_templates USING GIN ((tags::jsonb))"
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("DROP INDEX IF EXISTS ix_clause_templates_tags_gin")
    op.drop_index("ix_clause_templates_contract_type", table_name="clause_templates")
    op.drop_index("ix_clause_templates_jurisdiction", table_name="clause_templates")
    op.drop_index("ix_clause_templates_clause_type", table_name="clause_templates")
    op.drop_index("ix_clause_templates_org_active", table_name="clause_templates")
    op.drop_table("clause_templates")
