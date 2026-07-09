"""Whereas API entry point."""
import asyncio
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from sqlalchemy import text

from app.api import (
    agreement_templates,
    approval_policies,
    approval_workflow_templates,
    approval_workflows,
    auth,
    clause_templates,
    contracts,
    dashboard,
    docuseal_bridge,
    inbox_items,
    integrations,
    playbooks,
    qa,
    setup,
)
from app.api import (
    requests as request_routes,
)
from app.core.config import get_settings
from app.core.database import engine
from app.core.logging import configure_logging
from app.security.encryption import load_instance_key
from app.security.headers import SecurityHeadersMiddleware
from app.security.rate_limit import limiter
from app.services.storage import DocumentStorage

# How long the startup connectivity check waits before giving up.
# Bounded so a wedged DB cannot prevent the process from coming up to
# serve health checks and surface the outage to operators.
_DB_PROBE_TIMEOUT_SECONDS = 5.0

configure_logging()
log = logging.getLogger(__name__)

settings = get_settings()

app = FastAPI(
    title="Whereas API",
    description="The open-source contract repository.",
    version="0.0.1",
    docs_url="/api/docs" if settings.ENVIRONMENT != "production" else None,
    redoc_url=None,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# In dev, the frontend runs on a different port. In prod, it's behind a reverse proxy.
if settings.ENVIRONMENT == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:8080", "http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Added last so it is the outermost middleware: every response (including
# ones short-circuited by CORS or an inner middleware) gets the security
# headers, and HSTS/no-store gating stays centralized in one place.
app.add_middleware(
    SecurityHeadersMiddleware,
    docuseal_url=settings.DOCUSEAL_BASE_URL,
    environment=settings.ENVIRONMENT,
)

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(contracts.router, prefix="/api/contracts", tags=["contracts"])
app.include_router(playbooks.router, prefix="/api/playbooks", tags=["playbooks"])
app.include_router(clause_templates.router, prefix="/api/clause-templates", tags=["clause-templates"])
app.include_router(
    agreement_templates.router,
    prefix="/api/agreement-templates",
    tags=["agreement-templates"],
)
app.include_router(
    request_routes.router, prefix="/api/requests", tags=["requests"]
)
app.include_router(
    inbox_items.router, prefix="/api/inbox-items", tags=["inbox-items"]
)
app.include_router(
    approval_workflows.router,
    prefix="/api/approval-workflows",
    tags=["approval-workflows"],
)
app.include_router(
    approval_workflow_templates.router,
    prefix="/api/approval-workflow-templates",
    tags=["approval-workflow-templates"],
)
app.include_router(approval_policies.router, prefix="/api/approval-policies", tags=["approval-policies"])
app.include_router(qa.router, prefix="/api/qa", tags=["qa"])
app.include_router(docuseal_bridge.router, prefix="/api/docuseal", tags=["docuseal"])
app.include_router(setup.router, prefix="/api/setup", tags=["setup"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["dashboard"])
app.include_router(
    integrations.router, prefix="/api/integrations", tags=["integrations"]
)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# TODO: migrate startup/shutdown to FastAPI's lifespan context manager.
# `on_event` is deprecated; doing this in a focused PR keeps the blast radius
# contained.
@app.on_event("startup")
async def startup() -> None:
    log.info("Whereas starting", extra={"environment": settings.ENVIRONMENT})
    # Validate the instance key first. Running without encryption configured
    # would silently corrupt the security model, so this must fail loud.
    load_instance_key()
    log.info("Encryption instance key validated")
    # Database connectivity probe. Best-effort: a transient outage at boot
    # must not prevent the app from coming up to serve health checks. The
    # explicit timeout matters — without it, a wedged DB (accepting TCP but
    # not responding) would hang startup forever, which is the exact failure
    # mode this check is meant to surface.
    try:
        async with asyncio.timeout(_DB_PROBE_TIMEOUT_SECONDS):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
        log.info("Database connectivity verified")
    except TimeoutError:
        log.error(
            "Database connectivity probe timed out after %.1fs; "
            "starting anyway, requests will surface the outage",
            _DB_PROBE_TIMEOUT_SECONDS,
        )
    except Exception:
        log.exception(
            "Database connectivity probe failed; starting anyway, "
            "requests will surface the outage"
        )
    # Best-effort bucket provisioning. Transient S3 errors must not take the
    # whole app down; the first store_encrypted call will retry.
    try:
        await DocumentStorage(settings).ensure_bucket_exists()
    except Exception:
        log.exception(
            "Failed to ensure S3 bucket exists; first write will retry"
        )


@app.on_event("shutdown")
async def shutdown() -> None:
    log.info("Whereas shutting down")
