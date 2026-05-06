"""Rate limiter configuration.

Uses `slowapi`, which is the FastAPI/Starlette adapter around the
`limits` library. The limiter is module-level so route handlers can
import it and decorate per-endpoint.

Storage:
  In-memory only. That's fine for v0.1 single-process self-host (the
  primary deployment target). When multi-instance backends become a
  real use case, swap `storage_uri` to a Redis URL — the limit-string
  format is the same, so route decorators don't change.

IP attribution:
  `get_remote_address` reads the immediate peer. In production, Whereas
  is meant to sit behind a reverse proxy (Caddy/Nginx/Traefik) that
  rewrites the client IP into a header. If you front-end with a proxy
  that does NOT do this, every request appears to come from the proxy's
  loopback address and the rate limit becomes a global cap. Either fix
  the proxy or wrap `get_remote_address` with a header-aware key
  function. We don't ship that wrapper here because the right header
  name is deployment-specific.

Limit values:
  Tuned for a typical small-team deployment. If they're too aggressive
  for your firm's workflow, override per-endpoint at the decorator site
  rather than weakening the constants.
"""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address


# --------------------------------------------------------------------------
# Limit strings
# --------------------------------------------------------------------------


# Login attempts: 5 per 15 minutes per IP. Tight enough to make automated
# password spraying expensive; loose enough that a user fumbling their
# password a few times doesn't get locked out.
LOGIN_RATE_LIMIT = "5/15 minutes"

# Password reset emails: 3 per hour per IP. Keeps the email channel from
# being weaponized as a spam relay against arbitrary mailboxes.
PASSWORD_RESET_RATE_LIMIT = "3/hour"

# Default API rate limit: 300 per minute per IP. Generous for normal UI
# traffic; tightens scripts that blast the API.
DEFAULT_API_RATE_LIMIT = "300/minute"

# Upload limit: 30 per minute per IP. Constrains scrape-style bulk
# uploads without inconveniencing real human upload patterns.
UPLOAD_RATE_LIMIT = "30/minute"


# --------------------------------------------------------------------------
# Limiter instance
# --------------------------------------------------------------------------


limiter = Limiter(
    key_func=get_remote_address,
    storage_uri="memory://",
    default_limits=[DEFAULT_API_RATE_LIMIT],
)
