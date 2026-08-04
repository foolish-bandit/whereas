from __future__ import annotations

import importlib.util
import re
from pathlib import Path

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


def test_revision_chain_is_linear() -> None:
    migration = _load_migration()
    assert migration.revision == "0020_finding_remediation_tasks"
    assert migration.down_revision == "0019_rls_backfill_0006_0017"


def test_migration_creates_typed_one_to_one_link_and_rls() -> None:
    source = MIGRATION_PATH.read_text(encoding="utf-8")

    assert '"finding_remediation_tasks"' in source
    assert 'ForeignKey("deviation_findings.id", ondelete="CASCADE")' in source
    assert 'ForeignKey("inbox_items.id", ondelete="CASCADE")' in source
    assert re.search(
        r'UniqueConstraint\(\s*"organization_id",\s*"finding_id"', source
    )
    assert re.search(r'UniqueConstraint\(\s*"inbox_item_id"', source)
    assert "finding_remediation_tasks_tenant_isolation" in source
    assert "ENABLE ROW LEVEL SECURITY" in source
    assert "FORCE ROW LEVEL SECURITY" in source


def test_downgrade_drops_policy_before_table() -> None:
    source = MIGRATION_PATH.read_text(encoding="utf-8")
    policy_pos = source.index("DROP POLICY IF EXISTS")
    table_pos = source.rindex('drop_table("finding_remediation_tasks")')
    assert policy_pos < table_pos
