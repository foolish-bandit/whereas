"""Request/response schemas for ``/api/approval-workflow-templates``.

PR #51 — reusable approval workflow blueprints. A template carries an
ordered list of step definitions; instantiation copies them into
concrete ``ApprovalStep`` rows on a new ``ApprovalWorkflowRun``. The
template itself is never mutated by an instantiation, and template edits
never touch in-flight runs.

Naming caution: ``AgreementTemplate`` (a document blueprint) is a
distinct concept. The instantiate request uses ``agreement_template_id``
to link a generated agreement, so it does not collide with the workflow
template path parameter.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

# ---------------------------------------------------------------------------
# Step schemas
# ---------------------------------------------------------------------------


class ApprovalWorkflowTemplateStepCreate(BaseModel):
    """Step payload accepted on template creation and step append.

    ``step_order`` is optional; if omitted the API assigns it as
    ``len(existing_steps) + 1`` for an append, or as the position in the
    create payload's ``steps`` array (1-indexed).
    """

    model_config = ConfigDict(extra="forbid")

    step_order: int | None = Field(default=None, ge=1)
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    approver_name: str | None = Field(default=None, max_length=255)
    approver_email: str | None = Field(default=None, max_length=255)
    assigned_to: uuid.UUID | None = None
    due_in_days: int | None = Field(default=None, ge=0, le=365)
    metadata_json: dict[str, Any] | None = None


class ApprovalWorkflowTemplateStepPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step_order: int | None = Field(default=None, ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    approver_name: str | None = Field(default=None, max_length=255)
    approver_email: str | None = Field(default=None, max_length=255)
    assigned_to: uuid.UUID | None = None
    due_in_days: int | None = Field(default=None, ge=0, le=365)
    metadata_json: dict[str, Any] | None = None


class ApprovalWorkflowTemplateStepResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    workflow_template_id: uuid.UUID
    step_order: int
    title: str
    description: str | None = None
    approver_name: str | None = None
    approver_email: str | None = None
    assigned_to: uuid.UUID | None = None
    due_in_days: int | None = None
    metadata_json: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Template schemas
# ---------------------------------------------------------------------------


# Free-form examples — kept narrow so the docstring suggests what to use
# without locking customers in. Backend stores it as an opaque string.
TEMPLATE_TYPE_EXAMPLES = (
    "legal_review",
    "finance_review",
    "procurement_review",
    "executive_approval",
    "general",
)


class ApprovalWorkflowTemplateCreate(BaseModel):
    """Body for ``POST /api/approval-workflow-templates``.

    At least one step is required: a template with no steps is not
    instantiable, so empty drafts are rejected at the API boundary.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    template_type: str | None = Field(default=None, max_length=64)
    metadata_json: dict[str, Any] | None = None
    steps: list[ApprovalWorkflowTemplateStepCreate] = Field(min_length=1)


class ApprovalWorkflowTemplatePatch(BaseModel):
    """Body for ``PATCH /api/approval-workflow-templates/{template_id}``.

    Step edits go through the dedicated step endpoints; this body only
    updates template-level metadata. ``status`` is omitted on purpose:
    archiving uses the ``DELETE`` route (soft archive), and unarchiving
    is an explicit ``status`` field here.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    template_type: str | None = Field(default=None, max_length=64)
    status: str | None = None
    metadata_json: dict[str, Any] | None = None


class ApprovalWorkflowTemplateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    name: str
    description: str | None = None
    template_type: str | None = None
    status: str
    created_at: datetime
    updated_at: datetime
    created_by: uuid.UUID | None = None
    metadata_json: dict[str, Any] | None = None
    steps: list[ApprovalWorkflowTemplateStepResponse] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Instantiation
# ---------------------------------------------------------------------------


class CreateApprovalWorkflowFromTemplateRequest(BaseModel):
    """Body for ``POST /api/approval-workflow-templates/{template_id}/instantiate``.

    Mirrors the existing ad-hoc workflow create surface: at least one of
    ``request_id`` or ``contract_id`` is required, ``agreement_template_id``
    is the ``AgreementTemplate`` (document blueprint) link, deliberately
    spelled out to avoid colliding with the workflow template path
    parameter.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    request_id: uuid.UUID | None = None
    contract_id: uuid.UUID | None = None
    agreement_template_id: uuid.UUID | None = None
    metadata_json: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _require_request_or_contract(
        self,
    ) -> CreateApprovalWorkflowFromTemplateRequest:
        if self.request_id is None and self.contract_id is None:
            raise ValueError(
                "At least one of request_id or contract_id is required."
            )
        return self
