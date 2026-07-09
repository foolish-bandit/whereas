"""Backfill RLS coverage for tables added in migrations 0006-0017.

`app.security.rls.TENANT_SCOPED_TABLES` / `_DIRECT_ORG_TABLES` were not
updated when `clause_templates` (0006) through `integration_imported_files`
(0017) were added, even though every one of those tables carries its own
`organization_id` column. Per `alembic/README.md`'s RLS convention, a
migration that adds a tenant-scoped table is supposed to update
`app.security.rls` and re-run `build_full_migration_sql()` in the same
migration; that step was skipped eleven migrations in a row. This
migration closes the gap: `app.security.rls` was updated first (in the
same PR) to add all sixteen tables to `_DIRECT_ORG_TABLES`, and this
migration just re-applies the now-complete policy set.

`build_full_migration_sql()` is idempotent (`DROP POLICY IF EXISTS` +
recreate, `ENABLE`/`FORCE ROW LEVEL SECURITY` are themselves idempotent),
so re-running it also re-applies — harmlessly — the policies for tables
that already had correct RLS coverage.

Downgrade only disables RLS / drops the policy for the sixteen
newly-covered tables, restoring the pre-migration (unenforced) state.
Tables covered before this migration (`contracts`, `extracted_fields`,
`clauses`, `playbooks`, `deviation_findings`, `playbook_review_runs`,
`audit_events`, `users`) are left untouched — they had RLS long before
this migration and downgrading this one must not weaken them.

Revision ID: 0019_rls_backfill_0006_0017
Revises: 0018_search_indexes
Create Date: 2026-07-09
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

from app.security.rls import build_full_migration_sql

# revision identifiers, used by Alembic.
revision: str = "0019_rls_backfill_0006_0017"
down_revision: str | Sequence[str] | None = "0018_search_indexes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# The sixteen direct-org tables this migration newly covers. Kept as a
# local, pinned tuple (rather than importing `_DIRECT_ORG_TABLES`, which
# will keep growing) so downgrade() only ever touches what THIS migration
# added, regardless of what later migrations layer on top of `rls.py`.
_BACKFILLED_TABLES: tuple[str, ...] = (
    "clause_templates",
    "contract_markdown_snapshots",
    "contract_artifacts",
    "agreement_templates",
    "agreement_template_artifacts",
    "agreement_template_markdown_snapshots",
    "agreement_template_variables",
    "contract_requests",
    "inbox_items",
    "approval_workflow_runs",
    "approval_steps",
    "approval_workflow_templates",
    "approval_workflow_template_steps",
    "approval_policies",
    "integration_connections",
    "integration_imported_files",
)


def upgrade() -> None:
    op.execute(build_full_migration_sql())


def downgrade() -> None:
    for table in _BACKFILLED_TABLES:
        op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
