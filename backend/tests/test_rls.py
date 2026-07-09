"""Unit tests for the RLS SQL-builder functions in `app.security.rls`.

This module only builds SQL strings (see its module docstring); the actual
policies are exercised end-to-end against real Postgres by
`test_migrations.py`, which is skipped without Docker. These tests instead
pin down the *text* the builders emit — table/policy name interpolation,
idempotency guards, and correct join conditions — so a typo in a table name
or a missing `DROP POLICY IF EXISTS` is caught without needing a database.
"""
from __future__ import annotations

from app.security.rls import (
    _DIRECT_ORG_TABLES,
    _INDIRECT_ORG_TABLES,
    TENANT_SCOPED_TABLES,
    _create_role_sql,
    _direct_policy_sql,
    _grant_sql,
    _indirect_policy_sql,
    build_full_migration_sql,
)


class TestDirectPolicySql:
    def test_names_policy_after_the_table(self) -> None:
        sql = _direct_policy_sql("widgets")
        assert "widgets_tenant_isolation" in sql

    def test_enables_and_forces_rls(self) -> None:
        sql = _direct_policy_sql("widgets")
        assert "ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;" in sql
        assert "ALTER TABLE widgets FORCE ROW LEVEL SECURITY;" in sql

    def test_drops_before_recreating_for_idempotency(self) -> None:
        sql = _direct_policy_sql("widgets")
        drop_idx = sql.index("DROP POLICY IF EXISTS widgets_tenant_isolation ON widgets;")
        create_idx = sql.index("CREATE POLICY widgets_tenant_isolation ON widgets")
        assert drop_idx < create_idx

    def test_compares_organization_id_to_session_setting(self) -> None:
        sql = _direct_policy_sql("widgets")
        expected = (
            "organization_id = current_setting('app.current_organization_id', true)::uuid"
        )
        assert expected in sql
        # Same predicate on both USING and WITH CHECK: an app row can't be
        # written into another org's tenant just because a query missed a
        # filter on the way in.
        assert sql.count(expected) == 2

    def test_running_twice_is_syntactically_idempotent(self) -> None:
        """Calling the builder twice must produce SQL safe to execute back
        to back — this is what makes re-running a migration (or replaying
        `build_full_migration_sql` from a later revision) safe."""
        first = _direct_policy_sql("widgets")
        second = _direct_policy_sql("widgets")
        assert first == second


class TestIndirectPolicySql:
    def test_names_policy_after_the_table(self) -> None:
        sql = _indirect_policy_sql("widget_parts")
        assert "widget_parts_tenant_isolation" in sql

    def test_enables_and_forces_rls(self) -> None:
        sql = _indirect_policy_sql("widget_parts")
        assert "ALTER TABLE widget_parts ENABLE ROW LEVEL SECURITY;" in sql
        assert "ALTER TABLE widget_parts FORCE ROW LEVEL SECURITY;" in sql

    def test_drops_before_recreating_for_idempotency(self) -> None:
        sql = _indirect_policy_sql("widget_parts")
        drop_idx = sql.index(
            "DROP POLICY IF EXISTS widget_parts_tenant_isolation ON widget_parts;"
        )
        create_idx = sql.index("CREATE POLICY widget_parts_tenant_isolation ON widget_parts")
        assert drop_idx < create_idx

    def test_reaches_org_through_contracts_subquery(self) -> None:
        sql = _indirect_policy_sql("widget_parts")
        assert "contract_id IN (" in sql
        assert "SELECT id FROM contracts" in sql
        assert (
            "organization_id = current_setting('app.current_organization_id', true)::uuid"
            in sql
        )
        # No direct organization_id comparison on the table itself — the
        # only org check is the one routed through contracts.
        assert "widget_parts.organization_id" not in sql

    def test_running_twice_is_syntactically_idempotent(self) -> None:
        first = _indirect_policy_sql("widget_parts")
        second = _indirect_policy_sql("widget_parts")
        assert first == second


