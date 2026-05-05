"""Tests for the extraction span validation logic.

These exist because span validation is the load-bearing reliability mechanism.
If this breaks, hallucinated metadata leaks into production. Every change to
extraction.py should run these tests.
"""
from app.services.extraction import _validate_span


class TestSpanValidation:
    def test_returns_offsets_for_exact_match(self) -> None:
        document = "This Agreement is governed by the laws of the State of Delaware."
        span = "the State of Delaware"
        start, end = _validate_span(span, document)
        assert start is not None
        assert end is not None
        assert document[start:end] == span

    def test_returns_none_for_missing_span(self) -> None:
        document = "This Agreement is governed by the laws of California."
        span = "the State of Delaware"
        start, end = _validate_span(span, document)
        assert start is None
        assert end is None

    def test_returns_none_for_paraphrased_span(self) -> None:
        """If the model paraphrases instead of quoting, we reject the span."""
        document = "Term shall be three (3) years from the Effective Date."
        span = "Term is 3 years"  # paraphrase, not verbatim
        start, end = _validate_span(span, document)
        assert start is None
        assert end is None

    def test_returns_none_for_whitespace_normalization(self) -> None:
        """Whitespace differences should fail validation - we want strict matching."""
        document = "Indemnification\n\n   cap shall be twelve months fees."
        span = "Indemnification cap shall be twelve months fees."  # collapsed whitespace
        start, end = _validate_span(span, document)
        assert start is None

    def test_returns_none_for_empty_span(self) -> None:
        start, end = _validate_span(None, "some document")
        assert start is None
        assert end is None
        start, end = _validate_span("", "some document")
        assert start is None
        assert end is None

    def test_first_occurrence_wins(self) -> None:
        """When a span appears multiple times, we take the first."""
        document = "Confidential Information. Confidential Information means..."
        span = "Confidential Information"
        start, end = _validate_span(span, document)
        assert start == 0
        assert end == len(span)
