"""Request and response schemas for persisted deviation findings.

The wire types here mirror the persisted ORM rows
(``PlaybookReviewRun`` and ``DeviationFinding``) plus a transient
"per-rule outcomes" projection that re-uses the matcher's response
shape so the Run-detail endpoint can show passes alongside the
persisted failures without duplicating the matcher's result type.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.playbook_review import PlaybookRuleMatchResult

# --------------------------------------------------------------------------
# Reviewer workflow
# --------------------------------------------------------------------------


# The values a caller may set via PATCH. ``superseded`` is owned by
# the rerun sweep and is not exposed for direct setting.
ReviewerFindingStatus = Literal["open", "reviewed", "ignored"]
PersistedFindingStatus = Literal["open", "reviewed", "ignored", "superseded"]


# --------------------------------------------------------------------------
# Requests
# --------------------------------------------------------------------------


class CreateReviewRunRequest(BaseModel):
    """Body for ``POST /api/contracts/{contract_id}/playbook-review/runs``."""

    model_config = ConfigDict(extra="forbid")

    playbook_id: uuid.UUID


class UpdateFindingStatusRequest(BaseModel):
    """Body for ``PATCH /api/contracts/{contract_id}/findings/{finding_id}``."""

    model_config = ConfigDict(extra="forbid")

    finding_status: ReviewerFindingStatus


# --------------------------------------------------------------------------
# Responses
# --------------------------------------------------------------------------


class DeviationFindingResponse(BaseModel):
    """Public projection of one persisted ``DeviationFinding`` row.

    The shape mirrors the ORM row 1:1 except for the columns Whereas
    deliberately does not surface (no encryption material, no storage
    keys — which the model does not carry anyway, but the explicit
    field list here is the contract).
    """

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    organization_id: uuid.UUID
    contract_id: uuid.UUID
    playbook_id: uuid.UUID
    review_run_id: uuid.UUID
    rule_id: str
    rule_title: str
    rule_type: str
    clause_type: str
    severity: str
    status: Literal["pass", "fail"]
    finding_status: PersistedFindingStatus
    message: str
    clause_id: uuid.UUID | None = None
    evidence_text: str | None = None
    span_start: int | None = None
    span_end: int | None = None
    matched_terms: list[str] = Field(default_factory=list)
    expected_value: str | None = None
    guidance: str | None = None
    preferred_language: str | None = None
    # Deviation findings come from deterministic playbook rule evaluation
    # (see app.services.playbook_matcher), not an LLM judgment call - the
    # matcher either matches a rule's condition against clause text or it
    # doesn't. There's no model uncertainty to express, so every finding
    # is 1.0. This is a schema-level default (not a persisted column;
    # `DeviationFinding` has none) so span-citation consumers that key off
    # a `confidence` field per the design principles still get one.
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    created_at: datetime
    updated_at: datetime


class ReviewRunSummary(BaseModel):
    """Compact projection of a ``PlaybookReviewRun``.

    Used by the list endpoint and by the Review tab's "latest run"
    summary card.
    """

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    organization_id: uuid.UUID
    contract_id: uuid.UUID
    playbook_id: uuid.UUID
    playbook_name: str
    rules_checked: int
    passed_count: int
    failed_count: int
    created_at: datetime


class ReviewRunDetail(ReviewRunSummary):
    """Run summary plus its persisted findings and the per-rule outcomes.

    ``findings`` is the persisted failures (DB rows). ``results`` is
    the matcher's full per-rule response, which the API layer
    recomputes for run-detail and post-create responses so the UI can
    show passes alongside fails. Pass results are not stored — the
    matcher is deterministic so this recomputation is cheap and stable.
    """

    model_config = ConfigDict(extra="forbid")

    findings: list[DeviationFindingResponse] = Field(default_factory=list)
    results: list[PlaybookRuleMatchResult] = Field(default_factory=list)
