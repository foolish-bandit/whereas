"""Exhaustive tests for ``app.security.headers.SecurityHeadersMiddleware``.

CLAUDE.md requires exhaustive coverage for anything under ``app/security/``.
This module tests every header the middleware's own docstring promises:
CSP content (including the DocuSeal ``frame-src`` origin derivation), the
static headers (X-Frame-Options, nosniff, Referrer-Policy,
Permissions-Policy, COOP/CORP), HSTS gating by environment/max-age,
``Cache-Control: no-store`` scoped to ``/api/`` paths only, and the
``server`` header being stripped when present.

Tests build small standalone FastAPI apps with the middleware attached
directly (rather than going through the full ``app.main`` app) so each
test can control the middleware's constructor knobs independently.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.security.headers import SecurityHeadersMiddleware, _build_csp, _origin_for_csp

_EXPECTED_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"


class _AddServerHeaderMiddleware(BaseHTTPMiddleware):
    """Simulates an upstream server/proxy stamping a ``server`` header.

    Added *before* ``SecurityHeadersMiddleware`` so it sits on the inner
    side of the stack: the outer middleware sees this header on the way
    back out and should strip it.
    """

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        response = await call_next(request)
        response.headers["server"] = "nginx/1.0"
        return response


def _make_app(
    *,
    docuseal_url: str | None = "https://docuseal.example:3000",
    hsts_max_age: int = 31_536_000,
    environment: str = "production",
    add_server_header: bool = False,
) -> FastAPI:
    app = FastAPI()

    @app.get("/api/thing")
    def api_thing() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/static/thing")
    def static_thing() -> dict[str, bool]:
        return {"ok": True}

    if add_server_header:
        app.add_middleware(_AddServerHeaderMiddleware)

    app.add_middleware(
        SecurityHeadersMiddleware,
        docuseal_url=docuseal_url,
        hsts_max_age=hsts_max_age,
        environment=environment,
    )
    return app


async def _get(app: FastAPI, path: str = "/api/thing") -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


# ---------------------------------------------------------------------------
# Every promised header is present
# ---------------------------------------------------------------------------


async def test_all_static_headers_present_on_api_response() -> None:
    app = _make_app()
    response = await _get(app)

    assert response.status_code == 200
    assert response.headers["Content-Security-Policy"]
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert response.headers["Permissions-Policy"] == _EXPECTED_PERMISSIONS_POLICY
    assert response.headers["Cross-Origin-Opener-Policy"] == "same-origin"
    assert response.headers["Cross-Origin-Resource-Policy"] == "same-origin"


async def test_permissions_policy_denies_each_listed_sensor() -> None:
    app = _make_app()
    response = await _get(app)
    policy = response.headers["Permissions-Policy"]
    for directive in ("camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()"):
        assert directive in policy


# ---------------------------------------------------------------------------
# CSP content
# ---------------------------------------------------------------------------


async def test_csp_contains_all_hard_and_soft_directives() -> None:
    app = _make_app(docuseal_url="https://docuseal.example:3000")
    response = await _get(app)
    csp = response.headers["Content-Security-Policy"]

    for directive in (
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-src https://docuseal.example:3000",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "upgrade-insecure-requests",
    ):
        assert directive in csp


async def test_csp_frame_src_none_when_docuseal_url_missing() -> None:
    app = _make_app(docuseal_url=None)
    response = await _get(app)
    assert "frame-src 'none'" in response.headers["Content-Security-Policy"]


async def test_csp_frame_src_none_when_docuseal_url_empty_string() -> None:
    app = _make_app(docuseal_url="")
    response = await _get(app)
    assert "frame-src 'none'" in response.headers["Content-Security-Policy"]


async def test_csp_frame_src_none_when_docuseal_url_unparseable() -> None:
    app = _make_app(docuseal_url="not-a-url")
    response = await _get(app)
    assert "frame-src 'none'" in response.headers["Content-Security-Policy"]


async def test_csp_frame_src_drops_path_and_query_keeping_origin_only() -> None:
    app = _make_app(docuseal_url="https://docuseal.example:3000/some/path?x=1")
    response = await _get(app)
    csp = response.headers["Content-Security-Policy"]
    assert "frame-src https://docuseal.example:3000" in csp
    assert "/some/path" not in csp


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (None, "'none'"),
        ("", "'none'"),
        ("not-a-url", "'none'"),
        ("http://docuseal:3000", "http://docuseal:3000"),
        ("https://docuseal.example:3000/x?y=1", "https://docuseal.example:3000"),
    ],
)
def test_origin_for_csp_helper(url: str | None, expected: str) -> None:
    assert _origin_for_csp(url) == expected


def test_build_csp_helper_embeds_given_origin() -> None:
    csp = _build_csp("https://docuseal.example:3000")
    assert "frame-src https://docuseal.example:3000" in csp
    assert csp.startswith("default-src 'self';")


# ---------------------------------------------------------------------------
# HSTS gating
# ---------------------------------------------------------------------------


async def test_hsts_present_in_production_with_default_max_age() -> None:
    app = _make_app(environment="production")
    response = await _get(app)
    assert response.headers["Strict-Transport-Security"] == "max-age=31536000; includeSubDomains"


async def test_hsts_absent_in_development() -> None:
    app = _make_app(environment="development")
    response = await _get(app)
    assert "Strict-Transport-Security" not in response.headers


async def test_hsts_absent_in_test_environment() -> None:
    app = _make_app(environment="test")
    response = await _get(app)
    assert "Strict-Transport-Security" not in response.headers


async def test_hsts_absent_in_production_when_max_age_is_zero() -> None:
    app = _make_app(environment="production", hsts_max_age=0)
    response = await _get(app)
    assert "Strict-Transport-Security" not in response.headers


async def test_hsts_uses_custom_max_age() -> None:
    app = _make_app(environment="production", hsts_max_age=3600)
    response = await _get(app)
    assert response.headers["Strict-Transport-Security"] == "max-age=3600; includeSubDomains"


async def test_hsts_defaults_to_production_semantics_when_environment_unset() -> None:
    """The constructor's ``environment`` default is ``"production"``."""
    app = FastAPI()

    @app.get("/api/thing")
    def api_thing() -> dict[str, bool]:
        return {"ok": True}

    app.add_middleware(SecurityHeadersMiddleware)
    response = await _get(app)
    assert "Strict-Transport-Security" in response.headers


