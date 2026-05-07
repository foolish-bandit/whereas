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


class ClauseResponse(BaseModel):
    """Public projection of a persisted Clause.

    Deliberately omits `organization_id`, `embedding`, `created_at`,
    and `updated_at`: the org id is implicit in the contract scope and
    the rest are not surfaced in the v1 UI. Storage / encryption
    fields never appear here because Clause has no such columns.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    contract_id: uuid.UUID
    ordinal: int
    heading: str | None
    clause_type: str | None
    clause_type_source: str | None
    text: str
    span_start: int
    span_end: int
    confidence: float | None
    segmentation_method: str
    model_name: str | None
    prompt_version: str | None


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
    clauses: list[ClauseResponse] = []
    message: str | None = None


class ContractDetailResponse(ContractListItemResponse):
    full_text: str | None
    extracted_fields: list[ExtractedFieldResponse]
    clauses: list[ClauseResponse] = []
