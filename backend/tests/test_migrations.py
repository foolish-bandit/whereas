"""Tests for the Alembic migration pipeline.

These run against a throwaway Postgres (with pgvector) spun up in a
Docker container by `testcontainers`. The container is created once
per test module and torn down at the end.

If Docker isn't reachable (CI without docker-in-docker, contributors
without Docker installed), the whole module skips. The migration
tests are not meant to be the gate for "is the codebase healthy" —
they're the gate for "did we break the migration." Skipping
gracefully keeps the broader suite green elsewhere.

What gets verified:
  - `alembic upgrade head` succeeds against a fresh database with the
    pgvector extension preloaded.
  - All expected tables (every ORM-defined table + audit_events) exist
    after upgrade.
  - `wrapped_master_key` exists on `organizations` as BYTEA, nullable.
  - The set of RLS policies present in `pg_policies` matches what
    `app.security.rls.build_full_migration_sql` is supposed to create.
  - `alembic downgrade base` drops every table created during upgrade.
  - The `vector` extension and `whereas_app` role survive downgrade
    (cluster-level resources we deliberately don't drop).
"""
from __future__ import annotations

import os
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

# Skip the whole module if testcontainers / docker isn't available.
# These imports are deliberately below the importorskip calls, so E402
# (imports not at top of file) doesn't apply — that's the whole point.
testcontainers = pytest.importorskip("testcontainers.postgres")
psycopg = pytest.importorskip("psycopg")

from testcontainers.postgres import PostgresContainer  # noqa: E402

from app.security.rls import TENANT_SCOPED_TABLES  # noqa: E402

# pgvector/pgvector ships an image with the `vector` extension already
# available in `shared_preload_libraries`. We pin a Postgres major to
# keep image pulls deterministic — bumping is a deliberate review.
_PG_IMAGE = "pgvector/pgvector:pg16"

# All tables the genesis migration is supposed to create. Mirrors
# _CREATE_ORDER in 0001_initial_schema, kept here as a separate
# source of truth so a missing table in the migration would fail
# the assertion, not silently match.
_EXPECTED_TABLES: frozenset[str] = frozenset(
    {
        "organizations",
        "playbooks",
        "users",
        "audit_events",
        "contracts",
        "clauses",
        "extracted_fields",
        "deviation_findings",
        "playbook_review_runs",
        "suggested_redlines",
    }
)

# The RLS policies the migration is supposed to install. One per
# tenant-scoped table, named `{table}_tenant_isolation` per
# `app.security.rls`.
_EXPECTED_POLICIES: frozenset[str] = frozenset(
    f"{t}_tenant_isolation" for t in TENANT_SCOPED_TABLES
)


def _backend_dir() -> Path:
    """Path to the backend/ directory (where alembic.ini lives)."""
    return Path(__file__).resolve().parents[1]


def _docker_available() -> bool:
    """True iff the Docker daemon is reachable.

    testcontainers will raise during container start if it isn't, but
    surfacing the skip at collection/setup time is clearer in the
    pytest output than an opaque traceback from a fixture.
    """
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=5,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


@pytest.fixture(scope="module")
def postgres_container() -> Iterator[PostgresContainer]:
    """Start a pgvector-enabled Postgres for the whole module.

    The container's startup is the slow bit (image pull + boot), so
    we share it across tests in this module. Each test still works
    against a clean schema by issuing `alembic downgrade base` then
    `upgrade head` — much cheaper than a fresh container per test.
    """
    if not _docker_available():
        pytest.skip("Docker daemon not reachable; skipping migration tests")
    container = PostgresContainer(_PG_IMAGE)
    container.start()
    try:
        yield container
    finally:
        container.stop()


