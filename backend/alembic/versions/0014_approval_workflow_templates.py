"""add approval_workflow_templates and approval_workflow_template_steps

Revision ID: 0014_approval_workflow_templates
Revises: 0013_approval_workflows
Create Date: 2026-05-10

PR #51 — reusable approval workflow templates. Adds two non-destructive
tables. Existing approval_workflow_runs / approval_steps tables are not
altered: instantiation copies template steps into concrete ApprovalStep
rows at runtime.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "0014_approval_workflow_templates"
down_revision = "0013_approval_workflows"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "approval_workflow_templates",
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
        sa.UniqueConstraint(
            "organization_id",
            "name",
            name="uq_approval_workflow_templates_org_name",
        ),
    )
    op.create_index(
        "ix_approval_workflow_templates_organization_id",
        "approval_workflow_templates",
        ["organization_id"],
    )
    op.create_index(
        "ix_approval_workflow_templates_status",
        "approval_workflow_templates",
        ["status"],
    )
    op.create_index(
        "ix_approval_workflow_templates_template_type",
        "approval_workflow_templates",
        ["template_type"],
    )
    op.create_index(
        "ix_approval_workflow_templates_org_status_type",
        "approval_workflow_templates",
        ["organization_id", "status", "template_type"],
    )

    op.create_table(
        "approval_workflow_template_steps",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "workflow_template_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("step_order", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("approver_name", sa.String(length=255), nullable=True),
        sa.Column("approver_email", sa.String(length=255), nullable=True),
        sa.Column("assigned_to", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("due_in_days", sa.Integer(), nullable=True),
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
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(
            ["workflow_template_id"],
            ["approval_workflow_templates.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["assigned_to"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "workflow_template_id",
            "step_order",
            name="uq_approval_workflow_template_steps_template_order",
        ),
    )
    op.create_index(
        "ix_approval_workflow_template_steps_organization_id",
        "approval_workflow_template_steps",
        ["organization_id"],
    )
    op.create_index(
        "ix_approval_workflow_template_steps_workflow_template_id",
        "approval_workflow_template_steps",
        ["workflow_template_id"],
    )
    op.create_index(
        "ix_approval_workflow_template_steps_step_order",
        "approval_workflow_template_steps",
        ["step_order"],
    )
    op.create_index(
        "ix_approval_workflow_template_steps_template_order",
        "approval_workflow_template_steps",
        ["workflow_template_id", "step_order"],
    )


def downgrade() -> None:
    for ix in (
        "ix_approval_workflow_template_steps_template_order",
        "ix_approval_workflow_template_steps_step_order",
        "ix_approval_workflow_template_steps_workflow_template_id",
        "ix_approval_workflow_template_steps_organization_id",
    ):
        op.drop_index(ix, table_name="approval_workflow_template_steps")
    op.drop_table("approval_workflow_template_steps")

    for ix in (
        "ix_approval_workflow_templates_org_status_type",
        "ix_approval_workflow_templates_template_type",
        "ix_approval_workflow_templates_status",
        "ix_approval_workflow_templates_organization_id",
    ):
        op.drop_index(ix, table_name="approval_workflow_templates")
    op.drop_table("approval_workflow_templates")