class TestRoleAndGrantSql:
    def test_role_creation_is_gated_on_existence(self) -> None:
        sql = _create_role_sql()
        assert "IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whereas_app')" in sql
        assert "CREATE ROLE whereas_app NOLOGIN;" in sql

    def test_grants_cover_current_and_future_tables(self) -> None:
        sql = _grant_sql()
        assert "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public" in sql
        assert "ALTER DEFAULT PRIVILEGES IN SCHEMA public" in sql


class TestFullMigrationSql:
    def test_includes_role_and_grant_setup(self) -> None:
        sql = build_full_migration_sql()
        assert "CREATE ROLE whereas_app NOLOGIN;" in sql
        assert "ALTER DEFAULT PRIVILEGES IN SCHEMA public" in sql

    def test_every_direct_org_table_gets_a_direct_policy(self) -> None:
        sql = build_full_migration_sql()
        for table in _DIRECT_ORG_TABLES:
            assert f"CREATE POLICY {table}_tenant_isolation ON {table}" in sql
            assert "organization_id = current_setting" in sql

    def test_every_indirect_org_table_gets_an_indirect_policy(self) -> None:
        sql = build_full_migration_sql()
        for table in _INDIRECT_ORG_TABLES:
            assert f"CREATE POLICY {table}_tenant_isolation ON {table}" in sql

    def test_direct_and_indirect_tables_are_disjoint(self) -> None:
        assert set(_DIRECT_ORG_TABLES).isdisjoint(_INDIRECT_ORG_TABLES)

    def test_tenant_scoped_tables_covers_every_direct_and_indirect_table(self) -> None:
        """`TENANT_SCOPED_TABLES` is the human-facing inventory; it must not
        silently drift from the tables the SQL builders actually cover."""
        assert set(TENANT_SCOPED_TABLES) == set(_DIRECT_ORG_TABLES) | set(
            _INDIRECT_ORG_TABLES
        )

    def test_migrations_0006_through_0017_tables_are_covered(self) -> None:
        """Regression test for the staleness this migration fixes: every
        org-scoped table introduced between the genesis migration and
        migration 0017 must appear in the direct-org policy set."""
        backfilled_tables = {
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
        }
        assert backfilled_tables.issubset(set(_DIRECT_ORG_TABLES))

    def test_running_twice_is_syntactically_idempotent(self) -> None:
        first = build_full_migration_sql()
        second = build_full_migration_sql()
        assert first == second

    def test_explicit_tables_arg_limits_policy_output(self) -> None:
        # Migrations pass a frozen, era-correct table list so that a
        # fresh-database replay never references tables created by later
        # migrations (0005 broke exactly this way when rls.py's lists
        # grew in 0019).
        sql = build_full_migration_sql(tables=("contracts", "clauses"))
        assert "contracts_tenant_isolation" in sql
        assert "clauses_tenant_isolation" in sql
        assert "playbooks_tenant_isolation" not in sql
        assert "clause_templates_tenant_isolation" not in sql
        # Role/grant preamble is always emitted.
        assert "CREATE ROLE whereas_app" in sql

    def test_migration_0005_frozen_list_matches_builder_output(self) -> None:
        # The frozen list in alembic/versions/0005_* must stay renderable:
        # every table it names has a policy builder entry.
        frozen_0005 = (
            "contracts",
            "extracted_fields",
            "clauses",
            "playbooks",
            "deviation_findings",
            "playbook_review_runs",
            "audit_events",
            "users",
        )
        sql = build_full_migration_sql(tables=frozen_0005)
        for table in frozen_0005:
            assert f"{table}_tenant_isolation" in sql
        # And nothing beyond the frozen set leaks in.
        for table in set(TENANT_SCOPED_TABLES) - set(frozen_0005):
            assert f"{table}_tenant_isolation" not in sql
