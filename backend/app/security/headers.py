"""HTTP security headers middleware.

Sets a defense-in-depth set of response headers on every request. The
HARD-contracted directives are the ones called out in the v0.0.2 security
pass: strict CSP, X-Frame-Options DENY, nosniff, Referrer-Policy,
Permissions-Policy denying browser sensors, COOP/CORP same-origin, HSTS
in production only, and `Cache-Control: no-store` on `/api/` responses.

Intentional soft choices (documented inline so reviewers don't have to
guess): style-src/img-src/font-src/connect-src defaults are picked to be
strict but compatible with the React+Vite frontend; they can tighten as
the frontend matures.

This module is the configuration of headers; wiring the middleware into
the FastAPI app happens in a later PR with the rest of the request-path
plumbing.
"""
from __future__ import annotations

from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

# --------------------------------------------------------------------------
# Static directive values
# --------------------------------------------------------------------------


# Browser-sensor permissions to deny outright. We use the empty allowlist
# form `feature=()` for each. Whereas has no use for these and disabling
# them removes a class of injected-script side-channel risk.
_PERMISSIONS_POLICY = (
    "camera=(), "
    "microphone=(), "
    "geolocation=(), "
    "payment=(), "
    "usb=()"
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _origin_for_csp(url: str | None) -> str:
    """Extract the scheme://host[:port] origin from a URL, for CSP allowlists.

    Returns `'none'` (the CSP keyword, quoted) if the URL is missing,
    empty, or unparseable. We deliberately drop path/query — CSP source
    expressions are origin-only.
    """
    if not url:
        return "'none'"
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return "'none'"
    return f"{parsed.scheme}://{parsed.netloc}"


def _build_csp(docuseal_origin: str) -> str:
    """Compose the Content-Security-Policy header value.

    HARD directives (must be present, must not loosen): default-src,
    script-src, frame-ancestors, object-src, upgrade-insecure-requests,
    frame-src.

    SOFT directives (tunable as the frontend evolves): style-src allows
    `'unsafe-inline'` because Tailwind/React-injected styles still rely
    on it; img-src allows `data:` for embedded blobs; connect-src is
    self-only because the API and frontend are co-deployed behind one
    reverse proxy.
    """
    directives = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        f"frame-src {docuseal_origin}",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "upgrade-insecure-requests",
    ]
    return "; ".join(directives)


# --------------------------------------------------------------------------
# Middleware
# --------------------------------------------------------------------------


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Apply Whereas's security headers to every response.

    Constructor knobs:
      - `docuseal_url`: the DocuSeal peer service URL, used for CSP
        `frame-src`. If unset, frame-src is `'none'` and the embedded
        signing UI cannot load — pass the URL when DocuSeal is on.
      - `hsts_max_age`: HSTS lifetime in seconds. Default is one year.
        Setting to 0 disables HSTS even in production.
      - `environment`: when not "production", HSTS is suppressed so local
        dev (which uses plain HTTP) doesn't get the browser stuck on
        cached HTTPS upgrades.
    """

    def __init__(
        self,
        app,
        *,
        docuseal_url: str | None = None,
        hsts_max_age: int = 31_536_000,
        environment: str = "production",
    ) -> None:
        super().__init__(app)
        self._csp = _build_csp(_origin_for_csp(docuseal_url))
        self._hsts_max_age = hsts_max_age
        self._environment = environment

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        response = await call_next(request)

        response.headers["Content-Security-Policy"] = self._csp
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = _PERMISSIONS_POLICY
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"

        # HSTS only in production with a non-zero max-age. In dev (HTTP),
        # an HSTS header would teach the browser to upgrade subsequent
        # plaintext loads, which breaks local development.
        if self._environment == "production" and self._hsts_max_age > 0:
            response.headers["Strict-Transport-Security"] = (
                f"max-age={self._hsts_max_age}; includeSubDomains"
            )

        # No-store on API responses to keep contract data out of intermediate
        # caches. The frontend bundle (served from non-/api/ paths) keeps
        # its normal cache behavior.
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"

        # Some servers/proxies advertise themselves; that's a free
        # fingerprinting hint we don't owe attackers.
        if "server" in response.headers:
            del response.headers["server"]

        return response
