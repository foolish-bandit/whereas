"""Postgres Row-Level Security policy generator.

What this enforces:
  Every tenant-scoped table only returns rows belonging to the
  organization currently bound to the session. The binding is the
  `app.current_organization_id` setting, which is populated by the
  request handler via `SET_TENANT_CONTEXT_SQL` at the start of each
  request's session.

Why RLS in addition to query filters:
  Application-layer filters work as long as every query remembers them.
  RLS makes the database refuse to return cross-tenant rows even if a
  query is missing the filter, an ORM mistake leaks one, or a bug
  accidentally constructs a join that crosses orgs. It's a defense in
  depth, not a replacement for explicit tenancy filtering.

Two flavors of policy:
  - "Direct": the table has its own `organization_id` column and the
    policy compares it to the session setting.
  - "Indirect": the table reaches the org through `contracts.id` and
    the policy uses an EXISTS-style subquery into `contracts`.

Why FORCE ROW LEVEL SECURITY:
  Without FORCE, the table owner bypasses RLS. Whereas's app connection
  would commonly be the owner during local dev / Alembic-managed schemas,
  so without FORCE the policies would be silently inert. FORCE makes
  them apply universally except for superusers (and we don't run the app
  as a superuser).

This module builds the migration SQL string. Running it lives in the
Alembic migration that follows; we don't execute SQL from here.
"""
from __future__ import annotations

# --------------------------------------------------------------------------
# Public configuration
# --------------------------------------------------------------------------


# Every tenant-scoped table in Whereas's schema. Order matters only for
# readability; the SQL produced below applies policies in the same order.
TENANT_SCOPED_TABLES: list[str] = [
    "contracts",
    "extracted_fields",
    "clauses",
    "playbooks",
    "deviation_findings",
    "playbook_review_runs",
    "audit_events",
    "users",
]


# Tables that carry an `organization_id` column directly. Their policies
# compare that column against the session setting.
#
# `deviation_findings` and `playbook_review_runs` are direct-org as of
# the persisted-findings migration: both carry `organization_id` so the
# policy reads cleanly without an EXISTS subquery on `contracts`.
_DIRECT_ORG_TABLES: tuple[str, ...] = (
    "contracts",
    "playbooks",
    "deviation_findings",
    "playbook_review_runs",
    "audit_events",
    "users",
)


# Tables that reach the org through `contracts.id`. Their policies use
# `contract_id IN (SELECT id FROM contracts WHERE org matches)`.
_INDIRECT_ORG_TABLES: tuple[str, ...] = (
    "extracted_fields",
    "clauses",
)


# Per-request session-variable bind. The third arg `true` to set_config
# scopes the value to the current transaction so it does not leak across
# pooled connections.
SET_TENANT_CONTEXT_SQL = (
    "SELECT set_config('app.current_organization_id', :org_id, true);"
)


# --------------------------------------------------------------------------
# SQL fragment builders
# --------------------------------------------------------------------------


def _create_role_sql() -> str:
    """Idempotently create the `whereas_app` role.

    NOLOGIN by design: the actual application login role is a member of
    whereas_app. That separation lets ops rotate the login credential
    without touching policy.
    """
    return (
        "DO $$\n"
        "BEGIN\n"
        "    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whereas_app') THEN\n"
        "        CREATE ROLE whereas_app NOLOGIN;\n"
        "    END IF;\n"
        "END $$;\n"
    )


def _grant_sql() -> str:
    """Grants CRUD on all current and future tables/sequences in `public`.

    `ALTER DEFAULT PRIVILEGES` is the load-bearing piece for future
    tables — without it, every new migration would have to re-grant.
    """
    return (
        "GRANT USAGE ON SCHEMA public TO whereas_app;\n"
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public "
        "TO whereas_app;\n"
        "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO whereas_app;\n"
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public\n"
        "    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO whereas_app;\n"
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public\n"
        "    GRANT USAGE, SELECT ON SEQUENCES TO whereas_app;\n"
    )


def _direct_policy_sql(table: str) -> str:
    """Policy for a table with its own `organization_id` column."""
    policy = f"{table}_tenant_isolation"
    org_match = (
        "organization_id = current_setting('app.current_organization_id', true)::uuid"
    )
    return (
        f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;\n"
        f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;\n"
        f"DROP POLICY IF EXISTS {policy} ON {table};\n"
        f"CREATE POLICY {policy} ON {table}\n"
        f"    USING ({org_match})\n"
        f"    WITH CHECK ({org_match});\n"
    )


def _indirect_policy_sql(table: str) -> str:
    """Policy for a table that reaches the org through `contracts.id`."""
    policy = f"{table}_tenant_isolation"
    contract_match = (
        "contract_id IN (\n"
        "        SELECT id FROM contracts\n"
        "        WHERE organization_id = "
        "current_setting('app.current_organization_id', true)::uuid\n"
        "    )"
    )
    return (
        f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;\n"
        f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;\n"
        f"DROP POLICY IF EXISTS {policy} ON {table};\n"
        f"CREATE POLICY {policy} ON {table}\n"
        f"    USING ({contract_match})\n"
        f"    WITH CHECK ({contract_match});\n"
    )


# --------------------------------------------------------------------------
# Public assembly
# --------------------------------------------------------------------------


def build_full_migration_sql() -> str:
    """Return the full RLS migration SQL as a single string.

    The output is safe to re-run: role creation is gated on existence,
    GRANTs are idempotent, ENABLE/FORCE RLS are idempotent, and policies
    are dropped before being recreated.
    """
    parts: list[str] = [_create_role_sql(), _grant_sql()]
    for table in _DIRECT_ORG_TABLES:
        parts.append(_direct_policy_sql(table))
    for table in _INDIRECT_ORG_TABLES:
        parts.append(_indirect_policy_sql(table))
    return "\n".join(parts)
