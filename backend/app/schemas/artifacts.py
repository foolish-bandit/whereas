"""Response schemas for the contract artifact routes."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class ContractArtifactResponse(BaseModel):
    """Public projection of a persisted ``ContractArtifact``.

    ``storage_key`` is intentionally omitted: the listing endpoint is
    metadata-only, and exposing the raw object key would be a step
    backwards from the existing scrub posture (clients use the existing
    download endpoint to fetch bytes).
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    contract_id: uuid.UUID
    artifact_type: str
    storage_backend: str
    filename: str | None = None
    mime_type: str | None = None
    file_hash_sha256: str | None = None
    size_bytes: int | None = None
    source: str | None = None
    is_official: bool
    created_at: datetime
    metadata_json: dict[str, Any] | None = None
