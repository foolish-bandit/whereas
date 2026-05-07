from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ClauseTemplateCreateRequest(BaseModel):
    name: str = Field(min_length=1)
    clause_type: str = Field(min_length=1)
    text: str = Field(min_length=1)
    description: str | None = None
    jurisdiction: str | None = None
    contract_type: str | None = None
    version: str | None = None
    source: str | None = None
    tags: list[str] | None = None

    @field_validator("name", "clause_type", "text")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class ClauseTemplateUpdateRequest(BaseModel):
    name: str | None = None
    clause_type: str | None = None
    text: str | None = None
    description: str | None = None
    jurisdiction: str | None = None
    contract_type: str | None = None
    version: str | None = None
    source: str | None = None
    tags: list[str] | None = None
    is_active: bool | None = None

    @field_validator("name", "clause_type", "text")
    @classmethod
    def _not_blank_optional(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("must not be blank")
        return value


class ClauseTemplateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    clause_type: str
    text: str
    description: str | None
    jurisdiction: str | None
    contract_type: str | None
    version: str | None
    source: str | None
    tags: list[str] | None
    is_active: bool
    created_at: datetime
    updated_at: datetime
