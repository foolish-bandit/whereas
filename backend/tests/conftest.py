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

import pytest

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


@pytest.fixture(autouse=True)
def _reset_rate_limiter() -> None:
    """Clear the app-wide rate limiter's in-memory ledger before each test.

    ``app.security.rate_limit.limiter`` is a process-wide singleton with
    in-memory storage. Every test in the suite hits the API through the
    same loopback address (the ASGI test transport), so without a reset
    between tests, request counts would accumulate across the whole
    session and unrelated tests would start tripping the upload/default
    rate limits. Tests that specifically exercise rate limiting (see
    ``test_rate_limit.py``) still work: this only resets counters, it
    doesn't change the configured limits.
    """
    from app.security.rate_limit import limiter

    limiter.reset()
