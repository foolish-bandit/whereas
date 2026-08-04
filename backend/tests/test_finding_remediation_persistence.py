"""Persistence and RLS contract for finding remediation tasks."""
from __future__ import annotations

import importlib.util
from pathlib import Path

from sqlalchemy import UniqueConstraint

from app.models.finding_remediation import FindingRemediationTask
from app.security.rls import TENANT_SCOPED_TABLES


MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "alembic"
    / "versions"
    / "0020_finding_remediation_tasks.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "migration_0020_finding_remediation_tasks", MIGRATION_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_revision_chain_extends_current_head() -> None:
    migration = _load_migration()
    assert migration.revision == "0020_finding_remediation_tasks"
    assert migration.down_revision == "0019_rls_backfill_0006_0017"


def test_remediation_task_table_has_typed_links_and_safe_provenance() -> None:
    table = FindingRemediationTask.__table__
    assert table.name == "finding_remediation_tasks"
    assert {
        "id",
        "organization_id",
        "finding_id",
        "inbox_item_id",
        "language_source_type",
        "language_source_id",
        "created_at",
        "updated_at",
        "created_by",
    }.issubset(table.c.keys())

    finding_fk = next(iter(table.c.finding_id.foreign_keys))
    inbox_fk = next(iter(table.c.inbox_item_id.foreign_keys))
    assert finding_fk.target_fullname == "deviation_findings.id"
    assert finding_fk.ondelete == "SET NULL"
    assert inbox_fk.target_fullname == "inbox_items.id"
    assert inbox_fk.ondelete == "CASCADE"

    unique_names = {
        constraint.name
        for constraint in table.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert "uq_finding_remediation_tasks_org_finding" in unique_names
    assert "uq_finding_remediation_tasks_inbox_item" in unique_names


def test_remediation_task_table_is_in_the_rls_registry() -> None:
    assert "finding_remediation_tasks" in TENANT_SCOPED_TABLES


def test_migration_freezes_new_table_into_rls_policy_set() -> None:
    source = MIGRATION_PATH.read_text(encoding="utf-8")
    assert '"finding_remediation_tasks"' in source
    assert "build_full_migration_sql" in source
    assert "DROP POLICY IF EXISTS finding_remediation_tasks_tenant_isolation" in source
