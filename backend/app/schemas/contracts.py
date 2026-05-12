"""Response schemas for contract API routes."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import (  # noqa: F401  (Field re-export for downstream importers)
    BaseModel,
    ConfigDict,
    Field,
)

from app.schemas.contract_intake import (
    DuplicateContractCandidateResponse,
    ExtractedContractMetadataResponse,
)


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
    # PR #76 — duplicate-merge bookkeeping. ``merged_into_contract_id``
    # is None on canonical records and on records that have never
    # been merged. The default list filters merged rows out at the
    # query layer; these fields exist so a directly-linked merged
    # detail page can still render a safe "merged into …" notice.
    merged_into_contract_id: uuid.UUID | None = None
    merged_at: datetime | None = None
    # PR #101 — when the list endpoint is called with ``?q=…``, each
    # row carries a small hint about *why* the record matched: against
    # its title, its Text preview body, or both. ``None`` when no
    # query is active. The field is deliberately a closed enum of
    # ``"title" | "text_preview" | "title_and_text_preview"`` so the
    # UI never has to interpret raw snapshot content; storage
    # internals, document bytes, private URLs, ``metadata_json``, and
    # any raw ``markdown_text`` are still not returned in the list
    # response.
    search_match_source: str | None = None


class ContractUploadResponse(ContractListItemResponse):
    extracted_fields: list[ExtractedFieldResponse]
    clauses: list[ClauseResponse] = []
    message: str | None = None
    # PR #66 — upload-intake intelligence. Both fields default to "none
    # detected" so older clients that don't render them won't see
    # missing keys; storage internals are excluded by construction at
    # the projection schemas.
    extracted_metadata: ExtractedContractMetadataResponse | None = None
    duplicate_candidates: list[DuplicateContractCandidateResponse] = Field(
        default_factory=list
    )


class ContractDetailResponse(ContractListItemResponse):
    full_text: str | None
    extracted_fields: list[ExtractedFieldResponse]
    clauses: list[ClauseResponse] = []
