"""Tests for the deterministic playbook matcher service.

Covers each rule type's pass/fail semantics, evidence selection,
result counts, and the load-bearing invariants:

- The matcher is pure (no DB, no LLM, no I/O).
- The matcher reports exact `span_start`/`span_end` straight off the
  source clause; a future regression that paraphrases or recomputes
  spans must fail this suite loudly.
- `text_contains` requires *all* listed terms in a single matching
  clause to pass; partial matches surface as fail-with-evidence.
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest

from app.services.playbook_loader import PlaybookDocument, parse_playbook
from app.services.playbook_matcher import (
    PlaybookReview,
    RuleMatchResult,
    match_playbook,
)

# --------------------------------------------------------------------------
# Test fixtures
# --------------------------------------------------------------------------


class _StubClause:
    """Minimal Clause double for matcher tests.

    The matcher reads `id`, `ordinal`, `clause_type`, `heading`,
    `text`, `span_start`, and `span_end`. We avoid spinning up the
    ORM here because the matcher does not touch a session, so a
    plain object with the right attributes is enough.
    """

    def __init__(
        self,
        *,
        clause_type: str | None,
        text: str,
        span_start: int,
        span_end: int,
        ordinal: int,
        heading: str | None = None,
        clause_id: uuid.UUID | None = None,
    ) -> None:
        self.id = clause_id or uuid.uuid4()
        self.ordinal = ordinal
        self.clause_type = clause_type
        self.heading = heading
        self.text = text
        self.span_start = span_start
        self.span_end = span_end


def _make_clauses(*specs: dict[str, Any]) -> list[_StubClause]:
    """Build a list of stub clauses from compact spec dicts.

    The spec sets `text` and `clause_type`; ordinals and spans are
    auto-assigned in the order given so callers can focus on the
    interesting fields.
    """
    clauses: list[_StubClause] = []
    cursor = 0
    for index, spec in enumerate(specs):
        text = str(spec["text"])
        start = cursor
        end = start + len(text)
        clauses.append(
            _StubClause(
                clause_type=spec.get("clause_type"),
                text=text,
                span_start=start,
                span_end=end,
                ordinal=spec.get("ordinal", index),
                heading=spec.get("heading"),
            )
        )
        cursor = end + 1  # +1 to mimic a separator between clauses
    return clauses


def _playbook(yaml_source: str) -> PlaybookDocument:
    return parse_playbook(yaml_source)


# --------------------------------------------------------------------------
# required_clause
# --------------------------------------------------------------------------


class TestRequiredClause:
    def test_passes_when_matching_clause_exists(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Confidentiality clause must be present"
    clause_type: confidentiality
    severity: high
    rule_type: required_clause
"""
        )
        clauses = _make_clauses(
            {"clause_type": "confidentiality", "text": "Confidential Information."},
        )
        review = match_playbook(playbook, clauses)
        assert review.passed_count == 1
        assert review.failed_count == 0
        result = review.results[0]
        assert result.status == "pass"
        assert result.clause_id == str(clauses[0].id)
        assert result.span_start == clauses[0].span_start
        assert result.span_end == clauses[0].span_end

    def test_fails_when_no_matching_clause(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Indemnification clause must be present"
    clause_type: indemnification
    severity: high
    rule_type: required_clause
"""
        )
        clauses = _make_clauses(
            {"clause_type": "confidentiality", "text": "Some confidentiality clause."},
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        assert result.status == "fail"
        assert result.clause_id is None
        assert result.span_start is None
        assert "No clause" in result.message

    def test_clause_type_matching_is_case_insensitive(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "title"
    clause_type: Confidentiality
    severity: low
    rule_type: required_clause
"""
        )
        clauses = _make_clauses(
            {"clause_type": "confidentiality", "text": "Body"},
        )
        review = match_playbook(playbook, clauses)
        assert review.passed_count == 1


# --------------------------------------------------------------------------
# text_contains (all-of semantics)
# --------------------------------------------------------------------------


