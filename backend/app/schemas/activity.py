"""Schemas for activity timeline endpoints (PR #58).

Read-only chronological feed for a request or a contract. Items are
projected from ``AuditEvent`` rows — every nested model uses
``extra="forbid"`` and only allowlists the safe identifier set, so
``storage_key`` / ``wrapped_dek`` / signer PII / DocuSeal secrets
cannot leak even if a future audit detail accidentally carried one.

The timeline is **explainability only**: the endpoint never mutates
state, never auto-creates workflows, never changes the gate's allow/
block rules.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ActivityTimelineItem(BaseModel):
    """One row in the activity feed.

    ``title`` is a short human-readable label rendered server-side so
    every client renders the same string (no client-side i18n / format
    drift). ``description`` is an optional second line. ``metadata`` is
    a small allowlisted projection of the underlying audit event's
    ``details`` — never the raw ``details`` blob.
    """

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    event_type: str
    occurred_at: datetime
    actor_user_id: uuid.UUID | None = None
    title: str
    description: str | None = None
    request_id: uuid.UUID | None = None
    contract_id: uuid.UUID | None = None
    workflow_run_id: uuid.UUID | None = None
    approval_step_id: uuid.UUID | None = None
    step_order: int | None = None
    source: str | None = None


class ActivityTimelineResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ActivityTimelineItem] = Field(default_factory=list)
