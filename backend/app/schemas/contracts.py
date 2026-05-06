"""Response schemas for contract API routes."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class ExtractedFieldResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    field_name: str
    value_json: Any
    span_start: int | None
    span_end: int | None
    span_text: str | None
    confidence: float
    model_name: str
    prompt_version: str
    extracted_at: datetime


class ContractListItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    status: str
    mime_type: str
    file_hash_sha256: str
    page_count: int | None
    created_at: datetime
    updated_at: datetime


class ContractUploadResponse(ContractListItemResponse):
    extracted_fields: list[ExtractedFieldResponse]
    message: str | None = None


class ContractDetailResponse(ContractListItemResponse):
    full_text: str | None
    extracted_fields: list[ExtractedFieldResponse]
