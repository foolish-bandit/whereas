"""Authentication routes.

v0.1 scope: email/password with Argon2id hashing, server-side sessions.
Post-v0.1: SSO (OIDC/SAML), MFA, magic links.
"""
from fastapi import APIRouter

router = APIRouter()


@router.post("/login")
async def login() -> dict[str, str]:
    """Stub - implement before v0.1."""
    return {"status": "not_implemented"}


@router.post("/logout")
async def logout() -> dict[str, str]:
    """Stub - implement before v0.1."""
    return {"status": "not_implemented"}


@router.get("/me")
async def me() -> dict[str, str]:
    """Stub - implement before v0.1."""
    return {"status": "not_implemented"}
