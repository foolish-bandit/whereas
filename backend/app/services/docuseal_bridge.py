"""DocuSeal auth bridge.

Pattern B integration: Whereas and DocuSeal share a Postgres instance and run
side-by-side. Users authenticate with Whereas; when they navigate to DocuSeal
features, the Whereas backend mints a short-lived JWT signed with a shared
secret. DocuSeal validates the JWT and treats the user as authenticated.

This avoids:
  - Maintaining two separate auth systems with duplicate user records
  - Requiring users to log in twice
  - Leaking long-lived tokens

Limitations to know about:
  - DocuSeal's external auth integration model is evolving. The exact JWT claims
    and validation flow may need to be adjusted to match the DocuSeal version
    you're running. Verify against current DocuSeal docs before relying on this
    in production.
  - The shared secret is the trust root. Rotate it carefully; both services need
    to update simultaneously.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from jose import jwt
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.core.config import Settings, get_settings

log = logging.getLogger(__name__)
settings = get_settings()

JWT_ALGORITHM = "HS256"
JWT_TTL_SECONDS = 300  # 5 minutes; user clicks through to DocuSeal immediately


class DocuSealError(Exception):
    """A DocuSeal API call failed in a way the caller cannot retry.

    Used for 4xx-class upstream rejections and malformed-response
    surfaces (non-JSON body). These represent "the request itself was
    bad" rather than "the upstream is temporarily flaky", so retrying
    would just burn the user's time. The retry decorator below is
    scoped to ``RetryableDocuSealError``.

    ``status_code`` is the HTTP status the API endpoint should return
    when re-raising; defaults to 502 ("the upstream said no").
    """

    status_code: int = 502

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


class RetryableDocuSealError(DocuSealError):
    """A DocuSeal API call failed in a way that may resolve on retry.

    Reserved for transport-layer failures and 5xx responses. Tenacity
    retries on this subclass so a flaky network or a momentarily
    overloaded DocuSeal recovers without bothering the caller; a 4xx
    "bad request" stays terminal.
    """


def mint_docuseal_token(*, user_id: str, email: str, organization_id: str) -> str:
    """Mint a short-lived JWT for handoff to DocuSeal."""
    now = datetime.now(UTC)
    payload = {
        "sub": user_id,
        "email": email,
        "org": organization_id,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=JWT_TTL_SECONDS)).timestamp()),
        "iss": "whereas",
        "aud": "docuseal",
    }
    return jwt.encode(payload, settings.DOCUSEAL_AUTH_BRIDGE_SECRET, algorithm=JWT_ALGORITHM)


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type((httpx.HTTPError, RetryableDocuSealError)),
    reraise=True,
)
async def send_document_to_docuseal(
    *,
    document_bytes: bytes,
    filename: str,
    mime_type: str,
    submitters: list[dict[str, Any]],
    user_id: uuid.UUID | str,
    user_email: str,
    organization_id: uuid.UUID | str,
) -> dict[str, Any]:
    """Create a DocuSeal submission from in-memory document bytes.

    Whereas stores documents encrypted at rest under the org master key,
    so the older "presigned URL to S3" handoff would only ever serve
    DocuSeal a ciphertext blob. Instead we decrypt in the Whereas
    backend and POST the plaintext to DocuSeal as base64. This keeps
    the trust boundary in one place: Whereas decides what DocuSeal
    sees, on a per-request basis, with no long-lived presigned URL
    leaking out.

    ``submitters`` is the DocuSeal submitter shape: a list of
    ``{"email": str, "name": str, "role": str}`` dicts. The caller is
    responsible for shaping it; this function does not invent default
    roles or order so existing flows can pass through unchanged.

    Returns the DocuSeal response JSON, including any submission /
    submitter / embed-url fields the upstream produced. The retry
    decorator covers transient transport / 5xx errors.
    """
    token = mint_docuseal_token(
        user_id=str(user_id),
        email=user_email,
        organization_id=str(organization_id),
    )

    encoded_file = base64.b64encode(document_bytes).decode("ascii")
    payload = {
        "documents": [
            {
                "name": filename,
                "file": encoded_file,
                "content_type": mime_type,
            }
        ],
        "submitters": submitters,
        "send_email": True,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.post(
                f"{settings.DOCUSEAL_BASE_URL}/api/submissions",
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
            )
        except httpx.HTTPError as exc:
            # Transport-layer failure (timeout, DNS, refused). Worth a
            # retry — flaky network rather than a malformed request.
            raise RetryableDocuSealError(
                f"Could not reach DocuSeal: {type(exc).__name__}.",
            ) from exc
        if response.status_code >= 500:
            raise RetryableDocuSealError(
                f"DocuSeal returned {response.status_code}.",
            )
        if response.status_code >= 400:
            raise DocuSealError(
                f"DocuSeal rejected the submission ({response.status_code}).",
                status_code=502,
            )
        try:
            return response.json()
        except ValueError as exc:
            raise DocuSealError(
                "DocuSeal returned a non-JSON response.",
            ) from exc


DOCUSEAL_SIGNATURE_HEADER = "X-DocuSeal-Signature"
DOCUSEAL_SHARED_SECRET_HEADER = "X-Whereas-Docuseal-Webhook-Secret"


class WebhookVerificationError(Exception):
    """Raised when a DocuSeal webhook payload cannot be authenticated.

    Carries an HTTP status hint so the route layer can map it onto a
    response without leaking implementation details.
    """

    status_code: int = 401

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


def verify_docuseal_webhook(
    *,
    headers: dict[str, str] | Any,
    body: bytes,
    settings: Settings | None = None,
) -> None:
    """Verify a webhook callback from DocuSeal.

    Two acceptable proofs of origin, in order of preference:

      1. ``X-DocuSeal-Signature``: an HMAC-SHA256 hex digest of the raw
         request body keyed on ``DOCUSEAL_WEBHOOK_SECRET``. This is the
         path to use once DocuSeal's signing scheme is pinned down for
         the target version; it is also what every well-behaved
         DocuSeal deployment ships today, so it is the default branch.
      2. ``X-Whereas-Docuseal-Webhook-Secret``: the literal value of
         ``DOCUSEAL_WEBHOOK_SECRET``. Provided as an interim path
         because DocuSeal's webhook signing model is still evolving;
         operators who cannot configure HMAC signing on their DocuSeal
         instance can configure a shared header instead. Documented as
         interim in the README.

    Production deployments must set ``DOCUSEAL_WEBHOOK_SECRET``. When
    it is unset, this function raises in any environment other than
    ``development`` so a misconfigured production instance cannot
    silently accept unsigned webhooks. Development still rejects
    invalid signatures when the secret IS set; the dev escape hatch
    only applies when no secret is configured at all.

    Raises ``WebhookVerificationError`` on any failure mode (missing
    secret in non-dev, missing or malformed signature, mismatched
    signature). Returns ``None`` on success — the body remains the
    caller's responsibility to parse.

    The body is treated as opaque bytes; this function does not log
    it, because DocuSeal payloads carry signer/document data we do not
    want flowing into log aggregation.
    """
    if settings is None:
        settings = get_settings()

    secret = (settings.DOCUSEAL_WEBHOOK_SECRET or "").strip()
    header_lookup = _CaseInsensitiveHeaders(headers)

    if not secret:
        if settings.ENVIRONMENT == "development":
            log.warning(
                "Accepting DocuSeal webhook without verification "
                "(DOCUSEAL_WEBHOOK_SECRET unset; development only).",
            )
            return
        raise WebhookVerificationError(
            "Webhook secret is not configured.",
            status_code=503,
        )

    sent_signature = header_lookup.get(DOCUSEAL_SIGNATURE_HEADER)
    if sent_signature:
        expected = hmac.new(
            secret.encode("utf-8"), body, hashlib.sha256
        ).hexdigest()
        # ``compare_digest`` keeps timing-side-channels closed even
        # though the comparand is a hex digest of bounded length.
        if not hmac.compare_digest(expected, sent_signature.strip().lower()):
            raise WebhookVerificationError("Webhook signature mismatch.")
        return

    sent_shared = header_lookup.get(DOCUSEAL_SHARED_SECRET_HEADER)
    if sent_shared and hmac.compare_digest(sent_shared.strip(), secret):
        return

    raise WebhookVerificationError("Webhook signature missing.")


class _CaseInsensitiveHeaders:
    """Tiny lookup helper.

    FastAPI gives us ``Request.headers`` (Starlette ``Headers``, which
    is already case-insensitive), but the verifier is also called from
    tests that pass plain dicts. Normalize once at the boundary.
    """

    def __init__(self, headers: Any) -> None:
        self._normalized = {
            (k.lower() if isinstance(k, str) else k): v
            for k, v in (
                headers.items() if hasattr(headers, "items") else headers
            )
        }

    def get(self, name: str) -> str | None:
        value = self._normalized.get(name.lower())
        return value if isinstance(value, str) else None


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type((httpx.HTTPError, RetryableDocuSealError)),
    reraise=True,
)
async def get_signed_document_from_docuseal(
    *,
    submission_id: str,
    user_id: uuid.UUID | str,
    user_email: str,
    organization_id: uuid.UUID | str,
) -> bytes:
    """Pull the completed (signed) document for a submission.

    DocuSeal exposes the executed document as a ``combined`` artifact
    on a completed submission. The endpoint shape is
    ``GET /api/submissions/{id}/documents/combined`` returning the raw
    PDF bytes. Operators may run an older DocuSeal where the same
    endpoint is ``/api/submissions/{id}.pdf`` — the v1 shape is the
    one Whereas requires; older versions are not supported here and
    surface as a clean 502 rather than silently falling back.

    Whereas re-encrypts the response under the org master key before
    storage; the bytes are not written to disk anywhere in this code
    path. The retry decorator covers transient network failures and
    5xx upstream responses; 4xx is terminal.
    """
    token = mint_docuseal_token(
        user_id=str(user_id),
        email=user_email,
        organization_id=str(organization_id),
    )
    url = (
        f"{settings.DOCUSEAL_BASE_URL}/api/submissions/"
        f"{submission_id}/documents/combined"
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {token}"},
            )
        except httpx.HTTPError as exc:
            raise RetryableDocuSealError(
                f"Could not reach DocuSeal: {type(exc).__name__}.",
            ) from exc
    if response.status_code >= 500:
        raise RetryableDocuSealError(
            f"DocuSeal returned {response.status_code} for signed document.",
        )
    if response.status_code >= 400:
        raise DocuSealError(
            f"DocuSeal rejected the signed-document fetch ({response.status_code}).",
            status_code=502,
        )
    if not response.content:
        raise DocuSealError(
            "DocuSeal returned an empty signed document.",
            status_code=502,
        )
    return response.content