def _container_async_url(container: PostgresContainer) -> str:
    """Build an asyncpg-shaped URL for the running container.

    env.py converts this to psycopg at migration time, so we hand
    Alembic the same URL shape the application uses.
    """
    # testcontainers exposes a sync URL; rewrite the dialect to match
    # what the application's Settings.DATABASE_URL would carry.
    sync_url = container.get_connection_url()
    if sync_url.startswith("postgresql+psycopg2://"):
        return sync_url.replace(
            "postgresql+psycopg2://", "postgresql+asyncpg://", 1
        )
    if sync_url.startswith("postgresql://"):
        return sync_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return sync_url


def _run_alembic(
    container: PostgresContainer, *args: str
) -> subprocess.CompletedProcess[str]:
    """Invoke alembic with the container's URL via -x dburl=...

    Running as a subprocess (rather than alembic.command) keeps the
    test's own Settings cache out of the migration's resolution path
    and matches how operators invoke alembic in production.
    """
    backend = _backend_dir()
    env = os.environ.copy()
    # Settings still has to load — env.py imports app.core.config at
    # the top — but the actual URL it reads is overridden by -x dburl=.
    # Set placeholders for any required Settings fields that conftest
    # also provides for the rest of the suite.
    env.setdefault("SECRET_KEY", "test")
    env.setdefault("S3_ENDPOINT", "http://localhost:9000")
    env.setdefault("S3_ACCESS_KEY", "test")
    env.setdefault("S3_SECRET_KEY", "test")
    env.setdefault("DOCUSEAL_AUTH_BRIDGE_SECRET", "test")
    # DATABASE_URL is required by Settings even though -x dburl wins.
    env["DATABASE_URL"] = _container_async_url(container)
    return subprocess.run(
        [
            "alembic",
            "-x",
            f"dburl={_container_async_url(container)}",
            *args,
        ],
        cwd=backend,
        capture_output=True,
        text=True,
        check=False,
        env=env,
        timeout=120,
    )


def _psycopg_url(container: PostgresContainer) -> str:
    """A direct psycopg URL for verification queries from tests."""
    sync_url = container.get_connection_url()
    if sync_url.startswith("postgresql+psycopg2://"):
        return sync_url.replace("postgresql+psycopg2://", "postgresql://", 1)
    return sync_url


@pytest.fixture
def upgraded_db(postgres_container: PostgresContainer) -> Iterator[PostgresContainer]:
    """Yields the container with `alembic upgrade head` applied.

    Each test that uses this fixture gets a clean upgrade. Downgrade
    after the test keeps subsequent tests independent without paying
    for a fresh container.
    """
    result = _run_alembic(postgres_container, "upgrade", "head")
    assert result.returncode == 0, (
        f"alembic upgrade head failed: stderr=\n{result.stderr}\n"
        f"stdout=\n{result.stdout}"
    )
    try:
        yield postgres_container
    finally:
        _run_alembic(postgres_container, "downgrade", "base")


def test_upgrade_head_creates_expected_tables(
    upgraded_db: PostgresContainer,
) -> None:
    """Every ORM-defined table is present after upgrade head."""
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
        )
        present = {row[0] for row in cur.fetchall()}
    missing = _EXPECTED_TABLES - present
    assert not missing, f"Migration did not create tables: {missing}"


def test_wrapped_master_key_column_shape(
    upgraded_db: PostgresContainer,
) -> None:
    """`organizations.wrapped_master_key` is BYTEA and nullable."""
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT data_type, is_nullable
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'organizations'
               AND column_name = 'wrapped_master_key'
            """
        )
        row = cur.fetchone()
    assert row is not None, "wrapped_master_key column is missing"
    data_type, is_nullable = row
    assert data_type == "bytea", f"expected bytea, got {data_type!r}"
    assert is_nullable == "YES", "wrapped_master_key should be nullable"


def test_contract_wrapped_dek_column_shape(
    upgraded_db: PostgresContainer,
) -> None:
    """`contracts.wrapped_dek` is BYTEA and nullable for existing rows."""
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT data_type, is_nullable
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'contracts'
               AND column_name = 'wrapped_dek'
            """
        )
        row = cur.fetchone()
    assert row is not None, "wrapped_dek column is missing"
    data_type, is_nullable = row
    assert data_type == "bytea", f"expected bytea, got {data_type!r}"
    assert is_nullable == "YES", "wrapped_dek should be nullable"


