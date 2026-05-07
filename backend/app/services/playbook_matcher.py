"""Deterministic playbook rule matching against segmented clauses.

A *playbook matcher* compares the parsed rules of a `PlaybookDocument`
(see `app.services.playbook_loader`) against the persisted `Clause`
rows for a contract and returns a list of pass/fail results. The
matcher is **pure**: it never writes to the database, never calls an
LLM, never derives anything that is not directly grounded in the
clause spans the segmenter persisted.

This is the first step of the deviation pipeline. PR #21's scope is
the matching engine only — persisted findings, suggested redlines,
and LLM-assisted reasoning are explicitly out of scope and live in
follow-up PRs.

Rule semantics (v1, deterministic)
----------------------------------

`required_clause`
    Pass iff at least one clause of the rule's `clause_type` exists
    on the contract. Evidence on pass is the first matching clause.

`text_contains`
    Pass iff at least one clause of the rule's `clause_type` contains
    *all* of the rule's `required_terms` (case-insensitive substring
    match). Evidence on pass is the first such clause and
    `matched_terms` echoes back the terms (all of them, by definition
    of pass). On fail, evidence — if any matching-clause-type clause
    exists — is the matching clause with the largest subset of terms,
    and `matched_terms` reports that partial subset so the reviewer
    can see what was already in the contract.

`preferred_value`
    Pass iff the rule's `expected_value` appears as a case-insensitive
    substring in at least one clause of the rule's `clause_type`.
    Evidence on pass is the first such clause. On fail with at least
    one matching-clause-type clause, evidence is the first such
    clause so the reviewer can see what is in the contract instead.

Clause-type matching is case-insensitive (`casefold()` on both sides)
to be forgiving of mixed-case playbook authoring; the segmentation
taxonomy is conventionally lowercase but a stray `Confidentiality`
should not silently fail to match `confidentiality` clauses.

The matcher operates on materialized inputs (a `PlaybookDocument` and
a sequence of `Clause` rows) rather than touching the session itself,
so callers can compose it with whatever data-loading strategy they
prefer. The API layer in `app.api.contracts` is the only caller in
v1.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.models import Clause
from app.services.playbook_loader import (
    PlaybookDocument,
    PreferredValueRule,
    RequiredClauseRule,
    TextContainsRule,
)

# --------------------------------------------------------------------------
# Public constants
# --------------------------------------------------------------------------


# Maximum length of the evidence excerpt returned in API responses. Clauses
# can be hundreds of lines long; the UI does not need the entire body, since
# the exact `span_start`/`span_end` are also returned and the existing
# document viewer can render the full clause from those offsets.
_EVIDENCE_EXCERPT_MAX_CHARS = 400


# --------------------------------------------------------------------------
# Result shape (data classes; the API layer wraps these in Pydantic)
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class RuleMatchResult:
    """One rule's outcome against a contract's clauses.

    Mirrors `app.schemas.playbook_review.PlaybookRuleMatchResult`. We
    keep this as a plain dataclass at the service layer so the matcher
    has no Pydantic dependency in tests and stays cheap to construct.
    """

    rule_id: str
    title: str
    rule_type: str
    clause_type: str
    severity: str
    status: str  # "pass" | "fail"
    message: str
    clause_id: str | None
    clause_ordinal: int | None
    clause_heading: str | None
    evidence_text: str | None
    span_start: int | None
    span_end: int | None
    matched_terms: tuple[str, ...]
    expected_value: str | None
    description: str | None
    guidance: str | None
    preferred_language: str | None


@dataclass(frozen=True)
class PlaybookReview:
    """Aggregate result for a (playbook, contract) pair."""

    rules_checked: int
    passed_count: int
    failed_count: int
    results: tuple[RuleMatchResult, ...]


# --------------------------------------------------------------------------
# Public matcher API
# --------------------------------------------------------------------------


def match_playbook(
    playbook: PlaybookDocument,
    clauses: Sequence[Clause],
) -> PlaybookReview:
    """Apply every rule in `playbook` to `clauses` and aggregate results.

    Pure, deterministic, no I/O. Order in `results` matches the order
    of rules in the playbook so callers (and the UI) can rely on a
    stable presentation.
    """
    # Preindex clauses by case-insensitive clause_type for O(rules+clauses)
    # behavior. Clauses without a clause_type are skipped — they cannot
    # match a rule (which always requires a non-empty clause_type).
    by_type: dict[str, list[Clause]] = {}
    for clause in clauses:
        if not clause.clause_type:
            continue
        key = clause.clause_type.casefold()
        by_type.setdefault(key, []).append(clause)
    for rows in by_type.values():
        rows.sort(key=lambda c: c.ordinal)

    results: list[RuleMatchResult] = []
    for rule in playbook.rules:
        matching = by_type.get(rule.clause_type.casefold(), [])
        if isinstance(rule, RequiredClauseRule):
            results.append(_evaluate_required_clause(rule, matching))
        elif isinstance(rule, TextContainsRule):
            results.append(_evaluate_text_contains(rule, matching))
        elif isinstance(rule, PreferredValueRule):
            results.append(_evaluate_preferred_value(rule, matching))
        else:  # pragma: no cover - exhaustive over PR #20's discriminated union
            raise AssertionError(f"unsupported rule type: {type(rule).__name__}")

    passed = sum(1 for r in results if r.status == "pass")
    failed = len(results) - passed
    return PlaybookReview(
        rules_checked=len(results),
        passed_count=passed,
        failed_count=failed,
        results=tuple(results),
    )


# --------------------------------------------------------------------------
# Per-rule-type evaluation
# --------------------------------------------------------------------------


def _evaluate_required_clause(
    rule: RequiredClauseRule,
    matching: list[Clause],
) -> RuleMatchResult:
    if matching:
        evidence = matching[0]
        return _result(
            rule=rule,
            status="pass",
            message=(
                f"A {rule.clause_type!r} clause is present (clause "
                f"#{evidence.ordinal + 1})."
            ),
            evidence=evidence,
            matched_terms=(),
        )
    return _result(
        rule=rule,
        status="fail",
        message=(
            f"No clause of type {rule.clause_type!r} was found in the "
            "contract."
        ),
        evidence=None,
        matched_terms=(),
    )


def _evaluate_text_contains(
    rule: TextContainsRule,
    matching: list[Clause],
) -> RuleMatchResult:
    if not matching:
        return _result(
            rule=rule,
            status="fail",
            message=(
                f"No clause of type {rule.clause_type!r} was found in the "
                "contract; cannot evaluate required terms."
            ),
            evidence=None,
            matched_terms=(),
        )

    full_pass: tuple[Clause, tuple[str, ...]] | None = None
    best_partial: tuple[Clause, tuple[str, ...]] | None = None

    for clause in matching:
        haystack = (clause.text or "").casefold()
        found = tuple(
            term for term in rule.required_terms
            if term.casefold() in haystack
        )
        if len(found) == len(rule.required_terms):
            full_pass = (clause, found)
            break  # first full-pass clause wins; stable by ordinal
        if best_partial is None or len(found) > len(best_partial[1]):
            best_partial = (clause, found)

    if full_pass is not None:
        evidence, terms = full_pass
        return _result(
            rule=rule,
            status="pass",
            message=(
                f"All {len(rule.required_terms)} required term(s) found "
                f"in clause #{evidence.ordinal + 1}."
            ),
            evidence=evidence,
            matched_terms=terms,
        )

    # No clause contained the full set of required terms. Surface the
    # closest partial match so the reviewer can see what is already in
    # the contract.
    assert best_partial is not None  # matching is non-empty
    evidence, terms = best_partial
    missing = [t for t in rule.required_terms if t.casefold() not in (evidence.text or "").casefold()]
    return _result(
        rule=rule,
        status="fail",
        message=(
            f"Clause #{evidence.ordinal + 1} is missing required term(s): "
            f"{', '.join(repr(t) for t in missing)}."
        ),
        evidence=evidence,
        matched_terms=terms,
    )


def _evaluate_preferred_value(
    rule: PreferredValueRule,
    matching: list[Clause],
) -> RuleMatchResult:
    if not matching:
        return _result(
            rule=rule,
            status="fail",
            message=(
                f"No clause of type {rule.clause_type!r} was found in the "
                "contract; cannot evaluate preferred value."
            ),
            evidence=None,
            matched_terms=(),
        )

    needle = rule.expected_value.casefold()
    for clause in matching:
        if needle in (clause.text or "").casefold():
            return _result(
                rule=rule,
                status="pass",
                message=(
                    f"Preferred value {rule.expected_value!r} found in "
                    f"clause #{clause.ordinal + 1}."
                ),
                evidence=clause,
                matched_terms=(),
            )

    # No clause contains the preferred value. Surface the first matching
    # clause-type clause as evidence so the reviewer can compare.
    evidence = matching[0]
    return _result(
        rule=rule,
        status="fail",
        message=(
            f"Preferred value {rule.expected_value!r} not found in any "
            f"{rule.clause_type!r} clause."
        ),
        evidence=evidence,
        matched_terms=(),
    )


# --------------------------------------------------------------------------
# Result construction
# --------------------------------------------------------------------------


def _result(
    *,
    rule: RequiredClauseRule | TextContainsRule | PreferredValueRule,
    status: str,
    message: str,
    evidence: Clause | None,
    matched_terms: tuple[str, ...],
) -> RuleMatchResult:
    expected_value = (
        rule.expected_value if isinstance(rule, PreferredValueRule) else None
    )
    if evidence is None:
        return RuleMatchResult(
            rule_id=rule.id,
            title=rule.title,
            rule_type=rule.rule_type,
            clause_type=rule.clause_type,
            severity=rule.severity,
            status=status,
            message=message,
            clause_id=None,
            clause_ordinal=None,
            clause_heading=None,
            evidence_text=None,
            span_start=None,
            span_end=None,
            matched_terms=matched_terms,
            expected_value=expected_value,
            description=rule.description,
            guidance=rule.guidance,
            preferred_language=rule.preferred_language,
        )
    return RuleMatchResult(
        rule_id=rule.id,
        title=rule.title,
        rule_type=rule.rule_type,
        clause_type=rule.clause_type,
        severity=rule.severity,
        status=status,
        message=message,
        clause_id=str(evidence.id),
        clause_ordinal=evidence.ordinal,
        clause_heading=evidence.heading,
        evidence_text=_excerpt(evidence.text),
        span_start=evidence.span_start,
        span_end=evidence.span_end,
        matched_terms=matched_terms,
        expected_value=expected_value,
        description=rule.description,
        guidance=rule.guidance,
        preferred_language=rule.preferred_language,
    )


def _excerpt(text: str | None) -> str | None:
    """Truncate a clause body for the API response.

    The frontend has the contract's full text and the exact span; the
    excerpt exists so list views render without an extra request. We
    truncate on character count rather than a "smart" sentence-aware
    boundary because the goal is a bounded payload, not a polished
    snippet.
    """
    if not text:
        return None
    if len(text) <= _EVIDENCE_EXCERPT_MAX_CHARS:
        return text
    return text[: _EVIDENCE_EXCERPT_MAX_CHARS - 1].rstrip() + "…"
