"""Shared helpers for PR #109 — backend API response leak audit.

Centralizes the canonical list of substrings that must never appear in
any public API response payload or in any ``AuditEvent.details`` row,
and the recursive scanner that enforces it.

Individual test files have historically duplicated their own
``_assert_no_secrets`` lists; the helpers here are the single source
of truth, so a new endpoint added later can opt into the same
strictness with one import.

Strict tokens vs labeled fields
-------------------------------

The forbidden-token list below contains *value-side* substrings — the
encryption / storage internals and signed-URL shapes that have no
legitimate reason to appear in any API response, anywhere, as either
a JSON key or a JSON value.

It deliberately does **not** include the labeled field name
``metadata_json``. Several response schemas (``ContractArtifactResponse``,
``AgreementTemplateArtifactResponse``, approval workflow / template
schemas, etc.) carry a ``metadata_json`` field by design — its
contents are an allowlisted small set of keys (e.g. ``template_id``,
``variable_keys``, ``docuseal_submission_id``) that the UI consumes.
The strict scanner below still asserts that whatever ends up inside
those bags carries no encryption / storage / signed-URL tokens.

If a future endpoint genuinely needs to expose one of these tokens
(it shouldn't), add an explicit, commented exception at the call
site — never broaden this list silently.
"""
from __future__ import annotations

import json
from typing import Any

FORBIDDEN_RESPONSE_TOKENS: tuple[str, ...] = (
    # Storage / encryption internals.
    "storage_key",
    "wrapped_dek",
    "wrapped_master_key",
    "org_master_key",
    "s3_key",
    # Signed-URL shapes — there are no presigned URLs in this product
    # by design; if one appears in a response, treat it as a leak.
    "presigned_url",
    "presigned_uri",
    "private_url",
    # DocuSeal secret-shaped fields. Tokens from upstream DocuSeal
    # responses are scrubbed before being echoed back; this is the
    # safety net.
    "docuseal_webhook_secret",
    "docuseal_api_token",
    # Vector embeddings — not a secret per se, but a regression that
    # started dumping clauses.embedding into responses would balloon
    # payload size and surface raw vectors that have no client use.
    # The clause schema docstring already promises not to expose it.
    "\"embedding\":",
)


def _flatten(value: Any) -> str:
    """Render any JSON-serializable value as a single string for substring scan."""
    try:
        return json.dumps(value, default=str)
    except (TypeError, ValueError):
        return str(value)


def assert_no_forbidden_tokens(payload: Any, *, where: str = "response") -> None:
    """Raise AssertionError if ``payload`` contains any FORBIDDEN_RESPONSE_TOKENS.

    Scans the serialized form of ``payload`` so the check covers both
    JSON keys and JSON values, including values nested inside
    ``metadata_json`` dicts.

    The ``where`` argument is interpolated into the failure message
    to make multi-endpoint audit tests easy to diagnose.
    """
    flattened = _flatten(payload)
    for token in FORBIDDEN_RESPONSE_TOKENS:
        if token in flattened:
            raise AssertionError(
                f"Forbidden token {token!r} appeared in {where}. "
                f"Storage internals, signed URLs, and DocuSeal secrets "
                f"must never be returned by any API."
            )


def assert_audit_details_clean(details: Any, *, where: str = "audit detail") -> None:
    """Same scan as ``assert_no_forbidden_tokens`` but with audit-log framing.

    ``record_event(...)`` callers are expected to pass allowlisted
    detail dicts only (never raw ``metadata_json``, document bytes,
    plaintext template variable values, or DocuSeal secrets). This
    helper is the cross-cutting check the audit tests can run after
    exercising a state-changing endpoint.
    """
    assert_no_forbidden_tokens(details, where=where)


def assert_safe_binary_headers(response: Any) -> None:
    """Validate that a streamed / binary download response has safe headers.

    Concretely: the binary endpoints (``GET .../download``,
    ``GET .../preview``) must return raw bytes, not a JSON envelope
    with a base64 body, and their headers must not echo back storage
    internals (a regression could plausibly leak the storage key as
    an ``X-Storage-Key`` header).
    """
    content_type = response.headers.get("content-type", "")
    assert "application/json" not in content_type, (
        f"Binary endpoint returned application/json: {content_type!r}. "
        f"Binary endpoints must stream raw bytes, not a JSON envelope."
    )
    header_text = "\n".join(f"{k}: {v}" for k, v in response.headers.items())
    for token in FORBIDDEN_RESPONSE_TOKENS:
        assert token not in header_text, (
            f"Forbidden token {token!r} appeared in response headers."
        )
