"""Tests for the heuristic clause segmentation service.

Covers the pure `segment_text` function (boundary detection, merging,
fallbacks, classification) and the `segment_and_persist_clauses`
persistence layer (span validation, idempotency, force re-run, org
scoping, ungrounded-text rejection).
"""
from __future__ import annotations

import uuid
from typing import Any

import pytest

from app.models import Clause, Contract, Organization, User
from app.services import clause_segmentation
from app.services.clause_segmentation import (
    _CONFIDENCE_HEADING_AND_TYPE,
    _CONFIDENCE_HEADING_ONLY,
    _CONFIDENCE_NO_EVIDENCE,
    _CONFIDENCE_TYPE_ONLY,
    MAX_CLAUSES_HARD_CAP,
    MIN_CLAUSE_LEN_CHARS,
    SEGMENTATION_METHOD_HEURISTIC_V1,
    ClauseCandidate,
    ClauseSegmentationError,
    _validate_span,
    segment_and_persist_clauses,
    segment_text,
)

# --------------------------------------------------------------------------
# In-memory async session double, modeled on test_extraction_persistence.
# --------------------------------------------------------------------------


class InMemoryScalarResult:
    def __init__(self, values: list[Any] | None = None) -> None:
        self._values = values or []

    def scalars(self) -> InMemoryScalarResult:
        return self

    def all(self) -> list[Any]:
        return list(self._values)


class InMemorySession:
    def __init__(self) -> None:
        self.organizations: list[Organization] = []
        self.users: list[User] = []
        self.contracts: list[Contract] = []
        self.clauses: list[Clause] = []
        self.flush_count = 0
        self.current_contract: Contract | None = None

    def add(self, obj: Any) -> None:
        if isinstance(obj, Organization):
            self.organizations.append(obj)
        elif isinstance(obj, User):
            self.users.append(obj)
        elif isinstance(obj, Contract):
            self.contracts.append(obj)
        elif isinstance(obj, Clause):
            self.clauses.append(obj)
        else:  # pragma: no cover
            raise AssertionError(f"unexpected added object: {obj!r}")

    def add_all(self, objs: list[Any]) -> None:
        for obj in objs:
            self.add(obj)

    async def flush(self) -> None:
        self.flush_count += 1

    async def execute(self, statement: Any) -> InMemoryScalarResult:
        # The service issues two shapes of statement:
        #   - select(Clause).where(Clause.contract_id == X).order_by(...)
        #   - delete(Clause).where(Clause.contract_id == X)
        table = getattr(getattr(statement, "table", None), "name", None)
        if table == "clauses":
            target = self.current_contract
            assert target is not None
            self.clauses = [
                c for c in self.clauses if c.contract_id != target.id
            ]
            return InMemoryScalarResult([])

        # Fallback: assume select(Clause)
        target = self.current_contract
        assert target is not None
        rows = sorted(
            (c for c in self.clauses if c.contract_id == target.id),
            key=lambda c: c.ordinal,
        )
        return InMemoryScalarResult(rows)


@pytest.fixture
def session() -> InMemorySession:
    return InMemorySession()


def _make_contract(session: InMemorySession, full_text: str | None) -> Contract:
    org = Organization(id=uuid.uuid4(), name="Acme")
    user = User(
        id=uuid.uuid4(),
        organization_id=org.id,
        email=f"u-{uuid.uuid4()}@example.com",
        password_hash="hash",
        display_name="Lawyer",
    )
    contract = Contract(
        id=uuid.uuid4(),
        organization_id=org.id,
        uploaded_by=user.id,
        title="Test contract",
        s3_key="contracts/test.pdf",
        mime_type="application/pdf",
        file_hash_sha256="a" * 64,
        full_text=full_text,
    )
    session.add(org)
    session.add(user)
    session.add(contract)
    session.current_contract = contract
    return contract


# --------------------------------------------------------------------------
# Pure segmentation tests
# --------------------------------------------------------------------------


def _assert_spans_exact(text: str, candidates: list[ClauseCandidate]) -> None:
    """Every candidate's text must equal the exact source slice."""
    for c in candidates:
        assert text[c.span_start:c.span_end] == c.text, (
            f"span mismatch at ordinal: text={c.text!r} "
            f"vs slice={text[c.span_start:c.span_end]!r}"
        )
        assert c.span_start < c.span_end


