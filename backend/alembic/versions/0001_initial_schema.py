"""Initial schema.

Genesis migration. Creates every table currently defined in the ORM
plus the audit log, enables the pgvector extension, and applies the
RLS policies defined in `app.security.rls`.

Transactional DDL:
  Postgres wraps this entire migration in one transaction (set in
  env.py via transaction_per_migration=True). CREATE EXTENSION,
  CREATE ROLE, CREATE TABLE, and CREATE POLICY are all transactional,
  so partial failure rolls everything back. The IF-NOT-EXISTS guards
  in the RLS SQL also make the upgrade idempotent for re-runs after
  a manual partial apply.

Downgrade caveats:
  Does not drop the `vector` extension or the `whereas_app` role.
  Both are cluster-level resources that may be shared with other
  databases or operators on the same Postgres instance. Removing
  them on downgrade would risk breaking unrelated work. They are
  cheap to leave in place.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-05-06
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

from app.security.rls import (
    _create_role_sql,
    _direct_policy_sql,
    _grant_sql,
    _indirect_policy_sql,
)

# revision identifiers, used by Alembic.
revision: str = "0001_initial_schema"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Tables created in dependency order (matches Base.metadata.sorted_tables).
# Drop happens in reverse.
_CREATE_ORDER: tuple[str, ...] = (
    "organizations",
    "playbooks",
    "users",
    "audit_events",
    "contracts",
    "clauses",
    "extracted_fields",
    "deviation_findings",
)

# The current app-level RLS generator includes tables/column shapes added
# after this genesis revision. Keep the initial migration pinned to the tables
# and tenancy paths that actually exist at this point in history.
_GENESIS_DIRECT_RLS_TABLES: tuple[str, ...] = (
    "contracts",
    "playbooks",
    "audit_events",
    "users",
)

_GENESIS_INDIRECT_RLS_TABLES: tuple[str, ...] = (
    "extracted_fields",
    "clauses",
    "deviation_findings",
)


def _build_genesis_rls_sql() -> str:
    parts: list[str] = [_create_role_sql(), _grant_sql()]
    for table in _GENESIS_DIRECT_RLS_TABLES:
        parts.append(_direct_policy_sql(table))
    for table in _GENESIS_INDIRECT_RLS_TABLES:
        parts.append(_indirect_policy_sql(table))
    return "\n".join(parts)


def upgrade() -> None:
    """Create the genesis schema, then apply RLS."""
    # pgvector first: clauses.embedding references it.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # ------------------------------------------------------------------
    # organizations
    # ------------------------------------------------------------------
    op.create_table(
        "organizations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "wrapped_master_key",
            sa.LargeBinary(),
            nullable=True,
            comment=(
                "Wrapped under WHEREAS_INSTANCE_KEY via "
                "app.security.encryption.create_org_master_key. NULL only for "
                "orgs created before key wrapping was wired up; will be "
                "backfilled."
            ),
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # ------------------------------------------------------------------
    # playbooks (FK organizations)
    # ------------------------------------------------------------------
    op.create_table(
        "playbooks",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "organization_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("yaml_source", sa.Text(), nullable=False),
        sa.Column("parsed_rules", sa.JSON(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_playbooks_organization_id",
        "playbooks",
        ["organization_id"],
        unique=False,
    )

    # ------------------------------------------------------------------
    # users (FK organizations)
    # ------------------------------------------------------------------
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "organization_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("is_admin", sa.Boolean(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    # ------------------------------------------------------------------
    # audit_events (FK organizations, users)
    # ------------------------------------------------------------------
    op.create_table(
        "audit_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column(
            "organization_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("actor_ip", sa.String(length=45), nullable=True),
        sa.Column("actor_user_agent", sa.String(length=500), nullable=True),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("target_type", sa.String(length=64), nullable=True),
        sa.Column("target_id", sa.String(length=64), nullable=True),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("prev_hash", sa.String(length=64), nullable=False),
        sa.Column("entry_hash", sa.String(length=64), nullable=False),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("entry_hash"),
        sa.UniqueConstraint(
            "organization_id", "sequence", name="uq_audit_org_sequence"
        ),
    )
    op.create_index(
        "ix_audit_events_event_type", "audit_events", ["event_type"], unique=False
    )
    op.create_index(
        "ix_audit_events_organization_id",
        "audit_events",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_audit_events_sequence", "audit_events", ["sequence"], unique=False
    )

    # ------------------------------------------------------------------
    # contracts (FK organizations, users)
    # ------------------------------------------------------------------
    op.create_table(
        "contracts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "organization_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("uploaded_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("s3_key", sa.String(length=1024), nullable=False),
        sa.Column("mime_type", sa.String(length=128), nullable=False),
        sa.Column("file_hash_sha256", sa.String(length=64), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=True),
        sa.Column("full_text", sa.Text(), nullable=True),
        sa.Column(
            "docuseal_submission_id", sa.String(length=128), nullable=True
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["uploaded_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_contracts_file_hash_sha256",
        "contracts",
        ["file_hash_sha256"],
        unique=False,
    )
    op.create_index(
        "ix_contracts_organization_id",
        "contracts",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_contracts_status", "contracts", ["status"], unique=False
    )

    # ------------------------------------------------------------------
    # clauses (FK contracts; pgvector embedding)
    # ------------------------------------------------------------------
    op.create_table(
        "clauses",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("span_start", sa.Integer(), nullable=False),
        sa.Column("span_end", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("clause_type", sa.String(length=128), nullable=False),
        sa.Column("classification_confidence", sa.Float(), nullable=False),
        sa.Column("embedding", Vector(1024), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["contract_id"], ["contracts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_clauses_clause_type", "clauses", ["clause_type"], unique=False
    )
    op.create_index(
        "ix_clauses_contract_id", "clauses", ["contract_id"], unique=False
    )

    # ------------------------------------------------------------------
    # extracted_fields (FK contracts, users)
    # ------------------------------------------------------------------
    op.create_table(
        "extracted_fields",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("field_name", sa.String(length=128), nullable=False),
        sa.Column("value_json", sa.JSON(), nullable=False),
        sa.Column("span_start", sa.Integer(), nullable=True),
        sa.Column("span_end", sa.Integer(), nullable=True),
        sa.Column("span_text", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("model_name", sa.String(length=128), nullable=False),
        sa.Column("prompt_version", sa.String(length=32), nullable=False),
        sa.Column(
            "extracted_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("overridden_value_json", sa.JSON(), nullable=True),
        sa.Column("overridden_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("overridden_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["contract_id"], ["contracts.id"]),
        sa.ForeignKeyConstraint(["overridden_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "contract_id", "field_name", name="uq_extracted_field_per_contract"
        ),
    )
    op.create_index(
        "ix_extracted_fields_contract_id",
        "extracted_fields",
        ["contract_id"],
        unique=False,
    )
    op.create_index(
        "ix_extracted_fields_field_name",
        "extracted_fields",
        ["field_name"],
        unique=False,
    )

    # ------------------------------------------------------------------
    # deviation_findings (FK contracts, playbooks, clauses, users)
    # ------------------------------------------------------------------
    op.create_table(
        "deviation_findings",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("playbook_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("clause_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("rule_id", sa.String(length=128), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("suggested_redline", sa.Text(), nullable=True),
        sa.Column("model_name", sa.String(length=128), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("dismissed", sa.Boolean(), nullable=False),
        sa.Column("dismissed_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("dismissed_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["clause_id"], ["clauses.id"]),
        sa.ForeignKeyConstraint(["contract_id"], ["contracts.id"]),
        sa.ForeignKeyConstraint(["dismissed_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["playbook_id"], ["playbooks.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_deviation_findings_contract_id",
        "deviation_findings",
        ["contract_id"],
        unique=False,
    )
    op.create_index(
        "ix_deviation_findings_severity",
        "deviation_findings",
        ["severity"],
        unique=False,
    )

    # ------------------------------------------------------------------
    # RLS: role, grants, per-table policies.
    # Must run AFTER tables exist; the policies reference them.
    # ------------------------------------------------------------------
    op.execute(_build_genesis_rls_sql())


def downgrade() -> None:
    """Drop the schema.

    Does not drop the `vector` extension or the `whereas_app` role;
    those are cluster-level resources that may be shared with other
    databases on the same Postgres instance.

    DROP TABLE removes any policies attached to the table, so the
    explicit DROP POLICY / DISABLE ROW LEVEL SECURITY pass below is
    technically redundant for the tables we then drop. We still do
    it for clarity and to leave a clean state if a future change
    keeps any of these tables across a downgrade.
    """
    for table in _GENESIS_DIRECT_RLS_TABLES + _GENESIS_INDIRECT_RLS_TABLES:
        op.execute(
            f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}"
        )
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    # Drop tables in reverse creation order.
    for table in reversed(_CREATE_ORDER):
        op.drop_table(table)

    # Intentionally NOT dropped:
    #   - DROP EXTENSION vector;        # cluster-level, may be shared
    #   - DROP ROLE whereas_app;        # cluster-level, may be shared