def test_clauses_segmentation_columns_present(
    upgraded_db: PostgresContainer,
) -> None:
    """Migration 0003 reshapes clauses for the v1 segmentation pipeline.

    Verifies the load-bearing additions are NOT NULL where the ORM
    declares them so a developer who only ran a partial migration
    catches the divergence here rather than at runtime.
    """
    expected = {
        "organization_id": ("uuid", "NO"),
        "ordinal": ("integer", "NO"),
        "heading": ("character varying", "YES"),
        "clause_type": ("character varying", "YES"),
        "clause_type_source": ("character varying", "YES"),
        "confidence": ("double precision", "YES"),
        "segmentation_method": ("character varying", "NO"),
        "model_name": ("character varying", "YES"),
        "prompt_version": ("character varying", "YES"),
        "updated_at": ("timestamp with time zone", "NO"),
    }
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, data_type, is_nullable
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'clauses'
            """
        )
        rows = {row[0]: (row[1], row[2]) for row in cur.fetchall()}
    for column, (expected_type, expected_nullable) in expected.items():
        assert column in rows, f"clauses.{column} missing"
        data_type, is_nullable = rows[column]
        assert data_type == expected_type, (
            f"clauses.{column}: expected type {expected_type!r}, "
            f"got {data_type!r}"
        )
        assert is_nullable == expected_nullable, (
            f"clauses.{column}: expected is_nullable={expected_nullable!r}, "
            f"got {is_nullable!r}"
        )

    # The legacy classification_confidence column is gone (renamed to
    # confidence by 0003). Catching its lingering presence here would
    # signal a botched migration on a developer's machine.
    assert "classification_confidence" not in rows


def test_clauses_unique_contract_ordinal_constraint(
    upgraded_db: PostgresContainer,
) -> None:
    """`uq_clauses_contract_ordinal` exists so ordinals are stable per contract."""
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT conname
              FROM pg_constraint
             WHERE conrelid = 'public.clauses'::regclass
               AND contype = 'u'
            """
        )
        names = {row[0] for row in cur.fetchall()}
    assert "uq_clauses_contract_ordinal" in names


def test_playbook_metadata_columns_present(
    upgraded_db: PostgresContainer,
) -> None:
    """Migration 0004 adds jurisdiction, contract_type, version to playbooks.

    `version` is NOT NULL with a default of '1.0'; the other two are
    nullable since most playbooks won't carry a jurisdiction.
    """
    expected = {
        "jurisdiction": ("character varying", "YES"),
        "contract_type": ("character varying", "YES"),
        "version": ("character varying", "NO"),
    }
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, data_type, is_nullable
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'playbooks'
            """
        )
        rows = {row[0]: (row[1], row[2]) for row in cur.fetchall()}
    for column, (expected_type, expected_nullable) in expected.items():
        assert column in rows, f"playbooks.{column} missing"
        data_type, is_nullable = rows[column]
        assert data_type == expected_type, (
            f"playbooks.{column}: expected type {expected_type!r}, "
            f"got {data_type!r}"
        )
        assert is_nullable == expected_nullable, (
            f"playbooks.{column}: expected is_nullable={expected_nullable!r}, "
            f"got {is_nullable!r}"
        )


def test_playbook_indexes_present(upgraded_db: PostgresContainer) -> None:
    """Migration 0004 adds composite indexes for the playbook lookup paths."""
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT indexname
              FROM pg_indexes
             WHERE schemaname = 'public'
               AND tablename = 'playbooks'
            """
        )
        names = {row[0] for row in cur.fetchall()}
    expected = {
        "ix_playbooks_organization_id",
        "ix_playbooks_org_name",
        "ix_playbooks_org_active",
    }
    missing = expected - names
    assert not missing, f"Missing playbook indexes: {missing}"


