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
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from jose import jwt
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import get_settings

log = logging.getLogger(__name__)
settings = get_settings()

JWT_ALGORITHM = "HS256"
JWT_TTL_SECONDS = 300  # 5 minutes; user clicks through to DocuSeal immediately


class DocuSealError(Exception):
    """A DocuSeal API call failed.

    Carries an HTTP status hint so callers can map it onto the API
    response. ``status_code`` defaults to 502 because the failure
    surface here is "the upstream signing service did not cooperate";
    individual call sites can override it (e.g. 4xx from DocuSeal we
    can pass through verbatim).
    """

    status_code: int = 502

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        if status_code is not None:
            self.status_code = status_code


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
            raise DocuSealError(
                f"Could not reach DocuSeal: {type(exc).__name__}.",
            ) from exc
        if response.status_code >= 500:
            raise DocuSealError(
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


async def verify_docuseal_webhook(*, signature: str, body: bytes) -> bool:
    """Verify a webhook callback from DocuSeal.

    DocuSeal POSTs back when submissions change state. We verify the signature
    using the shared secret before trusting the payload.

    Implementation depends on DocuSeal's specific webhook signing scheme.
    Stub for now; fill in once the webhook contract is finalized for v0.1.
    """
    # TODO(v0.1): implement HMAC verification against settings.DOCUSEAL_AUTH_BRIDGE_SECRET
    raise NotImplementedError("Webhook verification not yet implemented")
