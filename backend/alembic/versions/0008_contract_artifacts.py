"""add contract artifacts

Revision ID: 0008_contract_artifacts
Revises: 0007_contract_markdown_snapshots
Create Date: 2026-05-08
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "0008_contract_artifacts"
down_revision = "0007_contract_markdown_snapshots"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "contract_artifacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("artifact_type", sa.String(length=32), nullable=False),
        sa.Column("storage_backend", sa.String(length=32), nullable=False),
        sa.Column("storage_key", sa.String(length=1024), nullable=True),
        sa.Column("filename", sa.String(length=512), nullable=True),
        sa.Column("mime_type", sa.String(length=128), nullable=True),
        sa.Column("file_hash_sha256", sa.String(length=64), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column("source", sa.String(length=64), nullable=True),
        sa.Column(
            "is_official",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(
            ["contract_id"], ["contracts.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_contract_artifacts_organization_id",
        "contract_artifacts",
        ["organization_id"],
    )
    op.create_index(
        "ix_contract_artifacts_contract_id",
        "contract_artifacts",
        ["contract_id"],
    )
    op.create_index(
        "ix_contract_artifacts_artifact_type",
        "contract_artifacts",
        ["artifact_type"],
    )
    op.create_index(
        "ix_contract_artifacts_created_at",
        "contract_artifacts",
        ["created_at"],
    )
    op.create_index(
        "ix_contract_artifacts_org_contract_type_created",
        "contract_artifacts",
        ["organization_id", "contract_id", "artifact_type", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_contract_artifacts_org_contract_type_created",
        table_name="contract_artifacts",
    )
    op.drop_index(
        "ix_contract_artifacts_created_at",
        table_name="contract_artifacts",
    )
    op.drop_index(
        "ix_contract_artifacts_artifact_type",
        table_name="contract_artifacts",
    )
    op.drop_index(
        "ix_contract_artifacts_contract_id",
        table_name="contract_artifacts",
    )
    op.drop_index(
        "ix_contract_artifacts_organization_id",
        table_name="contract_artifacts",
    )
    op.drop_table("contract_artifacts")
