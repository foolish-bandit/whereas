# Database migrations

Alembic configuration and conventions for Whereas.

All commands below run from `backend/` (where `alembic.ini` lives):

```
cd backend
```

## Creating a new migration

```
alembic revision --autogenerate -m "short description"
```

This produces a new file under `alembic/versions/`. **Review and edit
the generated file before committing.** Autogenerate is good but
imperfect; in particular it can miss:

- Column comments (`comment="..."`)
- Server defaults that aren't trivially `func.now()`
- pgvector columns (`Vector(N)`) — make sure `from pgvector.sqlalchemy
  import Vector` is present in the revision file
- CHECK constraints
- Custom index types (GIN, GiST, IVFFlat)

Treat autogenerate's output as a starting point, not a contract.

### Naming new revisions

We use **sequential numeric prefixes**, not Alembic's default UUID-style
revision IDs. The next migration after `0001_initial_schema` is
`0002_<something>`, then `0003_<something>`, and so on.

After running `alembic revision --autogenerate`, rename the generated
file and edit the revision identifier inside it to match:

```python
revision: str = "0002_add_users_mfa"
down_revision: Union[str, Sequence[str], None] = "0001_initial_schema"
```

Why: a hash-only history forces `git log` divers to translate hashes
into intent. `0001`, `0002`, `0003` is human-readable in `ls
versions/`, and the chain order is obvious without running `alembic
history`.

The `file_template = %(rev)s` setting in `alembic.ini` makes the
filename match the revision ID exactly, so `0002_add_users_mfa` lives
in `alembic/versions/0002_add_users_mfa.py`.

## Applying migrations

```
alembic upgrade head            # bring DB to the latest revision
alembic upgrade <rev>           # bring DB to a specific revision
alembic downgrade -1            # back out the most recent revision
alembic downgrade <rev>         # roll back to a specific revision
alembic upgrade head --sql      # emit SQL without executing (for ops review)
```

## Driver story (asyncpg vs psycopg)

The application connects with **asyncpg** (the async driver) for the
request path. Alembic is sync-only, so it connects with **psycopg**
(v3, the modern sync driver). Both speak the same Postgres wire
protocol against the same database — they're just different Python
clients.

`alembic/env.py` reads `Settings.DATABASE_URL` (which is shaped as
`postgresql+asyncpg://...`) and rewrites the dialect to
`postgresql+psycopg://...` at runtime. There is no separate
configuration for migrations; one URL, two drivers.

## Migrations are NOT run on app startup

`docker compose up` does **not** auto-migrate. Operators must run
`alembic upgrade head` explicitly as part of deployment.

Why this rule:

- Multiple replicas booting simultaneously would each try to run
  `upgrade head`, racing on `alembic_version` and risking partial
  application or deadlock.
- Migrations belong to the deploy pipeline, where they can be paused,
  reviewed, and rolled back. Tying them to process startup hides
  failures and couples blast radius to ordinary restarts.
- The startup hook in `app/main.py` performs only a connectivity
  probe (`SELECT 1` with a 5-second timeout); it does not invoke
  Alembic.

In Docker Compose deployments, run migrations as a one-shot service
that exits after success, before the long-running API service starts.
In Kubernetes, run them as an init container or a `Job`. The README at
the repo root has a worked example.

## Why the migration runs the RLS SQL

The genesis migration calls `app.security.rls.build_full_migration_sql()`
after creating tables. RLS without tables is meaningless; tables
without RLS leak data across orgs by default. Keeping both in the
same atomic migration means there is no window where the schema
exists but the policies don't.

When a future migration adds a tenant-scoped table:

1. Add it to `TENANT_SCOPED_TABLES` and the appropriate
   `_DIRECT_ORG_TABLES` / `_INDIRECT_ORG_TABLES` tuple in
   `app/security/rls.py`.
2. In the same migration that creates the table, call
   `op.execute(build_full_migration_sql())` to (re-)apply the policy
   set. The RLS SQL is idempotent (`DROP POLICY IF EXISTS` + recreate),
   so re-running it is safe.

## Connecting as `whereas_app` is a follow-up

The genesis migration creates the `whereas_app` Postgres role and the
RLS policies, but the application still connects with the database
owner role. RLS engagement for app traffic is a follow-up PR — it
requires:

- Switching the app's connection string to use `whereas_app`
- Setting `app.current_organization_id` per request via
  `SET_TENANT_CONTEXT_SQL` (already defined in `app/security/rls.py`)
- Auditing every query path under the constrained role

Until that lands, RLS is configured but not enforcing for the app.
