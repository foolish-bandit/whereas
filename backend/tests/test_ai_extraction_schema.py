from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas.ai_extraction import (
    ExtractedEntity,
    ExtractionResult,
    ExtractionSource,
    assert_no_raw_document_bytes,
)


def test_schema_validates_normal_entity() -> None:
    entity = ExtractedEntity(
        label="organization",
        text="Acme Corp",
        span_start=0,
        span_end=9,
        confidence=0.93,
        source=ExtractionSource.GLINER,
        reviewed=False,
    )

    assert entity.label == "organization"
    assert entity.source == ExtractionSource.GLINER


def test_rejects_invalid_confidence() -> None:
    with pytest.raises(ValidationError):
        ExtractedEntity(
            label="date",
            text="January 1, 2026",
            span_start=0,
            span_end=15,
            confidence=1.2,
        )


def test_rejects_invalid_spans_when_source_text_is_provided() -> None:
    entity = ExtractedEntity(
        label="governing_law",
        text="State of Delaware",
        span_start=0,
        span_end=17,
        confidence=0.81,
        source=ExtractionSource.RULE,
    )

    with pytest.raises(ValueError):
        entity.validate_against_source_text("This agreement is governed by California law.")


def test_allows_reviewed_manual_corrections() -> None:
    corrected = ExtractedEntity(
        label="renewal_date",
        text="March 1, 2027",
        span_start=30,
        span_end=43,
        confidence=1.0,
        source=ExtractionSource.MANUAL,
        reviewed=True,
        normalized_value="2027-03-01",
        notes="Reviewed and corrected by legal ops.",
    )
    result = ExtractionResult(artifact_id=uuid4(), entities=[corrected])

    assert result.entities[0].reviewed is True
    assert result.entities[0].source == ExtractionSource.MANUAL


def test_no_forbidden_token_fixtures_for_raw_document_bytes() -> None:
    safe_payload = {
        "artifact_id": str(uuid4()),
        "entities": [{"label": "party", "text": "Alpha LLC"}],
    }
    assert_no_raw_document_bytes(safe_payload)

    with pytest.raises(ValueError):
        assert_no_raw_document_bytes({"document_blob": b"%PDF-1.7 ..."})
