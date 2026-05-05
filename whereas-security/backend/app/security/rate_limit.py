"""Rate limiting setup using slowapi.

Critical for auth endpoints (prevents credential stuffing) and useful for the
API surface in general. Storage backend is in-memory by default; for multi-
instance deployments you'd swap to Redis. We don't ship Redis in v0.1's
Compose stack, so the default is in-memory and we document the limitation.
"""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address


def _key_func(request) -> str:  # noqa: ANN001
    """Rate-limit key.

    Uses the remote IP. If your deployment terminates TLS at a reverse proxy,
    the proxy MUST be configured to set X-Forwarded-For correctly, AND uvicorn
    MUST be started with --forwarded-allow-ips so the IP is honored. Otherwise
    every request looks like it came from the proxy and limits are useless.
    """
    return get_remote_address(request)


# In-memory storage. Swap for Redis in horizontally-scaled deployments:
#   storage_uri="redis://redis:6379"
limiter = Limiter(key_func=_key_func, storage_uri="memory://")


# --- Standard limit decorators ---
# These are convention strings, applied to specific routes.

# Auth endpoints: aggressive, both per-IP and per-account.
# The per-account limit needs a custom key_func; we'll wire that into auth routes
# directly when we implement them.
LOGIN_RATE_LIMIT = "5/15 minutes"
PASSWORD_RESET_RATE_LIMIT = "3/hour"

# General API: generous default to catch runaway clients without affecting users.
DEFAULT_API_RATE_LIMIT = "300/minute"

# Upload endpoint: tighter because each request can be large.
UPLOAD_RATE_LIMIT = "30/minute"
