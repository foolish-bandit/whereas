"""Security headers middleware.

Applies a hardened set of HTTP response headers to every response. These are
table stakes for any web application handling sensitive data; they protect
against a slate of common attacks (clickjacking, MIME sniffing, mixed content,
some XSS).

The CSP is the hardest header to get right because of the embedded DocuSeal
iframe. We allowlist the DocuSeal origin specifically. If you embed other
external content later (e.g., a help widget), update the CSP carefully —
overly-permissive CSP is worse than none at all because it gives a false
sense of security.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from urllib.parse import urlparse

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Adds hardened security headers to every response.

    Configuration:
      - docuseal_url: the URL where DocuSeal is reachable from the user's browser.
        Used to allowlist the iframe in the CSP. If None, no iframe is allowed.
      - hsts_max_age: HSTS max-age in seconds. Default is 1 year. Set to 0 to
        disable (only for local dev where you don't have TLS).
      - environment: "development" relaxes a few headers for local work.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        docuseal_url: str | None = None,
        hsts_max_age: int = 31_536_000,  # 1 year
        environment: str = "production",
    ) -> None:
        super().__init__(app)
        self.docuseal_origin = self._extract_origin(docuseal_url) if docuseal_url else None
        self.hsts_max_age = hsts_max_age
        self.environment = environment

    @staticmethod
    def _extract_origin(url: str) -> str:
        """Extract scheme://host[:port] from a URL."""
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError(f"Invalid URL for CSP: {url}")
        return f"{parsed.scheme}://{parsed.netloc}"

    def _build_csp(self) -> str:
        """Build the Content-Security-Policy header.

        Conservative baseline:
          - default-src 'self': only same-origin by default
          - script-src 'self': no inline scripts, no eval
          - style-src 'self' 'unsafe-inline': inline styles needed for some React bits
          - img-src 'self' data: blob: : allow images from local, data URIs, blobs
          - connect-src 'self': API calls go to same origin
          - frame-src: only the DocuSeal origin if configured
          - frame-ancestors 'none': nobody can embed Whereas in their iframe
          - base-uri 'self': prevent base-tag injection
          - form-action 'self': forms can only submit to our own origin
          - object-src 'none': no Flash/applets/etc.
          - upgrade-insecure-requests: rewrite http:// to https:// in subresources

        If you ever need to relax this (analytics, error tracking, etc.), do it
        with named hashes/nonces, not 'unsafe-inline' or 'unsafe-eval'.
        """
        frame_src = self.docuseal_origin if self.docuseal_origin else "'none'"
        directives = [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self'",
            f"frame-src {frame_src}",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "object-src 'none'",
            "upgrade-insecure-requests",
        ]
        return "; ".join(directives)

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        response = await call_next(request)

        # HSTS: only when actually served over HTTPS (or in prod, always — assume
        # the reverse proxy is doing TLS termination).
        if self.environment == "production" and self.hsts_max_age > 0:
            response.headers["Strict-Transport-Security"] = (
                f"max-age={self.hsts_max_age}; includeSubDomains"
            )

        response.headers["Content-Security-Policy"] = self._build_csp()
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = (
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
        )
        # Cross-origin isolation. Conservative defaults; relax only if a feature
        # demands it.
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"

        # Don't cache sensitive API responses by default. The frontend can
        # override per-route if needed.
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"

        # Drop the Server header that uvicorn sets — no need to advertise version.
        response.headers.pop("Server", None)

        return response
