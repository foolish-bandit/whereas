"""Request and response schemas for LLM-generated suggested redlines.

Wire shape mirrors the persisted ``SuggestedRedline`` ORM row.
Reviewer-mutable fields (``status`` only) are validated by the
``UpdateRedlineStatusRequest`` body schema; everything else is
immutable post-write.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

# Reviewer-settable values for the redline workflow. Every value the
# backend persists is also valid here — there is no equivalent of the
# findings ``superseded`` state that the API hides.
RedlineStatus = Literal["proposed", "accepted", "rejected"]


class UpdateRedlineStatusRequest(BaseModel):
    """Body for ``PATCH /api/contracts/{contract_id}/findings/{finding_id}/redlines/{redline_id}``."""

    model_config = ConfigDict(extra="forbid")

    status: RedlineStatus


class SuggestedRedlineResponse(BaseModel):
    """Public projection of one persisted ``SuggestedRedline`` row."""

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    organization_id: uuid.UUID
    contract_id: uuid.UUID
    finding_id: uuid.UUID
    redline_text: str
    rationale: str | None = None
    model_name: str
    prompt_version: str
    confidence: float
    status: RedlineStatus
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
