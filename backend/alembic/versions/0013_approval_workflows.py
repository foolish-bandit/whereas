"""add approval_workflow_runs and approval_steps

Revision ID: 0013_approval_workflows
Revises: 0012_requests_inbox
Create Date: 2026-05-09

PR #50 — narrow approval workflow foundation. Adds two non-destructive
tables. Existing request/contract/template/artifact tables are not
altered.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "0013_approval_workflows"
down_revision = "0012_requests_inbox"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "approval_workflow_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="active",
        ),
        sa.Column("request_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("template_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("current_step_order", sa.Integer(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.ForeignKeyConstraint(["request_id"], ["contract_requests.id"]),
        sa.ForeignKeyConstraint(["contract_id"], ["contracts.id"]),
        sa.ForeignKeyConstraint(["template_id"], ["agreement_templates.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_approval_workflow_runs_organization_id",
        "approval_workflow_runs",
        ["organization_id"],
    )
    op.create_index(
        "ix_approval_workflow_runs_status",
        "approval_workflow_runs",
        ["status"],
    )
    op.create_index(
        "ix_approval_workflow_runs_request_id",
        "approval_workflow_runs",
        ["request_id"],
    )
    op.create_index(
        "ix_approval_workflow_runs_contract_id",
        "approval_workflow_runs",
        ["contract_id"],
    )
    op.create_index(
        "ix_approval_workflow_runs_created_at",
        "approval_workflow_runs",
        ["created_at"],
    )

    op.create_table(
        "approval_steps",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("workflow_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("step_order", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("approver_name", sa.String(length=255), nullable=True),
        sa.Column("approver_email", sa.String(length=255), nullable=True),
        sa.Column("assigned_to", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("decision_note", sa.Text(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("inbox_item_id", postgresql.UUID(as_uuid=True), nullable=True),
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
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(
            ["workflow_run_id"],
            ["approval_workflow_runs.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["assigned_to"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["inbox_item_id"], ["inbox_items.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "workflow_run_id", "step_order", name="uq_approval_steps_run_order"
        ),
    )
    op.create_index(
        "ix_approval_steps_organization_id",
        "approval_steps",
        ["organization_id"],
    )
    op.create_index(
        "ix_approval_steps_workflow_run_id",
        "approval_steps",
        ["workflow_run_id"],
    )
    op.create_index(
        "ix_approval_steps_status",
        "approval_steps",
        ["status"],
    )
    op.create_index(
        "ix_approval_steps_assigned_to",
        "approval_steps",
        ["assigned_to"],
    )
    op.create_index(
        "ix_approval_steps_due_date",
        "approval_steps",
        ["due_date"],
    )
    op.create_index(
        "ix_approval_steps_org_status_due",
        "approval_steps",
        ["organization_id", "status", "due_date"],
    )


def downgrade() -> None:
    for ix in (
        "ix_approval_steps_org_status_due",
        "ix_approval_steps_due_date",
        "ix_approval_steps_assigned_to",
        "ix_approval_steps_status",
        "ix_approval_steps_workflow_run_id",
        "ix_approval_steps_organization_id",
    ):
        op.drop_index(ix, table_name="approval_steps")
    op.drop_table("approval_steps")

    for ix in (
        "ix_approval_workflow_runs_created_at",
        "ix_approval_workflow_runs_contract_id",
        "ix_approval_workflow_runs_request_id",
        "ix_approval_workflow_runs_status",
        "ix_approval_workflow_runs_organization_id",
    ):
        op.drop_index(ix, table_name="approval_workflow_runs")
    op.drop_table("approval_workflow_runs")
