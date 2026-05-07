"""Persist deterministic playbook review findings.

Replaces the genesis-migration ``deviation_findings`` table (which was
shaped for hypothetical LLM-driven redlines and never written to by any
service) with a deterministic-findings schema, and introduces the
``playbook_review_runs`` table that scopes them.

What this migration does
------------------------

1. Drops the legacy ``deviation_findings`` table and its indexes /
   policies. The table has never been populated (no service writes to it
   on main), so the up-migration treats it as scaffolding to be
   replaced.
2. Creates ``playbook_review_runs``: one row per
   (contract, playbook, run-time) with the matcher's aggregate counts.
3. Creates the new ``deviation_findings`` table — failures only, with
   exact-span evidence copied from ``Clause`` rows, a deterministic
   ``status`` field and an independent ``finding_status`` reviewer
   workflow column.
4. Re-applies the RLS policy set so the two new tables get direct-org
   policies (both carry ``organization_id`` directly). The legacy
   ``deviation_findings`` policy is dropped explicitly before the
   table is dropped — defense in depth against a future ``DROP TABLE``
   that does not cascade to the policy.

Why direct-org policies for both new tables
-------------------------------------------

The legacy ``deviation_findings`` table had no ``organization_id`` and
relied on an indirect-via-``contracts`` policy. The new tables both
denormalize ``organization_id`` so the policy is a simple equality
check against the session setting, which is faster (no EXISTS subquery)
and keeps cross-org reads from leaking through any orphaned rows that
might survive a future ``contracts`` reshape.

Downgrade
---------

Drops the new tables and recreates the legacy ``deviation_findings``
schema so a chain of downgrades back to ``base`` reaches the same
state ``0001`` left behind. The legacy table has no data to preserve,
so this is purely about keeping the migration tests' before/after
schema-equality assertions tidy.

Revision ID: 0005_deviation_findings_persistence
Revises: 0004_playbook_schema_metadata
Create Date: 2026-05-07
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.security.rls import build_full_migration_sql

# revision identifiers, used by Alembic.
revision: str = "0005_deviation_findings_persistence"
down_revision: str | Sequence[str] | None = "0004_playbook_schema_metadata"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Drop legacy deviation_findings, create the persisted-findings schema."""
    # ------------------------------------------------------------------
    # 1. Drop the legacy deviation_findings policy + table.
    #
    # DROP TABLE in Postgres cascades to the policies attached to it,
    # but we DROP POLICY first to keep the tear-down explicit and
    # symmetric with `0001`'s downgrade.
    # ------------------------------------------------------------------
    op.execute(
        "DROP POLICY IF EXISTS deviation_findings_tenant_isolation "
        "ON deviation_findings"
    )
    op.execute("ALTER TABLE deviation_findings DISABLE ROW LEVEL SECURITY")
    op.drop_table("deviation_findings")

    # ------------------------------------------------------------------
    # 2. playbook_review_runs
    # ------------------------------------------------------------------
    op.create_table(
        "playbook_review_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "organization_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("playbook_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("rules_checked", sa.Integer(), nullable=False),
        sa.Column("failed_count", sa.Integer(), nullable=False),
        sa.Column("passed_count", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(
            ["contract_id"], ["contracts.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["playbook_id"], ["playbooks.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_playbook_review_runs_org",
        "playbook_review_runs",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_playbook_review_runs_contract",
        "playbook_review_runs",
        ["contract_id"],
        unique=False,
    )
    op.create_index(
        "ix_playbook_review_runs_contract_playbook",
        "playbook_review_runs",
        ["contract_id", "playbook_id"],
        unique=False,
    )
    op.create_index(
        "ix_playbook_review_runs_created_at",
        "playbook_review_runs",
        ["created_at"],
        unique=False,
    )

    # ------------------------------------------------------------------
    # 3. deviation_findings (new schema)
    # ------------------------------------------------------------------
    op.create_table(
        "deviation_findings",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "organization_id", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column("contract_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("playbook_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("review_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("rule_id", sa.String(length=128), nullable=False),
        sa.Column("rule_title", sa.String(length=500), nullable=False),
        sa.Column("rule_type", sa.String(length=32), nullable=False),
        sa.Column("clause_type", sa.String(length=64), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column(
            "finding_status",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'open'"),
        ),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("clause_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("evidence_text", sa.Text(), nullable=True),
        sa.Column("span_start", sa.Integer(), nullable=True),
        sa.Column("span_end", sa.Integer(), nullable=True),
        sa.Column("matched_terms", sa.JSON(), nullable=True),
        sa.Column("expected_value", sa.Text(), nullable=True),
        sa.Column("guidance", sa.Text(), nullable=True),
        sa.Column("preferred_language", sa.Text(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["contract_id"], ["contracts.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["playbook_id"], ["playbooks.id"]),
        sa.ForeignKeyConstraint(
            ["review_run_id"], ["playbook_review_runs.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["clause_id"], ["clauses.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_deviation_findings_organization_id",
        "deviation_findings",
        ["organization_id"],
        unique=False,
    )
    op.create_index(
        "ix_deviation_findings_contract_id",
        "deviation_findings",
        ["contract_id"],
        unique=False,
    )
    op.create_index(
        "ix_deviation_findings_playbook_id",
        "deviation_findings",
        ["playbook_id"],
        unique=False,
    )
    op.create_index(
        "ix_deviation_findings_contract_playbook",
        "deviation_findings",
        ["contract_id", "playbook_id"],
        unique=False,
    )
    op.create_index(
        "ix_deviation_findings_contract_status",
        "deviation_findings",
        ["contract_id", "finding_status"],
        unique=False,
    )
    op.create_index(
        "ix_deviation_findings_review_run_id",
        "deviation_findings",
        ["review_run_id"],
        unique=False,
    )
    op.create_index(
        "ix_deviation_findings_severity",
        "deviation_findings",
        ["severity"],
        unique=False,
    )

    # ------------------------------------------------------------------
    # 4. Re-apply RLS. `build_full_migration_sql` is idempotent (DROP
    #    POLICY IF EXISTS / CREATE POLICY), so re-running it picks up
    #    the new tables and rewrites existing policies in place. The
    #    legacy indirect deviation_findings policy was already dropped
    #    above with the table.
    # ------------------------------------------------------------------
    op.execute(build_full_migration_sql())


def downgrade() -> None:
    """Reverse: drop the new tables, restore the legacy schema."""
    # Drop policies first so a `DROP TABLE` doesn't cascade unexpectedly.
    op.execute(
        "DROP POLICY IF EXISTS deviation_findings_tenant_isolation "
        "ON deviation_findings"
    )
    op.execute("ALTER TABLE deviation_findings DISABLE ROW LEVEL SECURITY")
    op.execute(
        "DROP POLICY IF EXISTS playbook_review_runs_tenant_isolation "
        "ON playbook_review_runs"
    )
    op.execute("ALTER TABLE playbook_review_runs DISABLE ROW LEVEL SECURITY")

    op.drop_index(
        "ix_deviation_findings_severity", table_name="deviation_findings"
    )
    op.drop_index(
        "ix_deviation_findings_review_run_id", table_name="deviation_findings"
    )
    op.drop_index(
        "ix_deviation_findings_contract_status", table_name="deviation_findings"
    )
    op.drop_index(
        "ix_deviation_findings_contract_playbook",
        table_name="deviation_findings",
    )
    op.drop_index(
        "ix_deviation_findings_playbook_id", table_name="deviation_findings"
    )
    op.drop_index(
        "ix_deviation_findings_contract_id", table_name="deviation_findings"
    )
    op.drop_index(
        "ix_deviation_findings_organization_id",
        table_name="deviation_findings",
    )
    op.drop_table("deviation_findings")

    op.drop_index(
        "ix_playbook_review_runs_created_at", table_name="playbook_review_runs"
    )
    op.drop_index(
        "ix_playbook_review_runs_contract_playbook",
        table_name="playbook_review_runs",
    )
    op.drop_index(
        "ix_playbook_review_runs_contract", table_name="playbook_review_runs"
    )
    op.drop_index(
        "ix_playbook_review_runs_org", table_name="playbook_review_runs"
    )
    op.drop_table("playbook_review_runs")

    # Recreate the legacy deviation_findings table so a downgrade chain
    # back to base lands in the same shape `0001` produced. No data is
    # backfilled — the table is empty by construction.
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

    # Re-apply RLS so the resurrected legacy table picks the indirect
    # policy back up. Note that this temporarily re-introduces a policy
    # set that does not include playbook_review_runs (because that
    # table is gone now), which `build_full_migration_sql` handles
    # naturally by iterating its own table list.
    #
    # The downgrade path expects `app.security.rls` to have been rolled
    # back in lockstep with the migration; in practice nobody downgrades
    # a pre-v0.1 schema, so this is here for completeness rather than
    # for a real operational scenario.
    legacy_sql = (
        "ALTER TABLE deviation_findings ENABLE ROW LEVEL SECURITY;\n"
        "ALTER TABLE deviation_findings FORCE ROW LEVEL SECURITY;\n"
        "DROP POLICY IF EXISTS deviation_findings_tenant_isolation "
        "ON deviation_findings;\n"
        "CREATE POLICY deviation_findings_tenant_isolation ON deviation_findings\n"
        "    USING (contract_id IN (\n"
        "        SELECT id FROM contracts\n"
        "        WHERE organization_id = "
        "current_setting('app.current_organization_id', true)::uuid\n"
        "    ))\n"
        "    WITH CHECK (contract_id IN (\n"
        "        SELECT id FROM contracts\n"
        "        WHERE organization_id = "
        "current_setting('app.current_organization_id', true)::uuid\n"
        "    ));\n"
    )
    op.execute(legacy_sql)
