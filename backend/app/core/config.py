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

    # --- LLM ---
    LITELLM_PROVIDER: str = "ollama"
    OLLAMA_BASE_URL: str = "http://ollama:11434"
    EMBEDDING_MODEL: str = "bge-m3"
    EXTRACTION_MODEL: str = "llama3.1:70b"
    LLM_REQUEST_TIMEOUT_SECONDS: int = 120

    # Provider keys (only one needs to be set, depending on LITELLM_PROVIDER)
    OPENAI_API_KEY: str | None = None
    ANTHROPIC_API_KEY: str | None = None
    AZURE_API_KEY: str | None = None
    AZURE_API_BASE: str | None = None

    # --- DocuSeal ---
    DOCUSEAL_BASE_URL: str = "http://docuseal:3000"
    DOCUSEAL_AUTH_BRIDGE_SECRET: str

    # --- Extraction confidence thresholds ---
    # Below this, extraction results are flagged as low-confidence in the UI.
    EXTRACTION_MIN_CONFIDENCE: float = 0.70
    # Below this, extraction results are not surfaced at all.
    EXTRACTION_DROP_THRESHOLD: float = 0.40


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
