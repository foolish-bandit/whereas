"""Request/response schemas for ``/api/inbox-items``.

An ``InboxItem`` is the per-user work-queue surface. Items can point at
a request, a contract, or a template (or none of the above for a
free-floating "general" task). Creating a ``ContractRequest`` auto-
creates an open ``request_review`` inbox item; future PRs will emit
items for contract execution follow-ups, missing metadata cleanup, etc.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class InboxItemCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=255)
    description: str | None = None

    # Suggested: request_review, contract_review, signature_followup,
    # metadata_cleanup, general.
    item_type: str = Field(min_length=1, max_length=32)

    # Suggested: low, normal, high, urgent.
    priority: str | None = Field(default=None, max_length=16)

    assigned_to: uuid.UUID | None = None
    due_date: date | None = None

    request_id: uuid.UUID | None = None
    contract_id: uuid.UUID | None = None
    template_id: uuid.UUID | None = None

    metadata_json: dict[str, Any] | None = None


class InboxItemUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None

    item_type: str | None = Field(default=None, min_length=1, max_length=32)

    # Constrained to the InboxItemStatus enum in the route handler.
    status: str | None = Field(default=None, max_length=16)
    priority: str | None = Field(default=None, max_length=16)

    assigned_to: uuid.UUID | None = None
    due_date: date | None = None

    request_id: uuid.UUID | None = None
    contract_id: uuid.UUID | None = None
    template_id: uuid.UUID | None = None

    metadata_json: dict[str, Any] | None = None


class InboxItemResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    title: str
    description: str | None = None
    item_type: str
    status: str
    priority: str | None = None
    assigned_to: uuid.UUID | None = None
    due_date: date | None = None
    request_id: uuid.UUID | None = None
    contract_id: uuid.UUID | None = None
    template_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    created_by: uuid.UUID | None = None
    metadata_json: dict[str, Any] | None = None