def test_deviation_findings_columns_present(
    upgraded_db: PostgresContainer,
) -> None:
    """Migration 0005 reshapes deviation_findings for persisted determinism.

    The legacy LLM-oriented columns (``title``, ``explanation``,
    ``suggested_redline``, ``model_name``, ``confidence``,
    ``dismissed*``) are gone; the new columns the persistence service
    relies on must all be present with the right nullability.
    """
    expected = {
        "organization_id": ("uuid", "NO"),
        "contract_id": ("uuid", "NO"),
        "playbook_id": ("uuid", "NO"),
        "review_run_id": ("uuid", "NO"),
        "rule_id": ("character varying", "NO"),
        "rule_title": ("character varying", "NO"),
        "rule_type": ("character varying", "NO"),
        "clause_type": ("character varying", "NO"),
        "severity": ("character varying", "NO"),
        "status": ("character varying", "NO"),
        "finding_status": ("character varying", "NO"),
        "message": ("text", "NO"),
        "clause_id": ("uuid", "YES"),
        "evidence_text": ("text", "YES"),
        "span_start": ("integer", "YES"),
        "span_end": ("integer", "YES"),
        "expected_value": ("text", "YES"),
        "guidance": ("text", "YES"),
        "preferred_language": ("text", "YES"),
        "created_at": ("timestamp with time zone", "NO"),
        "updated_at": ("timestamp with time zone", "NO"),
    }
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, data_type, is_nullable
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'deviation_findings'
            """
        )
        rows = {row[0]: (row[1], row[2]) for row in cur.fetchall()}
    for column, (expected_type, expected_nullable) in expected.items():
        assert column in rows, f"deviation_findings.{column} missing"
        data_type, is_nullable = rows[column]
        assert data_type == expected_type, (
            f"deviation_findings.{column}: expected type {expected_type!r}, "
            f"got {data_type!r}"
        )
        assert is_nullable == expected_nullable, (
            f"deviation_findings.{column}: expected is_nullable={expected_nullable!r}, "
            f"got {is_nullable!r}"
        )

    # Legacy columns are gone.
    for legacy in (
        "title",
        "explanation",
        "suggested_redline",
        "model_name",
        "confidence",
        "dismissed",
        "dismissed_by",
        "dismissed_reason",
    ):
        assert legacy not in rows, (
            f"legacy column deviation_findings.{legacy} survived migration 0005"
        )


def test_deviation_findings_indexes_present(
    upgraded_db: PostgresContainer,
) -> None:
    """Migration 0005 creates the indexes the API list paths use."""
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT indexname
              FROM pg_indexes
             WHERE schemaname = 'public'
               AND tablename = 'deviation_findings'
            """
        )
        names = {row[0] for row in cur.fetchall()}
    expected = {
        "ix_deviation_findings_organization_id",
        "ix_deviation_findings_contract_id",
        "ix_deviation_findings_playbook_id",
        "ix_deviation_findings_contract_playbook",
        "ix_deviation_findings_contract_status",
        "ix_deviation_findings_review_run_id",
        "ix_deviation_findings_severity",
    }
    missing = expected - names
    assert not missing, f"Missing deviation_findings indexes: {missing}"


