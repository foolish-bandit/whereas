"""Request and response schemas for the playbook-review endpoint.

The matcher (`app.services.playbook_matcher`) returns a plain
dataclass result that this module wraps for the public API. Keeping
the wire types separate from the matcher's internal types keeps the
matcher dependency-light (no Pydantic) and makes the API contract
explicit at the boundary.
"""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.services.playbook_matcher import PlaybookReview, RuleMatchResult


class PlaybookReviewRequest(BaseModel):
    """Body for `POST /api/contracts/{contract_id}/playbook-review`."""

    playbook_id: uuid.UUID


class PlaybookRuleMatchResult(BaseModel):
    """Public projection of one rule's match outcome.

    Mirrors `app.services.playbook_matcher.RuleMatchResult`. The
    `span_start`/`span_end` come straight from the evidence Clause row
    (which is exact-span-grounded by construction in the segmentation
    pipeline), so highlighting in the UI composes with metadata and
    clause citations without any extra translation.
    """

    model_config = ConfigDict(extra="forbid")

    rule_id: str
    title: str
    rule_type: str
    clause_type: str
    severity: str
    status: Literal["pass", "fail"]
    message: str
    clause_id: uuid.UUID | None = None
    clause_ordinal: int | None = None
    clause_heading: str | None = None
    evidence_text: str | None = None
    span_start: int | None = None
    span_end: int | None = None
    matched_terms: list[str] = Field(default_factory=list)
    expected_value: str | None = None
    description: str | None = None
    guidance: str | None = None
    preferred_language: str | None = None


class PlaybookReviewResult(BaseModel):
    """Aggregate response for a (playbook, contract) review."""

    model_config = ConfigDict(extra="forbid")

    playbook_id: uuid.UUID
    playbook_name: str
    contract_id: uuid.UUID
    rules_checked: int
    passed_count: int
    failed_count: int
    results: list[PlaybookRuleMatchResult]


def review_to_response(
    *,
    playbook_id: uuid.UUID,
    playbook_name: str,
    contract_id: uuid.UUID,
    review: PlaybookReview,
) -> PlaybookReviewResult:
    """Build a `PlaybookReviewResult` from the matcher's dataclass result."""
    return PlaybookReviewResult(
        playbook_id=playbook_id,
        playbook_name=playbook_name,
        contract_id=contract_id,
        rules_checked=review.rules_checked,
        passed_count=review.passed_count,
        failed_count=review.failed_count,
        results=[_match_to_response(r) for r in review.results],
    )


def _match_to_response(r: RuleMatchResult) -> PlaybookRuleMatchResult:
    return PlaybookRuleMatchResult(
        rule_id=r.rule_id,
        title=r.title,
        rule_type=r.rule_type,
        clause_type=r.clause_type,
        severity=r.severity,
        status=r.status,  # type: ignore[arg-type]
        message=r.message,
        clause_id=uuid.UUID(r.clause_id) if r.clause_id is not None else None,
        clause_ordinal=r.clause_ordinal,
        clause_heading=r.clause_heading,
        evidence_text=r.evidence_text,
        span_start=r.span_start,
        span_end=r.span_end,
        matched_terms=list(r.matched_terms),
        expected_value=r.expected_value,
        description=r.description,
        guidance=r.guidance,
        preferred_language=r.preferred_language,
    )