class TestTextContains:
    def test_passes_when_all_terms_present_case_insensitive(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Assignment requires prior written consent"
    clause_type: assignment
    severity: medium
    rule_type: text_contains
    required_terms:
      - "consent"
      - "prior written"
"""
        )
        clauses = _make_clauses(
            {
                "clause_type": "assignment",
                "text": "Neither party may assign without the PRIOR WRITTEN CONSENT of the other.",
            },
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        assert result.status == "pass"
        assert set(result.matched_terms) == {"consent", "prior written"}
        assert result.clause_id == str(clauses[0].id)

    def test_fails_when_term_missing(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Assignment requires consent"
    clause_type: assignment
    severity: medium
    rule_type: text_contains
    required_terms:
      - "consent"
      - "prior written consent"
"""
        )
        clauses = _make_clauses(
            {
                "clause_type": "assignment",
                "text": "Either party may assign with consent of the other.",
            },
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        assert result.status == "fail"
        # Partial match surfaces the term that did appear and reports the
        # missing one.
        assert "consent" in result.matched_terms
        assert "prior written consent" not in result.matched_terms
        assert "prior written consent" in result.message

    def test_fails_when_no_clause_of_type(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Assignment requires consent"
    clause_type: assignment
    severity: medium
    rule_type: text_contains
    required_terms:
      - "consent"
"""
        )
        clauses = _make_clauses(
            {"clause_type": "termination", "text": "Termination clause body."},
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        assert result.status == "fail"
        assert result.clause_id is None
        assert result.matched_terms == ()
        assert "No clause" in result.message

    def test_passes_against_only_clause_with_full_term_set(self) -> None:
        # Two assignment clauses; only the second contains all required terms.
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Assignment requires consent"
    clause_type: assignment
    severity: medium
    rule_type: text_contains
    required_terms:
      - "consent"
      - "prior written"
"""
        )
        clauses = _make_clauses(
            {
                "clause_type": "assignment",
                "text": "First assignment clause without the required language.",
            },
            {
                "clause_type": "assignment",
                "text": "Second assignment clause requiring prior written consent.",
            },
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        assert result.status == "pass"
        assert result.clause_id == str(clauses[1].id)
        assert result.span_start == clauses[1].span_start

    def test_partial_match_evidence_picks_clause_with_most_matches(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Assignment terms"
    clause_type: assignment
    severity: medium
    rule_type: text_contains
    required_terms:
      - "alpha"
      - "beta"
      - "gamma"
"""
        )
        clauses = _make_clauses(
            {"clause_type": "assignment", "text": "Mentions alpha only."},
            {"clause_type": "assignment", "text": "Mentions alpha and beta."},
            {"clause_type": "assignment", "text": "Has nothing relevant."},
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        assert result.status == "fail"
        # The middle clause has the most matched terms; it wins as evidence.
        assert result.clause_id == str(clauses[1].id)
        assert set(result.matched_terms) == {"alpha", "beta"}


# --------------------------------------------------------------------------
# preferred_value
# --------------------------------------------------------------------------


class TestPreferredValue:
    def test_passes_case_insensitive_substring_match(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Governing law should be California"
    clause_type: governing_law
    severity: medium
    rule_type: preferred_value
    expected_value: California
"""
        )
        clauses = _make_clauses(
            {
                "clause_type": "governing_law",
                "text": "This Agreement is governed by the laws of CALIFORNIA.",
            },
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        assert result.status == "pass"
        assert result.expected_value == "California"
        assert result.clause_id == str(clauses[0].id)

    def test_fails_when_expected_value_absent(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Governing law should be California"
    clause_type: governing_law
    severity: medium
    rule_type: preferred_value
    expected_value: California
"""
        )
        clauses = _make_clauses(
            {
                "clause_type": "governing_law",
                "text": "Governed by the laws of Delaware.",
            },
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        assert result.status == "fail"
        # Evidence carries the matching-clause-type clause so reviewers
        # can see what is actually in the contract.
        assert result.clause_id == str(clauses[0].id)
        assert result.expected_value == "California"

    def test_fails_when_no_matching_clause(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Governing law should be California"
    clause_type: governing_law
    severity: medium
    rule_type: preferred_value
    expected_value: California
"""
        )
        clauses = _make_clauses(
            {"clause_type": "termination", "text": "Termination terms."},
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        assert result.status == "fail"
        assert result.clause_id is None
        assert "No clause" in result.message


# --------------------------------------------------------------------------
# Aggregate result counts and ordering
# --------------------------------------------------------------------------


class TestAggregateResults:
    def test_counts_match_results(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: pass1
    title: "p1"
    clause_type: confidentiality
    severity: high
    rule_type: required_clause
  - id: fail1
    title: "f1"
    clause_type: indemnification
    severity: high
    rule_type: required_clause
  - id: pass2
    title: "p2"
    clause_type: governing_law
    severity: low
    rule_type: preferred_value
    expected_value: Delaware
"""
        )
        clauses = _make_clauses(
            {"clause_type": "confidentiality", "text": "Confidentiality body."},
            {"clause_type": "governing_law", "text": "Governed by Delaware law."},
        )
        review = match_playbook(playbook, clauses)
        assert review.rules_checked == 3
        assert review.passed_count == 2
        assert review.failed_count == 1
        assert {r.rule_id for r in review.results if r.status == "pass"} == {
            "pass1",
            "pass2",
        }

    def test_order_matches_playbook_order(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: third
    title: t
    clause_type: x
    severity: low
    rule_type: required_clause
  - id: first
    title: t
    clause_type: x
    severity: low
    rule_type: required_clause
  - id: second
    title: t
    clause_type: x
    severity: low
    rule_type: required_clause
"""
        )
        review = match_playbook(playbook, [])
        assert [r.rule_id for r in review.results] == ["third", "first", "second"]

    def test_empty_playbook_returns_zero_counts(self) -> None:
        playbook = _playbook("name: empty\nrules: []\n")
        review = match_playbook(playbook, _make_clauses())
        assert review.rules_checked == 0
        assert review.passed_count == 0
        assert review.failed_count == 0
        assert review.results == ()


# --------------------------------------------------------------------------
# Invariants
# --------------------------------------------------------------------------


class TestInvariants:
    def test_evidence_span_is_copied_verbatim_from_clause(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: t
    clause_type: confidentiality
    severity: low
    rule_type: required_clause
"""
        )
        clauses = _make_clauses(
            {"clause_type": "confidentiality", "text": "Confidentiality body."},
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        # Spans are exactly the Clause's spans, never recomputed from text.
        assert result.span_start == clauses[0].span_start
        assert result.span_end == clauses[0].span_end

    def test_matcher_does_not_mutate_inputs(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: t
    clause_type: x
    severity: low
    rule_type: required_clause
"""
        )
        clauses = _make_clauses({"clause_type": "x", "text": "body"})
        original_clause_ids = [c.id for c in clauses]
        original_text = clauses[0].text

        match_playbook(playbook, clauses)

        # No new attributes, no reassignment, no list reordering.
        assert [c.id for c in clauses] == original_clause_ids
        assert clauses[0].text == original_text

    def test_clauses_with_no_clause_type_are_ignored(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: t
    clause_type: confidentiality
    severity: low
    rule_type: required_clause
"""
        )
        # The unclassified clause must not satisfy any rule.
        clauses = _make_clauses(
            {"clause_type": None, "text": "Some unclassified body."},
        )
        review = match_playbook(playbook, clauses)
        assert review.results[0].status == "fail"

    def test_result_type_carries_rule_metadata_through(self) -> None:
        playbook = _playbook(
            """
name: t
rules:
  - id: r1
    title: "Rule with guidance"
    clause_type: confidentiality
    severity: high
    rule_type: required_clause
    description: "explainer"
    guidance: "how to triage"
    preferred_language: "redline"
"""
        )
        clauses = _make_clauses(
            {"clause_type": "confidentiality", "text": "Body."},
        )
        review = match_playbook(playbook, clauses)
        result = review.results[0]
        assert result.description == "explainer"
        assert result.guidance == "how to triage"
        assert result.preferred_language == "redline"
        assert isinstance(result, RuleMatchResult)
        assert isinstance(review, PlaybookReview)


# --------------------------------------------------------------------------
# Sentinel: matcher must not import LLM dependencies
# --------------------------------------------------------------------------


def test_matcher_module_source_does_not_reference_llm_clients() -> None:
    """Guard against accidental LLM dependencies in the matcher path.

    PR #21 is deterministic-only. A regression that adds an LLM SDK
    import anywhere in the matcher source must fail this loudly.
    Source-based rather than sys.modules-based so test ordering does
    not affect the outcome — other tests legitimately import
    litellm via the upload pipeline.
    """
    import inspect

    import app.services.playbook_matcher as matcher_mod

    src = inspect.getsource(matcher_mod)
    for token in ("litellm", "openai", "anthropic", "ollama"):
        assert token not in src, (
            f"matcher module references {token!r}; the matcher path must "
            "remain LLM-free in PR #21"
        )


def test_matcher_does_not_call_session_methods(monkeypatch: pytest.MonkeyPatch) -> None:
    """The matcher takes pre-loaded inputs — it must never touch a Session.

    We can't easily intercept "no session use" without poisoning the
    session object, so we proxy this by asserting `app.services.playbook_matcher`
    does not reference SQLAlchemy session APIs at all.
    """
    import inspect

    import app.services.playbook_matcher as matcher_mod

    src = inspect.getsource(matcher_mod)
    forbidden_tokens = ("AsyncSession", "session.execute", "session.add")
    for token in forbidden_tokens:
        assert token not in src, (
            f"matcher module references {token!r}; it must remain pure"
        )
