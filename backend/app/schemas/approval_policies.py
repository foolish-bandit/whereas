from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ApprovalPolicyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    workflow_template_id: uuid.UUID
    request_type: str | None = None
    contract_type: str | None = None
    priority: str | None = None
    agreement_template_id: uuid.UUID | None = None
    applies_to_generated_contracts: bool = True
    auto_attach: bool = True
    metadata_json: dict | None = None


class ApprovalPolicyPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    status: str | None = None
    workflow_template_id: uuid.UUID | None = None
    request_type: str | None = None
    contract_type: str | None = None
    priority: str | None = None
    agreement_template_id: uuid.UUID | None = None
    applies_to_generated_contracts: bool | None = None
    auto_attach: bool | None = None
    metadata_json: dict | None = None


class ApprovalPolicyResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    description: str | None
    status: str
    workflow_template_id: uuid.UUID
    workflow_template_name: str | None = None
    request_type: str | None
    contract_type: str | None
    priority: str | None
    agreement_template_id: uuid.UUID | None
    applies_to_generated_contracts: bool
    auto_attach: bool
    created_at: datetime
    updated_at: datetime | None
    created_by: uuid.UUID | None
    metadata_json: dict | None

    model_config = {"from_attributes": True}
