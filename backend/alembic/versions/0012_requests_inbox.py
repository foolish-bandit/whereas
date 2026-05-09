"""add contract_requests and inbox_items

Revision ID: 0012_requests_inbox
Revises: 0011_contract_artifact_wrapped_dek
Create Date: 2026-05-09

This migration adds the foundational CLM intake / work-queue tables.
It is non-destructive: nothing in contracts, agreement_templates, or
artifacts is modified.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "0012_requests_inbox"
down_revision = "0011_contract_artifact_wrapped_dek"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "contract_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("request_type", sa.String(length=64), nullable=True),
        sa.Column("contract_type", sa.String(length=64), nullable=True),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="open",
        ),
        sa.Column("priority", sa.String(length=16), nullable=True),
        sa.Column("requester_name", sa.String(length=255), nullable=True),
        sa.Column("requester_email", sa.String(length=255), nullable=True),
        sa.Column("counterparty_name", sa.String(length=255), nullable=True),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("assigned_to", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("linked_contract_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("linked_template_id", postgresql.UUID(as_uuid=True), nullable=True),
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
        sa.ForeignKeyConstraint(["assigned_to"], ["users.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["linked_contract_id"], ["contracts.id"]),
        sa.ForeignKeyConstraint(["linked_template_id"], ["agreement_templates.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_contract_requests_organization_id",
        "contract_requests",
        ["organization_id"],
    )
    op.create_index(
        "ix_contract_requests_status",
        "contract_requests",
        ["status"],
    )
    op.create_index(
        "ix_contract_requests_request_type",
        "contract_requests",
        ["request_type"],
    )
    op.create_index(
        "ix_contract_requests_contract_type",
        "contract_requests",
        ["contract_type"],
    )
    op.create_index(
        "ix_contract_requests_priority",
        "contract_requests",
        ["priority"],
    )
    op.create_index(
        "ix_contract_requests_assigned_to",
        "contract_requests",
        ["assigned_to"],
    )
    op.create_index(
        "ix_contract_requests_due_date",
        "contract_requests",
        ["due_date"],
    )
    op.create_index(
        "ix_contract_requests_linked_contract_id",
        "contract_requests",
        ["linked_contract_id"],
    )
    op.create_index(
        "ix_contract_requests_linked_template_id",
        "contract_requests",
        ["linked_template_id"],
    )
    op.create_index(
        "ix_contract_requests_created_at",
        "contract_requests",
        ["created_at"],
    )
    op.create_index(
        "ix_contract_requests_org_status_due",
        "contract_requests",
        ["organization_id", "status", "due_date"],
    )
    op.create_index(
        "ix_contract_requests_org_assigned_status",
        "contract_requests",
        ["organization_id", "assigned_to", "status"],
    )

    op.create_table(
        "inbox_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("item_type", sa.String(length=32), nullable=False),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="open",
        ),
        sa.Column("priority", sa.String(length=16), nullable=True),
        sa.Column("assigned_to", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("request_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("template_id", postgresql.UUID(as_uuid=True), nullable=True),
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
        sa.ForeignKeyConstraint(["assigned_to"], ["users.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["request_id"], ["contract_requests.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["contract_id"], ["contracts.id"]),
        sa.ForeignKeyConstraint(["template_id"], ["agreement_templates.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_inbox_items_organization_id",
        "inbox_items",
        ["organization_id"],
    )
    op.create_index(
        "ix_inbox_items_item_type",
        "inbox_items",
        ["item_type"],
    )
    op.create_index(
        "ix_inbox_items_status",
        "inbox_items",
        ["status"],
    )
    op.create_index(
        "ix_inbox_items_priority",
        "inbox_items",
        ["priority"],
    )
    op.create_index(
        "ix_inbox_items_assigned_to",
        "inbox_items",
        ["assigned_to"],
    )
    op.create_index(
        "ix_inbox_items_due_date",
        "inbox_items",
        ["due_date"],
    )
    op.create_index(
        "ix_inbox_items_request_id",
        "inbox_items",
        ["request_id"],
    )
    op.create_index(
        "ix_inbox_items_contract_id",
        "inbox_items",
        ["contract_id"],
    )
    op.create_index(
        "ix_inbox_items_template_id",
        "inbox_items",
        ["template_id"],
    )
    op.create_index(
        "ix_inbox_items_created_at",
        "inbox_items",
        ["created_at"],
    )
    op.create_index(
        "ix_inbox_items_org_status_due",
        "inbox_items",
        ["organization_id", "status", "due_date"],
    )
    op.create_index(
        "ix_inbox_items_org_assigned_status",
        "inbox_items",
        ["organization_id", "assigned_to", "status"],
    )


def downgrade() -> None:
    for ix in (
        "ix_inbox_items_org_assigned_status",
        "ix_inbox_items_org_status_due",
        "ix_inbox_items_created_at",
        "ix_inbox_items_template_id",
        "ix_inbox_items_contract_id",
        "ix_inbox_items_request_id",
        "ix_inbox_items_due_date",
        "ix_inbox_items_assigned_to",
        "ix_inbox_items_priority",
        "ix_inbox_items_status",
        "ix_inbox_items_item_type",
        "ix_inbox_items_organization_id",
    ):
        op.drop_index(ix, table_name="inbox_items")
    op.drop_table("inbox_items")

    for ix in (
        "ix_contract_requests_org_assigned_status",
        "ix_contract_requests_org_status_due",
        "ix_contract_requests_created_at",
        "ix_contract_requests_linked_template_id",
        "ix_contract_requests_linked_contract_id",
        "ix_contract_requests_due_date",
        "ix_contract_requests_assigned_to",
        "ix_contract_requests_priority",
        "ix_contract_requests_contract_type",
        "ix_contract_requests_request_type",
        "ix_contract_requests_status",
        "ix_contract_requests_organization_id",
    ):
        op.drop_index(ix, table_name="contract_requests")
    op.drop_table("contract_requests")
