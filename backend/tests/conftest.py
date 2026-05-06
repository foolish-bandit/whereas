"""Shared pytest configuration.

Some app modules (anything that touches `app.core.database.Base`) load
`Settings` at import time, which means importing them during pytest
collection requires the env vars `Settings` declares as required to be
present. In real environments those come from `.env` or the orchestrator;
for tests we set safe defaults below so collection never depends on the
caller's shell.

Tests that need to assert behavior under missing or malformed env vars use
`monkeypatch.delenv` / `monkeypatch.setenv` to override these defaults for
the test's duration; pytest's monkeypatch unwinds on teardown. So this
file is a floor, not a ceiling.
"""
import os

# `setdefault` so a real env (CI, dev shell) wins over these placeholders.
os.environ.setdefault("SECRET_KEY", "test-secret-not-for-prod")
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/whereas_test",
)
os.environ.setdefault("S3_ENDPOINT", "http://localhost:9000")
os.environ.setdefault("S3_ACCESS_KEY", "test")
os.environ.setdefault("S3_SECRET_KEY", "test")
os.environ.setdefault("DOCUSEAL_AUTH_BRIDGE_SECRET", "test-docuseal-bridge-secret")