def test_numbered_sections_split_into_stable_clauses() -> None:
    text = (
        "INTRODUCTION\n\n"
        "1. Purpose. The Parties wish to explore a business relationship.\n\n"
        "2. Term. This Agreement shall remain in effect for twenty-four months.\n\n"
        "3. Confidentiality. Each Party shall hold the other Party's "
        "Confidential Information in strict confidence.\n"
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    headings = [c.heading for c in candidates if c.heading]
    assert any("Purpose" in h for h in headings)
    assert any("Term" in h for h in headings)
    assert any("Confidentiality" in h for h in headings)


def test_section_keyword_headings_handled() -> None:
    text = (
        "Section 1. Definitions. As used herein, the following terms shall "
        "have the meanings set forth below.\n\n"
        "Section 2. Term. This Agreement remains in effect for one year.\n"
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    assert len(candidates) >= 2


def test_article_headings_handled() -> None:
    text = (
        "ARTICLE I. PURPOSE\n\n"
        "The parties wish to enter into this agreement.\n\n"
        "ARTICLE II. TERM\n\n"
        "The agreement shall continue for twenty-four (24) months.\n"
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    assert len(candidates) >= 2


def test_paragraph_fallback_when_no_markers() -> None:
    text = (
        "This is a contract. It has no headings or section markers.\n\n"
        "Each paragraph is conceptually a clause and the segmenter should "
        "treat it as such when no boundaries are detected.\n\n"
        "A third paragraph rounds out the document body for the test."
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    assert len(candidates) >= 1


def test_decimal_numbers_do_not_create_bogus_splits() -> None:
    text = (
        "1. Pricing. The fee is 1.5% of revenue, payable monthly. The "
        "interest rate is 2.0 per annum. Discount applies above 12.5 in "
        "qualifying volume.\n"
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    # The leading "1. Pricing." is the only section anchor; "1.5%" / "2.0"
    # / "12.5" inside the paragraph must NOT create new clauses.
    assert len(candidates) == 1


def test_money_amounts_do_not_create_bogus_splits() -> None:
    text = (
        "1. Payment. The total contract value is $1,000,000.00 paid in "
        "twelve installments of $83,333.33 each.\n"
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    assert len(candidates) == 1


def test_dates_inside_text_do_not_create_bogus_splits() -> None:
    text = (
        "1. Term. This Agreement is effective as of 2026-01-15 and "
        "continues through 2026-12-31, with renewals on 2027-01-01.\n"
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    assert len(candidates) == 1


def test_short_fragments_are_merged_into_neighbors() -> None:
    text = (
        "1. T.\n"  # tiny fragment
        "2. Confidentiality. Each party shall hold the other party's "
        "Confidential Information in strict confidence and use it only "
        "for the Purpose described in Section 1.\n"
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    # Tiny fragment merges into the next, leaving us with one clause that
    # spans both lines verbatim.
    assert len(candidates) == 1
    assert candidates[0].text == text


def test_trailing_short_fragment_is_dropped() -> None:
    text = (
        "1. Confidentiality. Each Party shall hold the other Party's "
        "Confidential Information in strict confidence and use it only "
        "for the Purpose.\n\n"
        "2. T.\n"
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    # The trailing "2. T." is too short to stand on its own and has nothing
    # to merge into, so it's dropped.
    assert all(len(c.text.strip()) >= MIN_CLAUSE_LEN_CHARS for c in candidates)


def test_classification_marks_known_types() -> None:
    text = (
        "1. Confidentiality. Each Party shall hold Confidential "
        "Information of the other Party in strict confidence and use "
        "it only for the Purpose.\n\n"
        "2. Governing Law. This Agreement is governed by the laws of "
        "the State of Delaware, without regard to conflict of laws "
        "principles.\n\n"
        "3. Termination. Either Party may terminate this Agreement on "
        "thirty (30) days' written notice.\n"
    )
    candidates = segment_text(text)
    type_map = {c.heading or c.text[:24]: c.clause_type for c in candidates}
    assert any(v == "confidentiality" for v in type_map.values())
    assert any(v == "governing_law" for v in type_map.values())
    assert any(v == "termination" for v in type_map.values())
    for c in candidates:
        if c.clause_type is not None:
            assert c.clause_type_source == "heuristic"
        # Every candidate here has both a numbered heading and a
        # keyword-matched clause_type: the strongest evidence tier.
        assert c.heading and c.clause_type
        assert c.confidence == _CONFIDENCE_HEADING_AND_TYPE


# --------------------------------------------------------------------------
# Confidence tiers
#
# Confidence is a deterministic function of the evidence a candidate
# actually has (heading detected via a structural boundary regex,
# clause_type classified via keyword match) - never a fabricated score.
# See `_confidence_for_match` in clause_segmentation.py.
# --------------------------------------------------------------------------


def test_confidence_heading_and_type_match_is_highest_tier() -> None:
    text = (
        "1. Confidentiality. Each Party shall hold Confidential "
        "Information of the other Party in strict confidence.\n"
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.heading is not None
    assert candidate.clause_type == "confidentiality"
    assert candidate.confidence == _CONFIDENCE_HEADING_AND_TYPE


def test_confidence_heading_only_no_type_match() -> None:
    # "Miscellaneous" is a real, recognized heading (title-case, ends in a
    # period) but doesn't match any clause_type keyword pattern, and
    # neither does the body.
    text = (
        "1. Miscellaneous. This clause contains general boilerplate "
        "language that does not reference any recognized clause topic.\n"
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.heading is not None
    assert candidate.clause_type is None
    assert candidate.confidence == _CONFIDENCE_HEADING_ONLY


def test_confidence_keyword_only_no_heading() -> None:
    # A single long, unheaded paragraph (not title-case, no line break, and
    # over the 200-char heading-candidate limit) that happens to contain a
    # recognized clause_type keyword ("indemnify") in its body.
    text = (
        "Each Party shall indemnify and hold harmless the other Party "
        "from and against any and all third-party claims, losses, "
        "damages, liabilities, and reasonable expenses arising out of "
        "or relating to any breach of this Agreement by the "
        "indemnifying Party or its personnel, agents, or subcontractors "
        "in the course of performing services under this Agreement."
    )
    assert len(text) > 200  # sanity: too long for the heading branch
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.heading is None
    assert candidate.clause_type == "indemnification"
    assert candidate.confidence == _CONFIDENCE_TYPE_ONLY


def test_empty_full_text_returns_no_candidates() -> None:
    assert segment_text("") == []


def test_whole_document_fallback_for_one_paragraph() -> None:
    text = "A single paragraph contract with no boundaries to detect."
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    assert len(candidates) == 1
    assert candidates[0].span_start == 0
    assert candidates[0].span_end == len(text)
    # No heading, no clause_type match: weakest evidence tier.
    assert candidates[0].confidence == _CONFIDENCE_NO_EVIDENCE


def test_pathological_input_falls_back_to_paragraphs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Synthesize a document that the numbered-section regex would split
    # into hundreds of tiny clauses; ensure we hit the cap and fall back.
    monkeypatch.setattr(clause_segmentation, "MAX_CLAUSES_HARD_CAP", 4)
    text = "\n\n".join(
        f"{i}. Clause {i}. This is the body of clause number {i}."
        for i in range(1, 12)
    )
    candidates = segment_text(text)
    _assert_spans_exact(text, candidates)
    assert len(candidates) <= MAX_CLAUSES_HARD_CAP


# --------------------------------------------------------------------------
# Span validation
# --------------------------------------------------------------------------


def test_validate_span_accepts_exact_match() -> None:
    text = "1. Hello world."
    cand = ClauseCandidate(
        text=text,
        span_start=0,
        span_end=len(text),
        heading=None,
        clause_type=None,
        clause_type_source=None,
        confidence=None,
    )
    assert _validate_span(text, cand) is True


def test_validate_span_rejects_mismatched_text() -> None:
    text = "1. Hello world."
    cand = ClauseCandidate(
        text="totally different",
        span_start=0,
        span_end=len(text),
        heading=None,
        clause_type=None,
        clause_type_source=None,
        confidence=None,
    )
    assert _validate_span(text, cand) is False


def test_validate_span_rejects_out_of_range_spans() -> None:
    text = "short"
    cand = ClauseCandidate(
        text="short",
        span_start=0,
        span_end=999,  # past the end
        heading=None,
        clause_type=None,
        clause_type_source=None,
        confidence=None,
    )
    assert _validate_span(text, cand) is False
    cand2 = ClauseCandidate(
        text="",
        span_start=3,
        span_end=2,  # end <= start
        heading=None,
        clause_type=None,
        clause_type_source=None,
        confidence=None,
    )
    assert _validate_span(text, cand2) is False


# --------------------------------------------------------------------------
# Persistence + idempotency tests
# --------------------------------------------------------------------------


async def test_segment_and_persist_clauses_persists_clauses(
    session: InMemorySession,
) -> None:
    text = (
        "1. Purpose. The Parties wish to enter into this Agreement.\n\n"
        "2. Confidentiality. Each Party shall hold the other Party's "
        "Confidential Information in strict confidence.\n\n"
        "3. Termination. Either Party may terminate on thirty days' notice.\n"
    )
    contract = _make_contract(session, text)

    rows = await segment_and_persist_clauses(session, contract)

    assert len(rows) >= 2
    for row in rows:
        assert row.organization_id == contract.organization_id
        assert row.contract_id == contract.id
        assert row.segmentation_method == SEGMENTATION_METHOD_HEURISTIC_V1
        assert row.model_name is None
        assert row.prompt_version is None
        # Span integrity invariant.
        assert text[row.span_start:row.span_end] == row.text
    # Ordinals are stable, monotonically increasing, and start at 0.
    assert [r.ordinal for r in rows] == list(range(len(rows)))


async def test_segment_and_persist_returns_existing_when_not_force(
    session: InMemorySession,
) -> None:
    contract = _make_contract(
        session,
        "1. Purpose. Do something.\n\n2. Term. One year.\n",
    )
    first = await segment_and_persist_clauses(session, contract)
    assert first  # sanity

    # Mutate the underlying full_text to prove force=False short-circuits.
    contract.full_text = "TOTALLY DIFFERENT TEXT"
    second = await segment_and_persist_clauses(session, contract)

    assert [c.id for c in second] == [c.id for c in first]
    # No new clauses persisted.
    assert len(session.clauses) == len(first)


async def test_segment_and_persist_force_replaces_clauses(
    session: InMemorySession,
) -> None:
    contract = _make_contract(
        session,
        "1. Purpose. Do something.\n\n2. Term. One year.\n",
    )
    first = await segment_and_persist_clauses(session, contract)
    assert first

    contract.full_text = (
        "1. Purpose. Updated.\n\n2. Confidentiality. Hold confidential.\n\n"
        "3. Termination. Either party may terminate.\n"
    )
    second = await segment_and_persist_clauses(session, contract, force=True)

    assert second
    # Old ids are gone.
    first_ids = {c.id for c in first}
    second_ids = {c.id for c in second}
    assert first_ids.isdisjoint(second_ids)
    # Persisted set matches the new clauses.
    persisted_ids = {c.id for c in session.clauses}
    assert persisted_ids == second_ids


async def test_segment_raises_when_full_text_is_none(
    session: InMemorySession,
) -> None:
    contract = _make_contract(session, None)
    with pytest.raises(ClauseSegmentationError):
        await segment_and_persist_clauses(session, contract)


async def test_invalid_candidates_are_dropped_not_persisted(
    session: InMemorySession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An ungrounded candidate (text != full_text[s:e]) MUST be dropped.

    This guards the load-bearing principle that persisted clauses are
    citation-grounded by construction.
    """
    contract = _make_contract(
        session,
        "1. Confidentiality. Each Party shall hold confidence.\n",
    )

    bogus = ClauseCandidate(
        text="paraphrased text that does not appear in source",
        span_start=0,
        span_end=10,  # slice would not equal text
        heading=None,
        clause_type=None,
        clause_type_source=None,
        confidence=None,
    )
    monkeypatch.setattr(
        clause_segmentation, "segment_text", lambda _: [bogus]
    )

    rows = await segment_and_persist_clauses(session, contract)

    assert rows == []
    assert session.clauses == []


async def test_org_scoping_uses_contract_organization(
    session: InMemorySession,
) -> None:
    contract = _make_contract(
        session,
        "1. Purpose. The Parties enter into this Agreement.\n\n"
        "2. Term. One year.\n",
    )
    rows = await segment_and_persist_clauses(session, contract)
    assert rows
    for row in rows:
        assert row.organization_id == contract.organization_id
