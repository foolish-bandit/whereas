"""Nango integration connections.

Adds ``integration_connections`` (one row per org+provider) and
``integration_imported_files`` (idempotency record per imported file).
Tokens never live in our DB — those stay in Nango.

Revision ID: 0017_integration_connections
Revises: 0016_contract_duplicate_merge
Create Date: 2026-05-16
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0017_integration_connections"
down_revision = "0016_contract_duplicate_merge"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "integration_connections",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("nango_connection_id", sa.String(length=255), nullable=False),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="active",
        ),
        sa.Column(
            "ingest_mode",
            sa.String(length=16),
            nullable=False,
            server_default="inbox_review",
        ),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_sync_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id",
            "provider",
            name="uq_integration_connections_org_provider",
        ),
    )
    op.create_index(
        "ix_integration_connections_organization_id",
        "integration_connections",
        ["organization_id"],
    )
    op.create_index(
        "ix_integration_connections_provider",
        "integration_connections",
        ["provider"],
    )
    op.create_index(
        "ix_integration_connections_status",
        "integration_connections",
        ["status"],
    )

    op.create_table(
        "integration_imported_files",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("connection_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("provider_file_id", sa.String(length=512), nullable=False),
        sa.Column("provider_file_revision", sa.String(length=128), nullable=True),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("filename", sa.String(length=512), nullable=True),
        sa.Column("mime_type", sa.String(length=128), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("imported_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(
            ["connection_id"],
            ["integration_connections.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["contract_id"],
            ["contracts.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "connection_id",
            "provider_file_id",
            name="uq_integration_imported_files_connection_file",
        ),
    )
    op.create_index(
        "ix_integration_imported_files_organization_id",
        "integration_imported_files",
        ["organization_id"],
    )
    op.create_index(
        "ix_integration_imported_files_connection_id",
        "integration_imported_files",
        ["connection_id"],
    )
    op.create_index(
        "ix_integration_imported_files_contract_id",
        "integration_imported_files",
        ["contract_id"],
    )
    op.create_index(
        "ix_integration_imported_files_org_provider",
        "integration_imported_files",
        ["organization_id", "provider"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_integration_imported_files_org_provider",
        table_name="integration_imported_files",
    )
    op.drop_index(
        "ix_integration_imported_files_contract_id",
        table_name="integration_imported_files",
    )
    op.drop_index(
        "ix_integration_imported_files_connection_id",
        table_name="integration_imported_files",
    )
    op.drop_index(
        "ix_integration_imported_files_organization_id",
        table_name="integration_imported_files",
    )
    op.drop_table("integration_imported_files")

    op.drop_index(
        "ix_integration_connections_status",
        table_name="integration_connections",
    )
    op.drop_index(
        "ix_integration_connections_provider",
        table_name="integration_connections",
    )
    op.drop_index(
        "ix_integration_connections_organization_id",
        table_name="integration_connections",
    )
    op.drop_table("integration_connections")
