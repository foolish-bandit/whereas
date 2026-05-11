"""Request/response schemas for ``/api/requests``.

``ContractRequest`` is the intake/business workflow object — the place a
non-lawyer says "I need an NDA with X" so the legal team can triage,
assign, and convert later. The schema deliberately keeps the taxonomy
(``request_type``, ``contract_type``, ``priority``) free-form so users
can model their own categories without a migration; suggested values are
documented inline.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.artifacts import ContractArtifactResponse
from app.schemas.contract_intake import (
    DuplicateContractCandidateResponse,
    ExtractedContractMetadataResponse,
)
from app.schemas.contracts import ContractListItemResponse
from app.schemas.markdown import ContractMarkdownSnapshotResponse


class ContractRequestCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=255)
    description: str | None = None

    # Suggested: new_contract, review_existing, amendment, renewal, other.
    request_type: str | None = Field(default=None, max_length=64)
    # Suggested: NDA, MSA, SOW, DPA, Employment Agreement, Lease, Other.
    contract_type: str | None = Field(default=None, max_length=64)
    # Suggested: low, normal, high, urgent.
    priority: str | None = Field(default=None, max_length=16)

    requester_name: str | None = Field(default=None, max_length=255)
    requester_email: str | None = Field(default=None, max_length=255)
    counterparty_name: str | None = Field(default=None, max_length=255)

    due_date: date | None = None
    assigned_to: uuid.UUID | None = None
    linked_contract_id: uuid.UUID | None = None
    linked_template_id: uuid.UUID | None = None

    metadata_json: dict[str, Any] | None = None


class ContractRequestUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None

    request_type: str | None = Field(default=None, max_length=64)
    contract_type: str | None = Field(default=None, max_length=64)

    # Constrained to the ContractRequestStatus enum in the route handler.
    status: str | None = Field(default=None, max_length=16)
    priority: str | None = Field(default=None, max_length=16)

    requester_name: str | None = Field(default=None, max_length=255)
    requester_email: str | None = Field(default=None, max_length=255)
    counterparty_name: str | None = Field(default=None, max_length=255)

    due_date: date | None = None
    assigned_to: uuid.UUID | None = None
    linked_contract_id: uuid.UUID | None = None
    linked_template_id: uuid.UUID | None = None

    metadata_json: dict[str, Any] | None = None


class ContractRequestResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    title: str
    description: str | None = None
    request_type: str | None = None
    contract_type: str | None = None
    status: str
    priority: str | None = None
    requester_name: str | None = None
    requester_email: str | None = None
    counterparty_name: str | None = None
    due_date: date | None = None
    assigned_to: uuid.UUID | None = None
    linked_contract_id: uuid.UUID | None = None
    linked_template_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    created_by: uuid.UUID | None = None
    metadata_json: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Request -> Contract conversion
#
# Converting a request runs the same ``AgreementTemplate`` generation
# path the templates surface uses, then links the resulting Contract
# back to the request. The response carries both so the UI can pivot
# straight into the contract workspace without a second round trip.
# ---------------------------------------------------------------------------


class ConvertRequestToContractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=500)
    variable_values: dict[str, Any] = Field(default_factory=dict)


class ConvertRequestToContractResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    request: ContractRequestResponse
    contract: ContractListItemResponse
    artifact: ContractArtifactResponse
    markdown_snapshot: ContractMarkdownSnapshotResponse | None = None
    variables_used: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Request -> Contract conversion via uploaded file (PR #65)
#
# The other intake path: a user takes an open ContractRequest and
# uploads an external agreement file (counterparty paper, third-party
# signed exhibit, etc.) instead of generating from a template. The
# uploaded file becomes the Contract's ``original_upload`` artifact and
# the request is linked + completed in the same transaction.
# ---------------------------------------------------------------------------


class ConvertRequestUploadResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    request: ContractRequestResponse
    contract: ContractListItemResponse
    artifact: ContractArtifactResponse
    markdown_snapshot: ContractMarkdownSnapshotResponse | None = None
    # PR #66 — same suggestion + duplicate-warning block the Repository
    # upload returns. Either may be empty; neither blocks the
    # conversion.
    extracted_metadata: ExtractedContractMetadataResponse | None = None
    duplicate_candidates: list[DuplicateContractCandidateResponse] = Field(
        default_factory=list
    )
