"""Schemas for ``GET /api/requests/{request_id}/approval-status`` (PR #56).

This is a read-only visibility surface. The endpoint stitches together
matching approval policies, the ``ApprovalWorkflowRun``s currently
attached to the request, and a compact summary mirroring the DocuSeal
gate's allow/block logic so users can see *why* a request is pending,
blocked, completed, or ready for signature without flipping between
pages or guessing at metadata.

It does not mutate state. It reuses the existing matching service
(``find_matching_approval_policies``) and gating service
(``can_send_contract_to_docuseal``) so the answer here cannot drift away
from the live gate. Storage internals (``storage_key`` / ``wrapped_dek``
/ ``s3_key``) are excluded by construction: every nested response model
sets ``extra="forbid"`` and only allowlists scalar policy / workflow /
step fields.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class RequestApprovalPolicySummary(BaseModel):
    """Compact projection of an ``ApprovalPolicy`` row.

    Intentionally narrower than ``ApprovalPolicyResponse``: drops the
    full description / metadata blob / created_by / status timestamps
    that the visibility surface doesn't need so a future field on the
    detail schema can't accidentally end up here.
    """

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    name: str
    workflow_template_id: uuid.UUID
    auto_attach: bool
    applies_to_generated_contracts: bool
    request_type: str | None = None
    contract_type: str | None = None
    priority: str | None = None
    agreement_template_id: uuid.UUID | None = None


class RequestApprovalStepSummary(BaseModel):
    """Compact step projection — assignment + decision shape, no notes."""

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    step_order: int
    title: str
    status: str
    assigned_to: uuid.UUID | None = None
    approver_name: str | None = None
    approver_email: str | None = None
    due_date: date | None = None
    decided_at: datetime | None = None


class RequestApprovalWorkflowSummary(BaseModel):
    """Compact workflow run projection.

    ``source_approval_policy_id`` and ``source_approval_policy_name``
    come from the run's ``metadata_json`` (auto-attach stamps them on at
    instantiation time). Nullable because ad-hoc workflows have no
    source policy.
    """

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    name: str
    status: str
    current_step_order: int | None = None
    started_at: datetime
    completed_at: datetime | None = None
    source_approval_policy_id: uuid.UUID | None = None
    source_approval_policy_name: str | None = None
    steps: list[RequestApprovalStepSummary] = Field(default_factory=list)


class RequestApprovalSummary(BaseModel):
    """Headline answers a human reading the page wants in one glance.

    These fields are derived from the policy/workflow lists below; the
    UI uses them to pick a badge ("Approval pending", "Ready for
    signature", "No approval required") without re-deriving the same
    logic in TypeScript.
    """

    model_config = ConfigDict(extra="forbid")

    has_required_policies: bool
    has_active_workflows: bool
    has_rejected_workflows: bool
    has_completed_workflows: bool
    all_required_policy_workflows_completed: bool
    # ``ready_for_signature`` is None when the request has no linked
    # contract — the gate doesn't run without a contract, so saying
    # "ready" or "not ready" would be misleading.
    ready_for_signature: bool | None = None
    blocking_reason: str | None = None
    # Short human-readable phrasing of ``blocking_reason`` for the UI.
    # The codes (``active_approval_workflows`` etc.) match the gate
    # service so analytics / logs can correlate, and the phrasing is
    # kept on the server so every client renders the same thing.
    blocking_reason_text: str | None = None


class RequestApprovalStatusResponse(BaseModel):
    """Top-level response for ``GET /api/requests/{id}/approval-status``."""

    model_config = ConfigDict(extra="forbid")

    request_id: uuid.UUID
    linked_contract_id: uuid.UUID | None = None
    matching_policy_ids: list[uuid.UUID] = Field(default_factory=list)
    matching_policies: list[RequestApprovalPolicySummary] = Field(default_factory=list)
    workflow_runs: list[RequestApprovalWorkflowSummary] = Field(default_factory=list)
    summary: RequestApprovalSummary
