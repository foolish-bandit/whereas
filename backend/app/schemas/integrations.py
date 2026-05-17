"""Request/response schemas for ``/api/integrations``.

Integrations route through a self-hosted Nango deployment. Each
:class:`IntegrationConnectionResponse` corresponds to one
``IntegrationConnection`` row — a single org+provider binding.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Keys we read out of ``IntegrationConnection.metadata_json`` for the
# folder picker. Centralized so the route handler, the response
# serializer, and the sync filter all agree on the same names.
METADATA_ROOT_FOLDER_ID = "root_folder_id"
METADATA_ROOT_FOLDER_NAME = "root_folder_name"


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
    root_folder_id: str | None = None
    root_folder_name: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _hydrate_folder_from_metadata(cls, data: Any) -> Any:
        """Lift the picker keys out of ``metadata_json`` onto the response.

        Accepts either a SQLAlchemy row (via ``from_attributes``) or a
        plain dict. The metadata blob is the source of truth on the
        model side; we surface a flat shape to the API.
        """
        if isinstance(data, dict):
            metadata = data.get("metadata_json")
            if isinstance(metadata, dict):
                data.setdefault(
                    "root_folder_id", metadata.get(METADATA_ROOT_FOLDER_ID)
                )
                data.setdefault(
                    "root_folder_name", metadata.get(METADATA_ROOT_FOLDER_NAME)
                )
            return data
        metadata = getattr(data, "metadata_json", None)
        if isinstance(metadata, dict):
            return {
                "id": data.id,
                "organization_id": data.organization_id,
                "provider": data.provider,
                "status": data.status,
                "ingest_mode": data.ingest_mode,
                "display_name": data.display_name,
                "last_synced_at": data.last_synced_at,
                "last_sync_error": data.last_sync_error,
                "created_at": data.created_at,
                "updated_at": data.updated_at,
                "created_by": data.created_by,
                "root_folder_id": metadata.get(METADATA_ROOT_FOLDER_ID),
                "root_folder_name": metadata.get(METADATA_ROOT_FOLDER_NAME),
            }
        return data


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
    """Fields the admin can patch on a live connection.

    ``root_folder_id`` / ``root_folder_name`` come from the folder
    picker. Sending ``root_folder_id=""`` (empty string) clears the
    scope and falls back to whole-drive sync; sending None leaves the
    existing value alone (so a partial PATCH that only updates
    ``ingest_mode`` doesn't accidentally wipe the folder selection).
    """

    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, max_length=255)
    ingest_mode: str | None = Field(default=None, max_length=16)
    root_folder_id: str | None = Field(default=None, max_length=255)
    root_folder_name: str | None = Field(default=None, max_length=512)


class FolderEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    has_children: bool = False
    parent_id: str | None = None


class ListFoldersRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # ``None`` means "list the root" — provider-specific (Drive uses
    # the literal "root"; OneDrive's Graph API uses "root" as the
    # well-known item id).
    parent_id: str | None = Field(default=None, max_length=255)


class ListFoldersResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parent_id: str
    folders: list[FolderEntry]


class ManualSyncResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connection_id: uuid.UUID
    files_seen: int
    contracts_created: int
    skipped: int
    cursor: str | None = None
