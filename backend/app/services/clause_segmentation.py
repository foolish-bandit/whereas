"""Heuristic clause segmentation for contract text.

Pipeline (v1, deterministic, no LLM):
  1. Find boundary anchors in `Contract.full_text` — numbered sections
     (1., 1.1, 2.03), `Section N`, `ARTICLE V`, ALL-CAPS headings,
     short title-case headings.
  2. Slice `full_text` along those anchors, preserving exact characters
     — every clause's `text` is `full_text[span_start:span_end]`
     verbatim, no whitespace normalization.
  3. Merge fragments shorter than `MIN_CLAUSE_LEN_CHARS` into the next
     clause (or drop a trailing scrap) so we don't produce dozens of
     tiny clauses on poorly-formatted documents.
  4. Cap at `MAX_CLAUSES_HARD_CAP`. If we'd exceed that, fall back to
     paragraph-only segmentation; if even that explodes, truncate.
  5. Optionally tag each clause with a CUAD-inspired `clause_type` via
     conservative keyword rules. No match → null. v1 never invents a
     type it isn't sure about.
  6. Persist with stable ordinals scoped to the contract's organization.

Span integrity is the load-bearing invariant. We only persist a clause
if `Contract.full_text[span_start:span_end] == clause.text` exactly. If
that fails we drop the candidate rather than write ungrounded data.
"""
from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Clause, Contract

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# Public constants
# --------------------------------------------------------------------------


SEGMENTATION_METHOD_HEURISTIC_V1 = "heuristic_v1"
CLAUSE_TYPE_SOURCE_HEURISTIC = "heuristic"

# A clause shorter than this is merged into the next one unless it
# carries a heading we recognize. Tunable; chosen to keep one-line
# section pointers ("Section 4.") from becoming standalone clauses.
MIN_CLAUSE_LEN_CHARS = 30

# Hard ceiling on how many clauses we will ever emit for one contract.
# Heuristics on a pathological document can otherwise produce hundreds
# of tiny fragments.
MAX_CLAUSES_HARD_CAP = 500

# Documents larger than this skip heuristic segmentation entirely and
# fall back to a single-clause paragraph view, so a multi-megabyte text
# blob can't pin a worker.
MAX_DOC_BYTES_FOR_HEURISTIC = 2_000_000


class ClauseSegmentationError(Exception):
    """Raised when segmentation cannot proceed (e.g. missing full_text)."""


# --------------------------------------------------------------------------
# Candidate dataclass
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class ClauseCandidate:
    """One pre-validation candidate.

    `text` is always a verbatim slice of the source document; the
    persistence layer re-checks this before writing.
    """

    text: str
    span_start: int
    span_end: int
    heading: str | None
    clause_type: str | None
    clause_type_source: str | None
    confidence: float | None


# --------------------------------------------------------------------------
# Boundary detection
# --------------------------------------------------------------------------


# Numbered section markers at line start. Requires a capital letter to
# follow so decimals embedded in sentences ("1.5%", "Version 2.0 of") do
# not trip the boundary detector. Numeric depth capped at 4 dots so a
# version string like 1.2.3.4.5 still doesn't run away.
_NUMBERED_SECTION = re.compile(
    r"(?m)^[ \t]*(?:\d{1,3}(?:\.\d{1,3}){0,3})\.\s+(?=[A-Z\"“])"
)

# Explicit "Section N" / "Section N.M" pointers.
_SECTION_KEYWORD = re.compile(
    r"(?m)^[ \t]*Section\s+\d+(?:\.\d+){0,3}\.?\s+(?=\S)",
    re.IGNORECASE,
)

# Articles in Roman or Arabic numerals (ARTICLE V, Article 3).
_ARTICLE_KEYWORD = re.compile(
    r"(?m)^[ \t]*ARTICLE\s+(?:[IVXLCDM]+|\d+)\.?\s*(?=\S)",
    re.IGNORECASE,
)

# All-caps line that looks like a section title. Tightened to require
# at least 3 letters and to stop before reaching too-long lines (a long
# all-caps run is more likely shouting in a body paragraph).
_ALL_CAPS_HEADING = re.compile(
    r"(?m)^[ \t]*([A-Z][A-Z0-9 \-&/.,'\"’\(\)]{2,79})\s*$"
)

# Title-case heading (e.g. "Confidentiality.") on its own line. Allows
# multiple capitalized words with optional connectors. Trailing period
# or colon required so we don't capture body lines.
_TITLE_CASE_HEADING = re.compile(
    r"(?m)^[ \t]*("
    r"(?:[A-Z][A-Za-z]+)"
    r"(?:[ \-]+(?:[A-Z][A-Za-z]+|of|and|to|the|or|for|in|on))*"
    r"[.:])\s*$"
)


