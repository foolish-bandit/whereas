"""Tests for the `confidence` field on `DeviationFindingResponse`.

Deviation findings come from deterministic playbook rule matching (see
`app.services.playbook_matcher`), not an LLM judgment call, so a fixed 1.0
is the honest confidence value - there is no model uncertainty to express.
Per the span-citation design principle, every AI/rule-surfaced piece of
information must carry a confidence score; this schema-level default
covers findings without requiring a new persisted column.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.schemas.findings import DeviationFindingResponse


def _base_kwargs() -> dict:
    now = datetime.now(UTC)
    return {
        "id": uuid.uuid4(),
        "organization_id": uuid.uuid4(),
        "contract_id": uuid.uuid4(),
        "playbook_id": uuid.uuid4(),
        "review_run_id": uuid.uuid4(),
        "rule_id": "governing-law-california",
        "rule_title": "Governing law should be California",
        "rule_type": "preferred_value",
        "clause_type": "governing_law",
        "severity": "medium",
        "status": "fail",
        "finding_status": "open",
        "message": "Governing law is Delaware, expected California.",
        "created_at": now,
        "updated_at": now,
    }


def test_confidence_defaults_to_one_when_not_supplied() -> None:
    """Mirrors how `_finding_response` in api/contracts.py constructs this
    schema today: it does not pass `confidence` explicitly, so the
    deterministic default must apply.
    """
    finding = DeviationFindingResponse(**_base_kwargs())
    assert finding.confidence == 1.0


def test_confidence_rejects_out_of_range_values() -> None:
    with pytest.raises(ValidationError):
        DeviationFindingResponse(**_base_kwargs(), confidence=1.5)
    with pytest.raises(ValidationError):
        DeviationFindingResponse(**_base_kwargs(), confidence=-0.1)


def test_confidence_accepts_explicit_value_in_range() -> None:
    finding = DeviationFindingResponse(**_base_kwargs(), confidence=1.0)
    assert finding.confidence == 1.0
