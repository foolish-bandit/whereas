"""add agreement templates

Revision ID: 0009_agreement_templates
Revises: 0008_contract_artifacts
Create Date: 2026-05-08
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "0009_agreement_templates"
down_revision = "0008_contract_artifacts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agreement_templates",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("template_type", sa.String(length=64), nullable=True),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="active",
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
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_agreement_templates_organization_id",
        "agreement_templates",
        ["organization_id"],
    )
    op.create_index(
        "ix_agreement_templates_status",
        "agreement_templates",
        ["status"],
    )
    op.create_index(
        "ix_agreement_templates_template_type",
        "agreement_templates",
        ["template_type"],
    )

    op.create_table(
        "agreement_template_artifacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("template_id", postgresql.UUID(as_uuid=True), nullable=False),
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
            ["template_id"], ["agreement_templates.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_agreement_template_artifacts_organization_id",
        "agreement_template_artifacts",
        ["organization_id"],
    )
    op.create_index(
        "ix_agreement_template_artifacts_template_id",
        "agreement_template_artifacts",
        ["template_id"],
    )
    op.create_index(
        "ix_agreement_template_artifacts_artifact_type",
        "agreement_template_artifacts",
        ["artifact_type"],
    )
    op.create_index(
        "ix_agreement_template_artifacts_created_at",
        "agreement_template_artifacts",
        ["created_at"],
    )
    op.create_index(
        "ix_agreement_template_artifacts_org_tmpl_type_created",
        "agreement_template_artifacts",
        ["organization_id", "template_id", "artifact_type", "created_at"],
    )

    op.create_table(
        "agreement_template_markdown_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("template_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("markdown_text", sa.Text(), nullable=False),
        sa.Column("source_kind", sa.String(length=32), nullable=False),
        sa.Column("converter_name", sa.String(length=64), nullable=True),
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
            ["template_id"], ["agreement_templates.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_agreement_template_markdown_organization_id",
        "agreement_template_markdown_snapshots",
        ["organization_id"],
    )
    op.create_index(
        "ix_agreement_template_markdown_template_id",
        "agreement_template_markdown_snapshots",
        ["template_id"],
    )
    op.create_index(
        "ix_agreement_template_markdown_org_tmpl_status_created",
        "agreement_template_markdown_snapshots",
        ["organization_id", "template_id", "conversion_status", "created_at"],
    )

    op.create_table(
        "agreement_template_variables",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("template_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("variable_type", sa.String(length=32), nullable=False),
        sa.Column(
            "required", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("default_value", sa.Text(), nullable=True),
        sa.Column("help_text", sa.Text(), nullable=True),
        sa.Column(
            "sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["template_id"], ["agreement_templates.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "template_id", "key", name="uq_agreement_template_variables_tmpl_key"
        ),
    )
    op.create_index(
        "ix_agreement_template_variables_organization_id",
        "agreement_template_variables",
        ["organization_id"],
    )
    op.create_index(
        "ix_agreement_template_variables_template_id",
        "agreement_template_variables",
        ["template_id"],
    )
    op.create_index(
        "ix_agreement_template_variables_org_tmpl_key",
        "agreement_template_variables",
        ["organization_id", "template_id", "key"],
    )


def downgrade() -> None:
    for ix in (
        "ix_agreement_template_variables_org_tmpl_key",
        "ix_agreement_template_variables_template_id",
        "ix_agreement_template_variables_organization_id",
    ):
        op.drop_index(ix, table_name="agreement_template_variables")
    op.drop_table("agreement_template_variables")

    for ix in (
        "ix_agreement_template_markdown_org_tmpl_status_created",
        "ix_agreement_template_markdown_template_id",
        "ix_agreement_template_markdown_organization_id",
    ):
        op.drop_index(ix, table_name="agreement_template_markdown_snapshots")
    op.drop_table("agreement_template_markdown_snapshots")

    for ix in (
        "ix_agreement_template_artifacts_org_tmpl_type_created",
        "ix_agreement_template_artifacts_created_at",
        "ix_agreement_template_artifacts_artifact_type",
        "ix_agreement_template_artifacts_template_id",
        "ix_agreement_template_artifacts_organization_id",
    ):
        op.drop_index(ix, table_name="agreement_template_artifacts")
    op.drop_table("agreement_template_artifacts")

    for ix in (
        "ix_agreement_templates_template_type",
        "ix_agreement_templates_status",
        "ix_agreement_templates_organization_id",
    ):
        op.drop_index(ix, table_name="agreement_templates")
    op.drop_table("agreement_templates")
