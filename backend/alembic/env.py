"""Alembic environment script.

Resolves the database URL from `app.core.config.get_settings()` at
runtime so there is no duplicate connection-string source of truth, and
converts the async URL the application uses (`postgresql+asyncpg://`)
to the sync URL Alembic needs (`postgresql+psycopg://`). The two
drivers can talk to the same Postgres; only the Python-side wire format
differs.

Why import every model module here:
  Alembic's `target_metadata = Base.metadata` only knows about tables
  whose model classes have been imported. If a model module isn't
  imported before `context.configure()`, autogenerate will silently
  miss its tables. Listing the imports explicitly makes the surface
  visible.

Transactional DDL:
  We set `transaction_per_migration=True`. Postgres supports
  transactional DDL for CREATE TABLE/EXTENSION/ROLE/POLICY, so the
  whole migration commits atomically or not at all. Mixed with our
  IF-NOT-EXISTS guards in the RLS SQL, this means re-runs are safe
  and partial failures don't leave the schema in an in-between state.
  CREATE INDEX CONCURRENTLY (which can't run inside a transaction) is
  not used by any current migration; if a future migration needs it,
  set `transaction_per_migration=False` for that revision specifically.
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# Importing these registers every ORM model with `Base.metadata` so
# autogenerate can see them. Don't trim — silent dropouts are how
# tables disappear from migrations.
from app.core.config import get_settings
from app.core.database import Base
from app.models import (  # noqa: F401  (imported for side effects)
    Clause,
    Contract,
    DeviationFinding,
    ExtractedField,
    Organization,
    Playbook,
    User,
)
from app.security.audit_log import AuditEvent  # noqa: F401

# Alembic config object, providing access to the values within the
# .ini file in use.
config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _to_sync_url(async_url: str) -> str:
    """Map the application's async URL onto the sync driver Alembic needs.

    The application connects via asyncpg for the request path; Alembic
    is sync-only, so we swap to psycopg (v3). Both drivers speak the
    same Postgres wire protocol against the same database.
    """
    if async_url.startswith("postgresql+asyncpg://"):
        return async_url.replace(
            "postgresql+asyncpg://", "postgresql+psycopg://", 1
        )
    if async_url.startswith("postgresql://"):
        return async_url.replace("postgresql://", "postgresql+psycopg://", 1)
    # Already a known sync dialect (e.g., postgresql+psycopg://); pass through.
    return async_url


def _resolve_database_url() -> str:
    """Database URL precedence: -x dburl=... > Settings.DATABASE_URL.

    The `-x` override exists for the test suite, which spins up a
    throwaway Postgres container and points alembic at it without
    polluting the process's Settings. In normal operation this falls
    through to Settings.
    """
    x_args = context.get_x_argument(as_dictionary=True)
    if "dburl" in x_args:
        return _to_sync_url(x_args["dburl"])
    return _to_sync_url(get_settings().DATABASE_URL)


def run_migrations_offline() -> None:
    """Render migrations as SQL without connecting to a database.

    Used by `alembic upgrade head --sql` to emit a script for an ops
    team to apply manually. The URL is still required because some
    dialects (Postgres included) need it to pick the right SQL syntax.
    """
    url = _resolve_database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        transaction_per_migration=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Connect to the database and run migrations against it."""
    url = _resolve_database_url()

    # Build the engine config from alembic.ini's [alembic] section but
    # override the URL with our resolved one. This keeps any future
    # tunables (pool flags, etc.) configurable from the ini.
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = url

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            transaction_per_migration=True,
            # Render server defaults like func.now() faithfully.
            compare_server_default=True,
            # pgvector columns: keep their imports in revisions.
            render_as_batch=False,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
