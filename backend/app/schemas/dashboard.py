"""Schemas for the dashboard summary endpoint.

The dashboard intentionally has its own compact projections instead of
reusing the full ``ContractRequestResponse`` / ``InboxItemResponse`` /
``ContractListItemResponse`` shapes:

* The detail schemas carry fields the dashboard doesn't need
  (``description``, ``metadata_json``, ``full_text`` for contracts via
  ``ContractDetailResponse``) and dragging them into a summary
  surface widens the response for no reader benefit.
* It also avoids accidentally surfacing storage internals or anything
  signer-PII-shaped if a future field gets added to the detail
  schemas — the dashboard list items are an explicit allowlist.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field


class DashboardCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    open_requests: int
    in_progress_requests: int
    urgent_or_high_priority_requests: int
    open_inbox_items: int
    overdue_inbox_items: int
    contracts_total: int
    contracts_sent_for_signature: int
    contracts_executed: int
    templates_active: int
    # PR #50 — narrow approval workflow surface. ``active_approval_workflows``
    # counts runs in the ``active`` state, ``pending_approval_steps`` counts
    # steps still waiting for a decision on those active runs, and
    # ``overdue_approval_steps`` is the subset of pending steps whose
    # ``due_date`` is in the past relative to ``today``.
    active_approval_workflows: int = 0
    pending_approval_steps: int = 0
    overdue_approval_steps: int = 0


class DashboardRequestSummary(BaseModel):
    """Compact request projection for dashboard lists.

    Drops ``description``, ``metadata_json``, ``requester_name``,
    ``requester_email`` — the dashboard surfaces a one-line summary,
    not the full intake record. Detail pages own the rest.
    """

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    title: str
    status: str
    priority: str | None = None
    request_type: str | None = None
    contract_type: str | None = None
    counterparty_name: str | None = None
    due_date: date | None = None
    linked_contract_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class DashboardInboxSummary(BaseModel):
    """Compact inbox-item projection for dashboard lists.

    Drops ``description``, ``metadata_json``, and the assignee/creator
    UUIDs (the dashboard is org-scoped, not assignee-scoped, in this
    PR).
    """

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID
    title: str
    status: str
    priority: str | None = None
    item_type: str
    due_date: date | None = None
    request_id: uuid.UUID | None = None
    contract_id: uuid.UUID | None = None
    template_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class DashboardContractSummary(BaseModel):
    """Compact contract projection for dashboard lists.

    Storage / encryption columns (``s3_key``, ``wrapped_dek``) and the
    full extracted text are deliberately excluded — they are not part
    of any public response in the rest of the app and have no place on
    a summary surface.

    ``has_generated_docx`` and ``has_signed_pdf`` are assembled by the
    dashboard service from a single artifact-existence query so the
    UI can render "draft generated" / "signed PDF on file" badges
    without an extra round trip.
    """

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    title: str
    status: str
    created_at: datetime
    updated_at: datetime
    docuseal_submission_id: str | None = None
    has_generated_docx: bool = False
    has_signed_pdf: bool = False


class DashboardUpcoming(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requests_due_soon: list[DashboardRequestSummary] = Field(default_factory=list)
    inbox_items_due_soon: list[DashboardInboxSummary] = Field(default_factory=list)


class DashboardRecentActivity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recent_contracts: list[DashboardContractSummary] = Field(default_factory=list)
    recent_requests: list[DashboardRequestSummary] = Field(default_factory=list)
    recent_signed_contracts: list[DashboardContractSummary] = Field(default_factory=list)


class DashboardSummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    counts: DashboardCounts
    upcoming: DashboardUpcoming
    recent_activity: DashboardRecentActivity
