"""Exhaustive tests for ``nango_client.verify_webhook``.

The Nango webhook receiver lives behind this verifier; if it accepts a
forged signature or a stale replay, an attacker can inject arbitrary
import events. The full matrix below is required by the
security-critical posture in CLAUDE.md (everything under
``backend/app/security/`` plus the webhook verifiers in services that
gate ingestion).
"""
from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime, timedelta

import pytest

from app.core.config import Settings
from app.services.nango_client import (
    NANGO_SIGNATURE_HEADER,
    WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    NangoWebhookVerificationError,
    verify_webhook,
)

_SECRET = "test-nango-webhook-secret-do-not-use-in-prod"  # noqa: S105
_BODY = b'{"event":"sync.completed"}'


def _settings(
    *,
    webhook_secret: str | None = _SECRET,
    environment: str = "production",
) -> Settings:
    return Settings(
        SECRET_KEY="test-secret",
        DATABASE_URL="postgresql+asyncpg://x/x",
        S3_ENDPOINT="http://minio:9000",
        S3_ACCESS_KEY="x",
        S3_SECRET_KEY="x",
        DOCUSEAL_AUTH_BRIDGE_SECRET="x",
        NANGO_WEBHOOK_SECRET=webhook_secret,
        ENVIRONMENT=environment,  # type: ignore[arg-type]
    )


def _sign(body: bytes, *, ts: int, secret: str = _SECRET) -> str:
    signed = f"{ts}.".encode("ascii") + body
    sig = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return f"{ts}.{sig}"


def _now() -> datetime:
    # Pinned so test signatures are deterministic regardless of CI clock.
    return datetime(2026, 5, 16, 12, 0, 0, tzinfo=UTC)


def test_valid_signature_passes() -> None:
    ts = int(_now().timestamp())
    header = _sign(_BODY, ts=ts)
    verify_webhook(
        headers={NANGO_SIGNATURE_HEADER: header},
        body=_BODY,
        settings=_settings(),
        now=_now(),
    )


def test_valid_signature_case_insensitive_header() -> None:
    ts = int(_now().timestamp())
    header = _sign(_BODY, ts=ts)
    verify_webhook(
        headers={"x-nango-signature": header},
        body=_BODY,
        settings=_settings(),
        now=_now(),
    )


def test_missing_secret_in_production_fails_closed() -> None:
    ts = int(_now().timestamp())
    header = _sign(_BODY, ts=ts)
    with pytest.raises(NangoWebhookVerificationError) as exc:
        verify_webhook(
            headers={NANGO_SIGNATURE_HEADER: header},
            body=_BODY,
            settings=_settings(webhook_secret=None),
            now=_now(),
        )
    assert exc.value.status_code == 503


def test_missing_secret_in_development_accepts() -> None:
    verify_webhook(
        headers={},
        body=_BODY,
        settings=_settings(webhook_secret=None, environment="development"),
        now=_now(),
    )


def test_missing_signature_header_rejected() -> None:
    with pytest.raises(NangoWebhookVerificationError):
        verify_webhook(
            headers={},
            body=_BODY,
            settings=_settings(),
            now=_now(),
        )


def test_malformed_header_no_dot_rejected() -> None:
    with pytest.raises(NangoWebhookVerificationError):
        verify_webhook(
            headers={NANGO_SIGNATURE_HEADER: "not-a-valid-signature"},
            body=_BODY,
            settings=_settings(),
            now=_now(),
        )


def test_malformed_header_empty_pieces_rejected() -> None:
    for bad in [".", "123.", ".deadbeef", "..", ""]:
        with pytest.raises(NangoWebhookVerificationError):
            verify_webhook(
                headers={NANGO_SIGNATURE_HEADER: bad},
                body=_BODY,
                settings=_settings(),
                now=_now(),
            )


def test_non_numeric_timestamp_rejected() -> None:
    with pytest.raises(NangoWebhookVerificationError):
        verify_webhook(
            headers={NANGO_SIGNATURE_HEADER: "notatimestamp.deadbeef"},
            body=_BODY,
            settings=_settings(),
            now=_now(),
        )


def test_stale_timestamp_rejected() -> None:
    stale_now = _now() + timedelta(
        seconds=WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 1
    )
    ts = int(_now().timestamp())
    header = _sign(_BODY, ts=ts)
    with pytest.raises(NangoWebhookVerificationError):
        verify_webhook(
            headers={NANGO_SIGNATURE_HEADER: header},
            body=_BODY,
            settings=_settings(),
            now=stale_now,
        )


def test_future_timestamp_outside_tolerance_rejected() -> None:
    future_ts = int(_now().timestamp()) + WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS + 10
    header = _sign(_BODY, ts=future_ts)
    with pytest.raises(NangoWebhookVerificationError):
        verify_webhook(
            headers={NANGO_SIGNATURE_HEADER: header},
            body=_BODY,
            settings=_settings(),
            now=_now(),
        )


def test_signature_mismatch_rejected() -> None:
    ts = int(_now().timestamp())
    # Sign with a different secret — same shape, different mac.
    header = _sign(_BODY, ts=ts, secret="other-secret")
    with pytest.raises(NangoWebhookVerificationError):
        verify_webhook(
            headers={NANGO_SIGNATURE_HEADER: header},
            body=_BODY,
            settings=_settings(),
            now=_now(),
        )


def test_body_tampering_rejected() -> None:
    ts = int(_now().timestamp())
    header = _sign(_BODY, ts=ts)
    with pytest.raises(NangoWebhookVerificationError):
        verify_webhook(
            headers={NANGO_SIGNATURE_HEADER: header},
            body=_BODY + b" tampered",
            settings=_settings(),
            now=_now(),
        )


def test_timestamp_swap_rejected() -> None:
    """Re-using a valid signature with a different timestamp must fail.

    Without binding the timestamp into the HMAC, an attacker could
    replay an old signature with a fresh timestamp to dodge the
    stale-window check.
    """
    ts = int(_now().timestamp())
    header = _sign(_BODY, ts=ts)
    _, _, sig = header.partition(".")
    forged = f"{ts + 1}.{sig}"
    with pytest.raises(NangoWebhookVerificationError):
        verify_webhook(
            headers={NANGO_SIGNATURE_HEADER: forged},
            body=_BODY,
            settings=_settings(),
            now=_now(),
        )


def test_signature_case_insensitive_match() -> None:
    """Hex digests compare case-insensitively (matches DocuSeal verifier)."""
    ts = int(_now().timestamp())
    header = _sign(_BODY, ts=ts)
    upper = header.upper()
    verify_webhook(
        headers={NANGO_SIGNATURE_HEADER: upper},
        body=_BODY,
        settings=_settings(),
        now=_now(),
    )


def test_empty_body_with_valid_signature() -> None:
    ts = int(_now().timestamp())
    header = _sign(b"", ts=ts)
    verify_webhook(
        headers={NANGO_SIGNATURE_HEADER: header},
        body=b"",
        settings=_settings(),
        now=_now(),
    )


def test_whitespace_in_signature_tolerated() -> None:
    ts = int(_now().timestamp())
    header = _sign(_BODY, ts=ts)
    verify_webhook(
        headers={NANGO_SIGNATURE_HEADER: f"  {header}  "},
        body=_BODY,
        settings=_settings(),
        now=_now(),
    )
