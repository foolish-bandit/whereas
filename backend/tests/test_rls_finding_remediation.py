from app.security.rls import TENANT_SCOPED_TABLES, build_full_migration_sql


def test_head_state_rls_covers_finding_remediation_tasks() -> None:
    assert "finding_remediation_tasks" in TENANT_SCOPED_TABLES
    sql = build_full_migration_sql()
    assert "ALTER TABLE finding_remediation_tasks ENABLE ROW LEVEL SECURITY" in sql
    assert "CREATE POLICY finding_remediation_tasks_tenant_isolation" in sql