def _boundary_offsets(full_text: str) -> list[int]:
    """Return sorted unique character offsets where a clause starts.

    Always includes 0 so the very first slice begins at the document
    start. De-duplicates near-collisions (multiple regexes matching the
    same line) by collapsing equal offsets.
    """
    offsets: set[int] = {0}
    for pattern in (
        _NUMBERED_SECTION,
        _SECTION_KEYWORD,
        _ARTICLE_KEYWORD,
        _ALL_CAPS_HEADING,
        _TITLE_CASE_HEADING,
    ):
        for match in pattern.finditer(full_text):
            offsets.add(match.start())
    return sorted(offsets)


# --------------------------------------------------------------------------
# Heading extraction and clause type taxonomy
# --------------------------------------------------------------------------


# Pattern for the "first line" of a clause — used to lift a heading
# out of the slice when the slice starts with a recognizable header.
_LEADING_HEADING_LINE = re.compile(r"^[ \t]*([^\n]{1,200})\n")


def _maybe_heading(slice_text: str) -> str | None:
    """Return a clean heading string if the slice opens with one."""
    match = _LEADING_HEADING_LINE.match(slice_text)
    if not match:
        # The slice is a single line; treat it as a heading if it's
        # short and looks like a heading.
        candidate = slice_text.strip()
        if (
            0 < len(candidate) <= 200
            and "\n" not in candidate
            and _looks_like_heading(candidate)
        ):
            return candidate
        return None
    candidate = match.group(1).strip()
    if _looks_like_heading(candidate):
        return candidate
    return None


def _looks_like_heading(line: str) -> bool:
    """Heuristic: does this line look like a section heading?"""
    if not line:
        return False
    if len(line) > 200:
        return False
    probe = line + "\n"
    if _NUMBERED_SECTION.match(probe):
        return True
    if _SECTION_KEYWORD.match(probe):
        return True
    if _ARTICLE_KEYWORD.match(probe):
        return True
    if _ALL_CAPS_HEADING.match(probe):
        return True
    return bool(_TITLE_CASE_HEADING.match(probe))