# ---------------------------------------------------------------------------
# Cache-Control scoping
# ---------------------------------------------------------------------------


async def test_cache_control_no_store_on_api_path() -> None:
    app = _make_app()
    response = await _get(app, "/api/thing")
    assert response.headers["Cache-Control"] == "no-store"


async def test_cache_control_absent_on_non_api_path() -> None:
    app = _make_app()
    response = await _get(app, "/static/thing")
    assert "Cache-Control" not in response.headers


async def test_cache_control_absent_when_path_merely_contains_api_prefix_without_slash() -> None:
    """``/apiFoo`` must not match the ``/api/`` prefix check."""
    app = FastAPI()

    @app.get("/apiFoo")
    def api_foo() -> dict[str, bool]:
        return {"ok": True}

    app.add_middleware(SecurityHeadersMiddleware)
    response = await _get(app, "/apiFoo")
    assert "Cache-Control" not in response.headers


# ---------------------------------------------------------------------------
# Server header stripping
# ---------------------------------------------------------------------------


async def test_server_header_is_stripped_when_present() -> None:
    app = _make_app(add_server_header=True)
    response = await _get(app)
    assert "server" not in response.headers


async def test_no_server_header_added_when_absent() -> None:
    app = _make_app(add_server_header=False)
    response = await _get(app)
    assert "server" not in response.headers


# ---------------------------------------------------------------------------
# Applies uniformly across different response statuses
# ---------------------------------------------------------------------------


async def test_headers_present_on_404_response() -> None:
    app = _make_app()
    response = await _get(app, "/api/does-not-exist")
    assert response.status_code == 404
    assert response.headers["Content-Security-Policy"]
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Cache-Control"] == "no-store"
