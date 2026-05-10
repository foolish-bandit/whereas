"""Request/response schemas for ``/api/approval-workflows``.

PR #50 — narrow approval workflow foundation. Workflow runs attach to a
``ContractRequest`` and/or a ``Contract``. Each run has an ordered list
of approval steps; the current pending step is surfaced through an
``InboxItem`` to its assignee.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ApprovalStepCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=255)
    description: str | None = None

    approver_name: str | None = Field(default=None, max_length=255)
    approver_email: str | None = Field(default=None, max_length=255)
    assigned_to: uuid.UUID | None = None

    due_date: date | None = None
    metadata_json: dict[str, Any] | None = None


class ApprovalStepResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    workflow_run_id: uuid.UUID
    step_order: int
    title: str
    description: str | None = None
    approver_name: str | None = None
    approver_email: str | None = None
    assigned_to: uuid.UUID | None = None
    status: str
    decision_note: str | None = None
    decided_at: datetime | None = None
    due_date: date | None = None
    inbox_item_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    metadata_json: dict[str, Any] | None = None


class ApprovalStepDecisionRequest(BaseModel):
    """Body for the approve / reject endpoints.

    The note is optional; both endpoints share this shape so the client
    can post the same body either way.
    """

    model_config = ConfigDict(extra="forbid")

    decision_note: str | None = None


class ApprovalStepUpdateRequest(BaseModel):
    """Body for ``PATCH /steps/{id}`` while a step is still pending.

    Only a small allowlist of fields is editable; status changes go
    through the dedicated approve/reject endpoints.
    """

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    approver_name: str | None = Field(default=None, max_length=255)
    approver_email: str | None = Field(default=None, max_length=255)
    assigned_to: uuid.UUID | None = None
    due_date: date | None = None


class ApprovalWorkflowRunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    request_id: uuid.UUID | None = None
    contract_id: uuid.UUID | None = None
    template_id: uuid.UUID | None = None
    metadata_json: dict[str, Any] | None = None
    steps: list[ApprovalStepCreate] = Field(min_length=1)

    @model_validator(mode="after")
    def _require_request_or_contract(self) -> ApprovalWorkflowRunCreate:
        if self.request_id is None and self.contract_id is None:
            raise ValueError(
                "At least one of request_id or contract_id is required."
            )
        return self


class ApprovalWorkflowRunResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    status: str
    request_id: uuid.UUID | None = None
    contract_id: uuid.UUID | None = None
    template_id: uuid.UUID | None = None
    current_step_order: int | None = None
    started_at: datetime
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    created_by: uuid.UUID | None = None
    metadata_json: dict[str, Any] | None = None
    steps: list[ApprovalStepResponse] = Field(default_factory=list)


class ApprovalWorkflowRunListItem(BaseModel):
    """Compact list projection — drops nested step rows for cheaper lists."""

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    status: str
    request_id: uuid.UUID | None = None
    contract_id: uuid.UUID | None = None
    template_id: uuid.UUID | None = None
    current_step_order: int | None = None
    started_at: datetime
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