# CUAD-inspired taxonomy. Order matters: first match wins, so the
# more-specific labels precede the more-general ones.
_TYPE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("recitals", re.compile(r"\b(recitals?|whereas|witnesseth)\b", re.IGNORECASE)),
    ("definitions", re.compile(r"\bdefinitions?\b", re.IGNORECASE)),
    (
        "non_disclosure",
        re.compile(r"\b(non[\- ]?disclosure|nda)\b", re.IGNORECASE),
    ),
    (
        "confidentiality",
        re.compile(r"\bconfidential(ity)?\b", re.IGNORECASE),
    ),
    (
        "non_compete",
        re.compile(r"\bnon[\- ]?compet(e|ition)\b", re.IGNORECASE),
    ),
    (
        "non_solicit",
        re.compile(r"\bnon[\- ]?solicit(ation)?\b", re.IGNORECASE),
    ),
    (
        "limitation_of_liability",
        re.compile(r"\b(limit(ation)? of liability|liability cap)\b", re.IGNORECASE),
    ),
    (
        "indemnification",
        re.compile(r"\bindemnif(y|ication|ies)\b", re.IGNORECASE),
    ),
    (
        "intellectual_property",
        re.compile(
            r"\b(intellectual property|ip rights|copyrights?|trademarks?|patents?)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "data_protection",
        re.compile(
            r"\b(data protection|privacy|personal data|gdpr|hipaa)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "dispute_resolution",
        re.compile(
            r"\b(dispute resolution|arbitration|mediation|jury trial)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "governing_law",
        re.compile(r"\bgoverning law\b", re.IGNORECASE),
    ),
    (
        "force_majeure",
        re.compile(r"\bforce majeure\b", re.IGNORECASE),
    ),
    (
        "warranties",
        re.compile(r"\bwarrant(y|ies)\b", re.IGNORECASE),
    ),
    (
        "representations",
        re.compile(r"\brepresentations?\b", re.IGNORECASE),
    ),
    (
        "insurance",
        re.compile(r"\binsurance\b", re.IGNORECASE),
    ),
    (
        "audit_rights",
        re.compile(r"\baudit\b", re.IGNORECASE),
    ),
    (
        "amendment",
        re.compile(r"\bamendment\b", re.IGNORECASE),
    ),
    (
        "entire_agreement",
        re.compile(r"\bentire agreement\b", re.IGNORECASE),
    ),
    (
        "severability",
        re.compile(r"\bseverability\b", re.IGNORECASE),
    ),
    (
        "waiver",
        re.compile(r"\bwaiver\b", re.IGNORECASE),
    ),
    (
        "notices",
        re.compile(r"\bnotices?\b", re.IGNORECASE),
    ),
    (
        "assignment",
        re.compile(r"\bassign(ment|ability)?\b", re.IGNORECASE),
    ),
    (
        "termination",
        re.compile(r"\btermin(ation|ate)\b", re.IGNORECASE),
    ),
    (
        "term",
        re.compile(r"^\s*term\b", re.IGNORECASE),
    ),
    (
        "payment",
        re.compile(r"\b(payment|fees|compensation|invoic)\b", re.IGNORECASE),
    ),
    (
        "signature",
        re.compile(r"\b(in witness whereof|signature block|signed by)\b", re.IGNORECASE),
    ),
)


# Strip leading section markers ("1.", "1.2.3.", "Section 4.", "ARTICLE V.")
# from a heading so classification matches against the substantive label
# rather than the structural prefix.
_HEADING_PREFIX_RE = re.compile(
    r"^[ \t]*("
    r"\d{1,3}(?:\.\d{1,3}){0,3}\.?"
    r"|Section\s+\d+(?:\.\d+){0,3}\.?"
    r"|ARTICLE\s+(?:[IVXLCDM]+|\d+)\.?"
    r")\s*",
    re.IGNORECASE,
)


def _heading_label(heading: str) -> str:
    """Extract the substantive label phrase from a heading.

    "3. Termination. Either Party may terminate..." → "Termination"
    "ARTICLE I. PURPOSE" → "PURPOSE"
    "Confidentiality." → "Confidentiality"
    """
    cleaned = _HEADING_PREFIX_RE.sub("", heading, count=1)
    first_phrase = re.split(r"[.\n:]", cleaned, maxsplit=1)[0]
    return first_phrase.strip()


def _classify(heading: str | None, body: str) -> str | None:
    """Return a clause_type or None.

    Tries to match the substantive label of the heading first (so
    "3. Termination. Each party gives notice." classifies as
    "termination" rather than "notices"). Falls back to the full
    heading, then to a body snippet for unlabeled paragraphs.
    """
    if heading:
        label = _heading_label(heading)
        if label:
            for type_label, pattern in _TYPE_PATTERNS:
                if pattern.search(label):
                    return type_label
        for type_label, pattern in _TYPE_PATTERNS:
            if pattern.search(heading):
                return type_label
    snippet = body[:600]
    for type_label, pattern in _TYPE_PATTERNS:
        if pattern.search(snippet):
            return type_label
    return None


# Deterministic confidence tiers, keyed on which evidence a candidate
# actually has. Never fabricated: this is not a model score, it's an
# honest reflection of how much structural/keyword evidence backs the
# candidate's boundary and (if any) its clause_type classification.
#   - heading + a matched clause_type: the strongest signal - a
#     recognized section boundary (numbered/"Section N"/ARTICLE/
#     all-caps/title-case heading) whose text also named a known
#     clause type.
#   - heading only: a real section boundary, but its label didn't match
#     any known clause type.
#   - clause_type only, no heading: a keyword hit inside body text with
#     no structural boundary behind it - weaker than either heading case.
#   - neither: an anonymous slice or paragraph (e.g. the whole-document
#     or paragraph-fallback path) with no heading and no keyword match.
_CONFIDENCE_HEADING_AND_TYPE = 0.9
_CONFIDENCE_HEADING_ONLY = 0.75
_CONFIDENCE_TYPE_ONLY = 0.6
_CONFIDENCE_NO_EVIDENCE = 0.5


def _confidence_for_match(heading: str | None, clause_type: str | None) -> float:
    """Deterministic confidence tier for a clause candidate's evidence."""
    if heading and clause_type:
        return _CONFIDENCE_HEADING_AND_TYPE
    if heading:
        return _CONFIDENCE_HEADING_ONLY
    if clause_type:
        return _CONFIDENCE_TYPE_ONLY
    return _CONFIDENCE_NO_EVIDENCE


# --------------------------------------------------------------------------
# Pure segmentation
# --------------------------------------------------------------------------


def segment_text(full_text: str) -> list[ClauseCandidate]:
    """Split `full_text` into clause candidates with exact spans.

    Pure, deterministic, side-effect-free. Always returns at least one
    candidate when `full_text` is non-empty (the single-clause fallback
    catches whole-document-as-one-paragraph inputs).
    """
    if not isinstance(full_text, str) or not full_text:
        return []

    # Defensive size guard: the regex sweep is O(n) but we don't want
    # to be the bottleneck on a pasted-in book.
    if len(full_text.encode("utf-8")) > MAX_DOC_BYTES_FOR_HEURISTIC:
        log.info(
            "clause segmentation: document over byte budget, using paragraph fallback"
        )
        return list(_paragraph_candidates(full_text))

    boundaries = _boundary_offsets(full_text)
    raw = list(_slice_to_candidates(full_text, boundaries))
    merged = list(_merge_short_fragments(full_text, raw))

    if len(merged) > MAX_CLAUSES_HARD_CAP:
        log.info(
            "clause segmentation: heuristic produced %d candidates, "
            "falling back to paragraphs",
            len(merged),
        )
        merged = list(_paragraph_candidates(full_text))

    if len(merged) > MAX_CLAUSES_HARD_CAP:
        # Even paragraph fallback overflowed. Truncate explicitly so
        # the caller sees a bounded result rather than silent loss.
        log.warning(
            "clause segmentation: paragraph fallback over cap, truncating to %d",
            MAX_CLAUSES_HARD_CAP,
        )
        merged = merged[:MAX_CLAUSES_HARD_CAP]

    if not merged:
        # Whole-document-as-one-clause: keep span integrity by handing
        # back the verbatim text with offsets covering the document.
        merged = [_whole_document_candidate(full_text)]

    return merged


def _slice_to_candidates(
    full_text: str, boundaries: list[int]
) -> Iterable[ClauseCandidate]:
    """Cut `full_text` at boundary offsets and emit candidates."""
    n = len(full_text)
    if not boundaries:
        return
    bounds = [b for b in boundaries if 0 <= b < n]
    if not bounds or bounds[0] != 0:
        bounds = [0, *bounds]
    bounds.append(n)
    for start, end in zip(bounds, bounds[1:], strict=False):
        if end <= start:
            continue
        slice_text = full_text[start:end]
        # Skip pure-whitespace slices entirely; they are not clauses.
        if not slice_text.strip():
            continue
        heading = _maybe_heading(slice_text)
        clause_type = _classify(heading, slice_text)
        yield ClauseCandidate(
            text=slice_text,
            span_start=start,
            span_end=end,
            heading=heading,
            clause_type=clause_type,
            clause_type_source=(
                CLAUSE_TYPE_SOURCE_HEURISTIC if clause_type else None
            ),
            confidence=_confidence_for_match(heading, clause_type),
        )


def _merge_short_fragments(
    full_text: str,
    candidates: list[ClauseCandidate],
) -> Iterable[ClauseCandidate]:
    """Roll fragments below the minimum length into the next clause.

    Any short fragment merges forward, taking its heading along: the
    next clause inherits the merger's heading and (best-effort)
    clause type so a bare "ARTICLE I" preamble doesn't get lost as
    metadata. Trailing scraps with nothing to merge into are dropped;
    they're almost always orphaned whitespace or page artifacts. The
    merged candidate's `text` is recomputed as the verbatim slice
    `full_text[start:end]` so span integrity survives the merge.
    """
    pending: ClauseCandidate | None = None
    for current in candidates:
        if pending is None:
            pending = current
            continue
        if len(pending.text.strip()) < MIN_CLAUSE_LEN_CHARS:
            merged_start = pending.span_start
            merged_end = current.span_end
            merged_text = full_text[merged_start:merged_end]
            # When a short pending merges forward, the *current* clause is
            # the substantive one — its heading and type take precedence.
            # The pending fragment's metadata is the fallback.
            heading = current.heading or pending.heading
            clause_type = current.clause_type or pending.clause_type
            clause_type_source = (
                current.clause_type_source or pending.clause_type_source
            )
            pending = ClauseCandidate(
                text=merged_text,
                span_start=merged_start,
                span_end=merged_end,
                heading=heading,
                clause_type=clause_type,
                clause_type_source=clause_type_source,
                confidence=_confidence_for_match(heading, clause_type),
            )
            continue
        yield pending
        pending = current
    if pending is not None:
        if len(pending.text.strip()) < MIN_CLAUSE_LEN_CHARS:
            return
        yield pending


def _whole_document_candidate(full_text: str) -> ClauseCandidate:
    """Single-clause fallback covering the entire document verbatim."""
    return ClauseCandidate(
        text=full_text,
        span_start=0,
        span_end=len(full_text),
        heading=None,
        clause_type=None,
        clause_type_source=None,
        confidence=_CONFIDENCE_NO_EVIDENCE,
    )


# --------------------------------------------------------------------------
# Paragraph fallback
# --------------------------------------------------------------------------


_PARAGRAPH_SPLIT = re.compile(r"\n[ \t]*\n+")


def _paragraph_candidates(full_text: str) -> Iterable[ClauseCandidate]:
    """Split on blank-line paragraph boundaries, preserving spans."""
    cursor = 0
    n = len(full_text)
    if not full_text.strip():
        return
    matches = list(_PARAGRAPH_SPLIT.finditer(full_text))
    if not matches:
        # One paragraph: hand back the whole document.
        yield _whole_document_candidate(full_text)
        return
    for match in matches:
        end = match.start()
        if end > cursor:
            slice_text = full_text[cursor:end]
            if slice_text.strip():
                heading = _maybe_heading(slice_text)
                clause_type = _classify(heading, slice_text)
                yield ClauseCandidate(
                    text=slice_text,
                    span_start=cursor,
                    span_end=end,
                    heading=heading,
                    clause_type=clause_type,
                    clause_type_source=(
                        CLAUSE_TYPE_SOURCE_HEURISTIC if clause_type else None
                    ),
                    confidence=_confidence_for_match(heading, clause_type),
                )
        cursor = match.end()
    if cursor < n:
        slice_text = full_text[cursor:n]
        if slice_text.strip():
            heading = _maybe_heading(slice_text)
            clause_type = _classify(heading, slice_text)
            yield ClauseCandidate(
                text=slice_text,
                span_start=cursor,
                span_end=n,
                heading=heading,
                clause_type=clause_type,
                clause_type_source=(
                    CLAUSE_TYPE_SOURCE_HEURISTIC if clause_type else None
                ),
                confidence=_confidence_for_match(heading, clause_type),
            )


# --------------------------------------------------------------------------
# Span validation
# --------------------------------------------------------------------------


def _validate_span(full_text: str, candidate: ClauseCandidate) -> bool:
    """Return True iff the candidate's text matches the source slice exactly.

    No whitespace normalization, no fuzzy match. If this fails the
    candidate is dropped — the design principle is "if you can't cite
    it, don't surface it."
    """
    if candidate.span_start < 0:
        return False
    if candidate.span_end <= candidate.span_start:
        return False
    if candidate.span_end > len(full_text):
        return False
    return full_text[candidate.span_start:candidate.span_end] == candidate.text


# --------------------------------------------------------------------------
# Persistence
# --------------------------------------------------------------------------


async def segment_and_persist_clauses(
    session: AsyncSession,
    contract: Contract,
    *,
    force: bool = False,
) -> list[Clause]:
    """Segment `contract.full_text` and persist the resulting clauses.

    `force=False` (default) returns existing clauses untouched if the
    contract already has any. `force=True` deletes the existing clauses
    and re-runs segmentation. The caller owns the transaction; we
    flush so returned ORM rows carry their assigned ids, but never
    commit.
    """
    if contract.full_text is None:
        raise ClauseSegmentationError("Contract has no full_text to segment")

    existing = await _existing_clauses(session, contract.id)
    if existing and not force:
        return existing
    if existing:
        await session.execute(
            delete(Clause).where(Clause.contract_id == contract.id)
        )

    candidates = segment_text(contract.full_text)

    persisted: list[Clause] = []
    ordinal = 0
    for candidate in candidates:
        if not _validate_span(contract.full_text, candidate):
            log.warning(
                "Dropping clause candidate with invalid span",
                extra={
                    "contract_id": str(contract.id),
                    "span_start": candidate.span_start,
                    "span_end": candidate.span_end,
                    "text_preview": candidate.text[:80],
                },
            )
            continue
        clause = Clause(
            id=uuid.uuid4(),
            organization_id=contract.organization_id,
            contract_id=contract.id,
            ordinal=ordinal,
            heading=candidate.heading,
            clause_type=candidate.clause_type,
            clause_type_source=candidate.clause_type_source,
            text=candidate.text,
            span_start=candidate.span_start,
            span_end=candidate.span_end,
            confidence=candidate.confidence,
            segmentation_method=SEGMENTATION_METHOD_HEURISTIC_V1,
            model_name=None,
            prompt_version=None,
        )
        persisted.append(clause)
        ordinal += 1

    session.add_all(persisted)
    await session.flush()
    return persisted


async def _existing_clauses(
    session: AsyncSession, contract_id: uuid.UUID
) -> list[Clause]:
    """Return clauses already persisted for the contract, ordered by ordinal."""
    stmt = (
        select(Clause)
        .where(Clause.contract_id == contract_id)
        .order_by(Clause.ordinal.asc())
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())
