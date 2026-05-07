from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ClauseTemplateCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    clause_type: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1)
    description: str | None = None
    jurisdiction: str | None = Field(default=None, max_length=128)
    contract_type: str | None = Field(default=None, max_length=64)
    version: str | None = Field(default=None, max_length=32)
    source: str | None = Field(default=None, max_length=255)
    tags: list[str] | None = None


class ClauseTemplateUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    clause_type: str | None = Field(default=None, min_length=1, max_length=64)
    text: str | None = Field(default=None, min_length=1)
    description: str | None = None
    jurisdiction: str | None = Field(default=None, max_length=128)
    contract_type: str | None = Field(default=None, max_length=64)
    version: str | None = Field(default=None, max_length=32)
    source: str | None = Field(default=None, max_length=255)
    tags: list[str] | None = None
    is_active: bool | None = None


class ClauseTemplateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    clause_type: str
    text: str
    description: str | None
    jurisdiction: str | None
    contract_type: str | None
    version: str | None
    source: str | None
    tags: list[str]
    is_active: bool
    created_at: datetime
    updated_at: datetime
