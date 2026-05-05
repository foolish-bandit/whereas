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

import logging
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
async def create_docuseal_submission(
    *,
    document_url: str,
    submitters: list[dict[str, str]],
    user_id: str,
    user_email: str,
    organization_id: str,
) -> dict[str, Any]:
    """Create a submission in DocuSeal for the given document.

    `submitters` is a list of {"email": str, "name": str, "role": str} dicts.
    Returns the DocuSeal submission record (including an embed URL the frontend
    can use to render the signing experience inline).
    """
    token = mint_docuseal_token(
        user_id=user_id,
        email=user_email,
        organization_id=organization_id,
    )

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{settings.DOCUSEAL_BASE_URL}/api/submissions",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "document_url": document_url,
                "submitters": submitters,
                "send_email": True,
            },
        )
        response.raise_for_status()
        return response.json()


async def verify_docuseal_webhook(*, signature: str, body: bytes) -> bool:
    """Verify a webhook callback from DocuSeal.

    DocuSeal POSTs back when submissions change state. We verify the signature
    using the shared secret before trusting the payload.

    Implementation depends on DocuSeal's specific webhook signing scheme.
    Stub for now; fill in once the webhook contract is finalized for v0.1.
    """
    # TODO(v0.1): implement HMAC verification against settings.DOCUSEAL_AUTH_BRIDGE_SECRET
    raise NotImplementedError("Webhook verification not yet implemented")
