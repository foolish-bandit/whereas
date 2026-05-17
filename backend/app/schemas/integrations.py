"""Request/response schemas for ``/api/integrations``.

Integrations route through a self-hosted Nango deployment. Each
:class:`IntegrationConnectionResponse` corresponds to one
``IntegrationConnection`` row — a single org+provider binding.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class IntegrationProviderResponse(BaseModel):
    """A provider that the operator can connect.

    ``available`` is False when the Nango deployment has not been
    configured for this provider (no OAuth app credentials supplied);
    the UI hides the Connect button in that case.
    """

    model_config = ConfigDict(extra="forbid")

    key: str
    label: str
    description: str
    available: bool


class IntegrationConnectionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    provider: str
    status: str
    ingest_mode: str
    display_name: str | None = None
    last_synced_at: datetime | None = None
    last_sync_error: str | None = None
    created_at: datetime
    updated_at: datetime
    created_by: uuid.UUID | None = None


class CreateConnectSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = Field(min_length=1, max_length=64)


class CreateConnectSessionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str
    expires_at: datetime | None = None


class CompleteConnectionRequest(BaseModel):
    """Body posted by the frontend after Nango Connect returns success.

    ``nango_connection_id`` is whatever Nango handed the Connect widget
    callback — opaque to Whereas; we hand it back to Nango when we
    proxy a download or trigger a sync.
    """

    model_config = ConfigDict(extra="forbid")

    provider: str = Field(min_length=1, max_length=64)
    nango_connection_id: str = Field(min_length=1, max_length=255)
    display_name: str | None = Field(default=None, max_length=255)
    ingest_mode: str | None = Field(default=None, max_length=16)


class UpdateConnectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, max_length=255)
    ingest_mode: str | None = Field(default=None, max_length=16)


class ManualSyncResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connection_id: uuid.UUID
    files_seen: int
    contracts_created: int
    skipped: int
    cursor: str | None = None
