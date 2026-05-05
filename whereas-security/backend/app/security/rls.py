"""Row-Level Security policies for Whereas.

This module emits the SQL needed to enable RLS on every tenant-scoped table.
It runs as part of the Alembic migration; the SQL is kept here as a single
source of truth so the policies are reviewable as code.

The application layer is the primary mechanism for authorization. RLS is the
secondary defense: even if a query is missing its `WHERE organization_id = :id`
clause, Postgres will still filter the rows.

How it works:
  - On every request, the application sets a session variable:
        SET LOCAL app.current_organization_id = '<uuid>';
  - Every RLS policy evaluates against that variable.
  - If the variable is unset (e.g., misconfigured query), the policy returns
    no rows. Fail closed.

Important: RLS policies are bypassed for table owners. The application MUST
connect as a non-owner role. The migration creates an `app_user` role that
the backend uses; never use the `postgres` superuser at runtime.
"""

# All tables that hold tenant-scoped data. If you add a new tenant-scoped
# table, list it here AND write a policy for it. Failing to do so silently
# leaks data across orgs.
TENANT_SCOPED_TABLES = [
    "contracts",
    "extracted_fields",  # via contract_id -> contracts.organization_id
    "clauses",  # via contract_id -> contracts.organization_id
    "playbooks",
    "deviation_findings",  # via contract_id -> contracts.organization_id
    "audit_events",
    "users",
]


# SQL to enable RLS and set up the application role. Idempotent.
ENABLE_RLS_SQL = """
-- Create the application role if it doesn't exist. The backend connects as
-- this role; RLS policies apply because it's not the table owner.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whereas_app') THEN
        CREATE ROLE whereas_app NOLOGIN;
    END IF;
END $$;

-- Allow the app role to use the public schema and read/write tables.
GRANT USAGE ON SCHEMA public TO whereas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO whereas_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO whereas_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO whereas_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO whereas_app;
"""


# Policy for tables with a direct organization_id column.
def policy_direct_org_id(table: str) -> str:
    return f"""
ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
CREATE POLICY {table}_tenant_isolation ON {table}
    USING (organization_id = current_setting('app.current_organization_id', true)::uuid)
    WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
"""


# Policy for tables that join through contracts to an org.
# `contracts.organization_id` is the tenant key; we filter via subquery.
def policy_via_contract(table: str) -> str:
    return f"""
ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
CREATE POLICY {table}_tenant_isolation ON {table}
    USING (
        contract_id IN (
            SELECT id FROM contracts
            WHERE organization_id = current_setting('app.current_organization_id', true)::uuid
        )
    )
    WITH CHECK (
        contract_id IN (
            SELECT id FROM contracts
            WHERE organization_id = current_setting('app.current_organization_id', true)::uuid
        )
    );
"""


def build_full_migration_sql() -> str:
    """Generate the full SQL block for the Alembic migration."""
    parts = [ENABLE_RLS_SQL]
    direct_org_tables = ["contracts", "playbooks", "audit_events", "users"]
    via_contract_tables = ["extracted_fields", "clauses", "deviation_findings"]

    for t in direct_org_tables:
        parts.append(policy_direct_org_id(t))
    for t in via_contract_tables:
        parts.append(policy_via_contract(t))
    return "\n".join(parts)


# Application-side helper: must be called at the start of every request after
# the user is authenticated. Sets the session variable that the policies key off.
SET_TENANT_CONTEXT_SQL = "SELECT set_config('app.current_organization_id', :org_id, true);"
