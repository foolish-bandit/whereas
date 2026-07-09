"""Application settings loaded from environment variables."""
from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # --- Core ---
    SECRET_KEY: str = Field(..., description="Used for session signing and CSRF.")
    ENVIRONMENT: Literal["development", "production", "test"] = "development"
    LOG_LEVEL: str = "INFO"

    # --- Database ---
    DATABASE_URL: str = Field(
        ...,
        description="postgresql+asyncpg://user:pass@host:5432/whereas",
    )
    DATABASE_POOL_SIZE: int = 10
    DATABASE_MAX_OVERFLOW: int = 20

    # --- S3 / MinIO ---
    S3_ENDPOINT: str
    S3_ACCESS_KEY: str
    S3_SECRET_KEY: str
    S3_BUCKET: str = "whereas-documents"
    S3_REGION: str = "us-east-1"
    CONTRACT_UPLOAD_MAX_BYTES: int = 50 * 1024 * 1024
    # Decompression-bomb guard for DOCX (OOXML zip) files: the sum of every
    # archive member's declared uncompressed size must not exceed this many
    # bytes. Comfortably above any legitimate contract DOCX, far below what
    # a hostile small zip could claim to expand into.
    DOCX_MAX_UNCOMPRESSED_BYTES: int = 500 * 1024 * 1024

    # --- LLM ---
    LITELLM_PROVIDER: str = "ollama"
    OLLAMA_BASE_URL: str = "http://ollama:11434"
    EMBEDDING_MODEL: str = "bge-m3"
    EXTRACTION_MODEL: str = "llama3.1:70b"
    LLM_REQUEST_TIMEOUT_SECONDS: int = 120
    # Master on/off switch for `app.services.embeddings`. Off disables both
    # clause-embedding population at ingest time and the vector leg of
    # hybrid retrieval; full-text and trigram search still work. Defaults
    # on so self-host deployments get working semantic search against the
    # default local Ollama embedding model without extra configuration.
    EMBEDDINGS_ENABLED: bool = True

    # Provider keys (only one needs to be set, depending on LITELLM_PROVIDER)
    OPENAI_API_KEY: str | None = None
    ANTHROPIC_API_KEY: str | None = None
    AZURE_API_KEY: str | None = None
    AZURE_API_BASE: str | None = None

    # --- DocuSeal ---
    DOCUSEAL_BASE_URL: str = "http://docuseal:3000"
    DOCUSEAL_AUTH_BRIDGE_SECRET: str
    # Optional shared secret used to verify DocuSeal completion
    # webhooks. When configured, the webhook receiver requires either a
    # matching HMAC-SHA256 signature in ``X-DocuSeal-Signature`` (if
    # the operator points DocuSeal at this value as its webhook signing
    # secret) or the literal value in ``X-Whereas-Docuseal-Webhook-Secret``
    # as an interim path until DocuSeal's signing scheme is finalized.
    # Production deployments must set this; leaving it unset rejects
    # all webhooks in non-development environments. See
    # ``app.services.docuseal_bridge.verify_docuseal_webhook``.
    DOCUSEAL_WEBHOOK_SECRET: str | None = None

    # --- Extraction confidence thresholds ---
    # Below this, extraction results are flagged as low-confidence in the UI.
    EXTRACTION_MIN_CONFIDENCE: float = 0.70
    # Below this, extraction results are not surfaced at all.
    EXTRACTION_DROP_THRESHOLD: float = 0.40
    # When true, pass a JSON-schema `response_format` (derived from
    # `MetadataExtractionResponse`) to the extraction LLM call so providers
    # that support structured outputs can constrain generation. Off by
    # default: most local Ollama models ignore or reject it, and we don't
    # want to assume frontier-model capabilities in the default deployment.
    EXTRACTION_STRUCTURED_OUTPUT: bool = False

    # --- Nango (third-party integrations bridge) ---
    # Self-hosted Nango runs as a peer service in docker-compose. The
    # secret key is the value Nango was started with; the webhook
    # secret is what Nango signs outbound webhooks with. Both unset
    # means "no integrations configured"; the API routes surface a
    # clean 503 in that case and the webhook receiver fails closed in
    # any non-development environment.
    NANGO_BASE_URL: str = "http://nango-server:3003"
    NANGO_PUBLIC_URL: str | None = None
    NANGO_SECRET_KEY: str | None = None
    NANGO_WEBHOOK_SECRET: str | None = None
    # Comma-separated list of provider keys the Nango deployment has
    # been configured with (i.e. OAuth app credentials supplied). The
    # ``/integrations/providers`` endpoint marks anything not in this
    # list as ``available=false`` so the UI hides the Connect button.
    NANGO_ENABLED_PROVIDERS: str = (
        "google-drive,microsoft-onedrive,microsoft-sharepoint,gmail,outlook"
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