def test_playbook_review_runs_columns_and_indexes_present(
    upgraded_db: PostgresContainer,
) -> None:
    """Migration 0005 creates playbook_review_runs with the expected shape."""
    expected = {
        "id": ("uuid", "NO"),
        "organization_id": ("uuid", "NO"),
        "contract_id": ("uuid", "NO"),
        "playbook_id": ("uuid", "NO"),
        "rules_checked": ("integer", "NO"),
        "failed_count": ("integer", "NO"),
        "passed_count": ("integer", "NO"),
        "created_at": ("timestamp with time zone", "NO"),
    }
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name, data_type, is_nullable
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'playbook_review_runs'
            """
        )
        rows = {row[0]: (row[1], row[2]) for row in cur.fetchall()}
    for column, (expected_type, expected_nullable) in expected.items():
        assert column in rows, f"playbook_review_runs.{column} missing"
        data_type, is_nullable = rows[column]
        assert data_type == expected_type, (
            f"playbook_review_runs.{column}: expected type {expected_type!r}, "
            f"got {data_type!r}"
        )
        assert is_nullable == expected_nullable, (
            f"playbook_review_runs.{column}: "
            f"expected is_nullable={expected_nullable!r}, got {is_nullable!r}"
        )

    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT indexname
              FROM pg_indexes
             WHERE schemaname = 'public'
               AND tablename = 'playbook_review_runs'
            """
        )
        names = {row[0] for row in cur.fetchall()}
    expected_indexes = {
        "ix_playbook_review_runs_org",
        "ix_playbook_review_runs_contract",
        "ix_playbook_review_runs_contract_playbook",
        "ix_playbook_review_runs_created_at",
    }
    missing = expected_indexes - names
    assert not missing, f"Missing playbook_review_runs indexes: {missing}"


def test_rls_policies_match_spec(upgraded_db: PostgresContainer) -> None:
    """`pg_policies` after upgrade matches what rls.py says it created.

    If a future change adds a tenant-scoped table without updating
    `TENANT_SCOPED_TABLES`, or vice versa, this test catches the drift.
    """
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute("SELECT policyname FROM pg_policies WHERE schemaname = 'public'")
        present = {row[0] for row in cur.fetchall()}
    missing = _EXPECTED_POLICIES - present
    extra = present - _EXPECTED_POLICIES
    assert not missing, f"Missing RLS policies: {missing}"
    assert not extra, f"Unexpected RLS policies: {extra}"


def test_pgvector_extension_enabled(upgraded_db: PostgresContainer) -> None:
    """`vector` extension is available — clauses.embedding needs it."""
    with psycopg.connect(_psycopg_url(upgraded_db)) as conn, conn.cursor() as cur:
        cur.execute("SELECT extname FROM pg_extension WHERE extname = 'vector'")
        row = cur.fetchone()
    assert row is not None, "vector extension was not enabled by upgrade"


def test_downgrade_base_drops_all_tables(
    postgres_container: PostgresContainer,
) -> None:
    """`alembic downgrade base` drops every table the upgrade created.

    The vector extension and whereas_app role are intentionally
    preserved by downgrade (they're cluster-level), so this only
    checks tables.
    """
    upgrade = _run_alembic(postgres_container, "upgrade", "head")
    assert upgrade.returncode == 0, upgrade.stderr

    downgrade = _run_alembic(postgres_container, "downgrade", "base")
    assert downgrade.returncode == 0, (
        f"downgrade base failed: stderr=\n{downgrade.stderr}\n"
        f"stdout=\n{downgrade.stdout}"
    )

    with psycopg.connect(_psycopg_url(postgres_container)) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
        )
        present = {row[0] for row in cur.fetchall()}

    leftover = _EXPECTED_TABLES & present
    assert not leftover, f"Tables not dropped on downgrade: {leftover}"


def test_downgrade_preserves_cluster_resources(
    postgres_container: PostgresContainer,
) -> None:
    """vector extension and whereas_app role survive downgrade base.

    These are deliberately not dropped — see the migration's downgrade
    docstring. Other databases on the same Postgres cluster may rely
    on them.
    """
    _run_alembic(postgres_container, "upgrade", "head")
    _run_alembic(postgres_container, "downgrade", "base")

    with psycopg.connect(_psycopg_url(postgres_container)) as conn, conn.cursor() as cur:
        cur.execute("SELECT extname FROM pg_extension WHERE extname = 'vector'")
        assert cur.fetchone() is not None, "vector extension was dropped"
        cur.execute("SELECT rolname FROM pg_roles WHERE rolname = 'whereas_app'")
        assert cur.fetchone() is not None, "whereas_app role was dropped"
