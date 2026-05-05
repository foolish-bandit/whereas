"""Whereas API entry point."""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api import auth, contracts, docuseal_bridge, playbooks, qa
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.security.headers import SecurityHeadersMiddleware
from app.security.rate_limit import limiter

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

# --- Rate limiting ---
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# --- Security headers (run last, so they apply to ALL responses including
# rate-limit errors and CORS preflights). ---
app.add_middleware(
    SecurityHeadersMiddleware,
    docuseal_url=settings.DOCUSEAL_BASE_URL,
    environment=settings.ENVIRONMENT,
)

# --- CORS (development only) ---
if settings.ENVIRONMENT == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:8080", "http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# --- Routers ---
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(contracts.router, prefix="/api/contracts", tags=["contracts"])
app.include_router(playbooks.router, prefix="/api/playbooks", tags=["playbooks"])
app.include_router(qa.router, prefix="/api/qa", tags=["qa"])
app.include_router(docuseal_bridge.router, prefix="/api/docuseal", tags=["docuseal"])


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.on_event("startup")
async def startup() -> None:
    log.info("Whereas starting", extra={"environment": settings.ENVIRONMENT})
    # Validate critical security config at startup; fail fast if misconfigured.
    from app.security.encryption import load_instance_key
    try:
        load_instance_key()
        log.info("Instance key loaded successfully")
    except Exception as e:
        log.error("FATAL: instance key not loadable: %s", e)
        raise


@app.on_event("shutdown")
async def shutdown() -> None:
    log.info("Whereas shutting down")
