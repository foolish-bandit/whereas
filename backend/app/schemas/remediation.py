"""API contracts for deterministic finding remediation plans and tasks."""
from __future__ import annotations

import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.inbox_items import InboxItemResponse

RemediationSourceType = Literal[
    "playbook_preferred_language",
    "clause_template",
    "none",
]


class FindingRemediationTaskRequest(BaseModel):
    """Optional routing fields when promoting a finding into Inbox work."""

    model_config = ConfigDict(extra="forbid")

    assigned_to: uuid.UUID | None = None
    due_date: date | None = None


class FindingRemediationPlanResponse(BaseModel):
    """Approved language, provenance, and current workflow state for a finding."""

    model_config = ConfigDict(extra="forbid")

    finding_id: uuid.UUID
    contract_id: uuid.UUID
    review_run_id: uuid.UUID
    playbook_id: uuid.UUID
    rule_id: str = Field(min_length=1, max_length=128)
    rule_title: str = Field(min_length=1, max_length=500)
    clause_type: str = Field(min_length=1, max_length=64)
    severity: str = Field(min_length=1, max_length=16)
    finding_status: str = Field(min_length=1, max_length=16)

    suggested_language: str | None = None
    source_type: RemediationSourceType
    source_id: uuid.UUID | None = None
    source_name: str | None = None
    rationale: str
    scope_warning: str | None = None

    existing_task: InboxItemResponse | None = None


class FindingRemediationTaskResponse(BaseModel):
    """Result of creating, reusing, or reopening a remediation task."""

    model_config = ConfigDict(extra="forbid")

    plan: FindingRemediationPlanResponse
    task: InboxItemResponse
    created: bool
    reopened: bool
