"""Request/response schemas for the agreement template routes."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


class AgreementTemplateCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    template_type: str | None = Field(default=None, max_length=64)
    metadata_json: dict[str, Any] | None = None


class AgreementTemplateUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    template_type: str | None = Field(default=None, max_length=64)
    # Status is constrained to active/archived in the route handler.
    status: str | None = Field(default=None, max_length=16)
    metadata_json: dict[str, Any] | None = None


class AgreementTemplateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    description: str | None = None
    template_type: str | None = None
    status: str
    created_at: datetime
    updated_at: datetime
    metadata_json: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------


class AgreementTemplateArtifactResponse(BaseModel):
    """Public projection of an ``AgreementTemplateArtifact``.

    ``storage_key`` is intentionally omitted: this listing is metadata
    only and exposing the raw object key would be a step backwards from
    the existing scrub posture (clients fetch bytes via the dedicated
    download endpoint, when one lands in a later PR).
    """

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    template_id: uuid.UUID
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


# ---------------------------------------------------------------------------
# Markdown snapshots
# ---------------------------------------------------------------------------


class AgreementTemplateMarkdownSnapshotResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    template_id: uuid.UUID
    markdown_text: str
    source_kind: str
    converter_name: str | None = None
    converter_version: str | None = None
    conversion_status: str
    conversion_warnings: list[str] | None = None
    created_at: datetime


# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------


class AgreementTemplateVariableCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=255)
    variable_type: str = Field(min_length=1, max_length=32)
    required: bool = False
    default_value: str | None = None
    help_text: str | None = None
    sort_order: int = 0
    metadata_json: dict[str, Any] | None = None


class AgreementTemplateVariableUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str | None = Field(default=None, min_length=1, max_length=128)
    label: str | None = Field(default=None, min_length=1, max_length=255)
    variable_type: str | None = Field(default=None, min_length=1, max_length=32)
    required: bool | None = None
    default_value: str | None = None
    help_text: str | None = None
    sort_order: int | None = None
    metadata_json: dict[str, Any] | None = None


class AgreementTemplateVariableResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    template_id: uuid.UUID
    key: str
    label: str
    variable_type: str
    required: bool
    default_value: str | None = None
    help_text: str | None = None
    sort_order: int
    metadata_json: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime
