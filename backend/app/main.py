"""Whereas API entry point."""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, contracts, docuseal_bridge, playbooks, qa
from app.core.config import get_settings
from app.core.logging import configure_logging

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

# In dev, the frontend runs on a different port. In prod, it's behind a reverse proxy.
if settings.ENVIRONMENT == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:8080", "http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

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


@app.on_event("shutdown")
async def shutdown() -> None:
    log.info("Whereas shutting down")
