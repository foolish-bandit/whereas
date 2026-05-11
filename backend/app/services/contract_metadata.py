"""Lightweight, deterministic metadata extraction for uploaded contracts.

PR #66 wires this into the Repository upload and request-conversion
upload paths so users see "this looks like an NDA with Acme effective
2026-05-01" the moment they hand Whereas a file. The intent is to
*suggest* — never to overwrite explicit user input — and to do it
without an LLM, without an external service, and without OCR/Docling.

Design notes:
- Pure functions. No DB access, no network, no LLM, no side effects.
- Conservative: empty result + warnings rather than confidently
  hallucinating a counterparty or contract type from noisy input.
- Caller decides what to persist vs. what to surface as a suggestion.
  We never write Contract rows from here.
- Filename normalization mirrors ``_derive_title`` semantics: strip
  extension, replace separators with spaces, collapse whitespace,
  Title Case.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import date

# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


# The set of contract types this extractor can confidently identify.
# Keep narrow and aligned with the UI's ``REQUEST_TYPE_OPTIONS`` /
# ``contract_type`` suggestions. ``other`` and ``unknown`` are
# deliberately omitted: when nothing matches we leave the field as
# ``None`` rather than asserting "Other".
KNOWN_CONTRACT_TYPES = (
    "NDA",
    "MSA",
    "SOW",
    "DPA",
    "Employment Agreement",
    "Lease",
    "Amendment",
    "Order Form",
)


@dataclass(frozen=True)
class ExtractedContractMetadata:
    """Result of a single best-effort metadata pass over an upload.

    Every field is optional; the empty result is the "we don't know
    enough to suggest anything" state. ``warnings`` is a non-secret
    diagnostic list that the response surface can show users
    ("filename had no obvious counterparty", etc.).
    """

    suggested_title: str | None = None
    likely_contract_type: str | None = None
    possible_counterparty_name: str | None = None
    effective_date: date | None = None
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def extract_basic_contract_metadata(
    *,
    filename: str | None,
    mime_type: str | None,
    markdown_text: str | None = None,
    plain_text: str | None = None,
) -> ExtractedContractMetadata:
    """Deterministic, best-effort metadata extraction from an upload.

    Order of input preference for text-based heuristics: ``markdown_text``
    (because the Markdown snapshot tends to be cleaner than the raw
    Docling output), then ``plain_text``. Either may be ``None``.

    Never raises — any unexpected input produces an empty result with
    a warning instead. The caller's upload flow must not depend on
    this succeeding.
    """
    warnings: list[str] = []

    safe_filename = (filename or "").strip()
    body_text = _pick_body_text(markdown_text, plain_text)

    suggested_title = _suggest_title(safe_filename, body_text)
    if not suggested_title and not body_text:
        warnings.append("no_filename_or_body_text")

    likely_contract_type = _detect_contract_type(safe_filename, body_text)
    if likely_contract_type is None:
        warnings.append("contract_type_unknown")

    counterparty = _detect_counterparty(safe_filename, body_text)
    if counterparty is None:
        warnings.append("counterparty_unknown")

    effective = _detect_effective_date(body_text)
    if effective is None:
        warnings.append("effective_date_unknown")

    # ``mime_type`` is accepted today for forward compatibility (e.g.
    # mime-specific extractors in a follow-up). Currently unused.
    _ = mime_type

    return ExtractedContractMetadata(
        suggested_title=suggested_title,
        likely_contract_type=likely_contract_type,
        possible_counterparty_name=counterparty,
        effective_date=effective,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _pick_body_text(
    markdown_text: str | None, plain_text: str | None
) -> str:
    """Pick the cleanest available text and trim to a working window.

    We only ever look at the first ~8000 chars — every heuristic here
    targets the head of a contract (title, parties block, effective
    date) so the rest of the document is noise for these purposes and
    eats memory in tight test loops.
    """
    candidate = markdown_text or plain_text or ""
    candidate = candidate.replace("\r\n", "\n").replace("\r", "\n")
    return candidate[:8000]


_WHITESPACE_RE = re.compile(r"\s+")
_SEPARATOR_RE = re.compile(r"[_\-\.]+")


def _filename_stem(filename: str) -> str:
    """Strip extension + separators and collapse whitespace."""
    if not filename:
        return ""
    stem = os.path.splitext(filename)[0]
    stem = _SEPARATOR_RE.sub(" ", stem)
    return _WHITESPACE_RE.sub(" ", stem).strip()


def _title_case(value: str) -> str:
    # We only Title-Case if the input looks all-lower or all-upper —
    # mixed-case inputs are likely already user-edited and we should
    # respect them.
    if not value:
        return value
    if value.isupper() or value.islower():
        return value.title()
    return value


def _suggest_title(filename: str, body_text: str) -> str | None:
    """Filename-based title cleanup with a Markdown H1 fallback.

    Filenames are usually closer to the document's working name than
    the body ("Mutual_NDA_Acme_2026.pdf" vs the formal body title
    "MUTUAL NON-DISCLOSURE AGREEMENT"). When the filename is empty
    we'll fall back to a leading ``# H1`` line from the body.
    """
    stem = _filename_stem(filename)
    if stem:
        return _title_case(stem)[:200]
    if not body_text:
        return None
    for line in body_text.splitlines():
        s = line.strip()
        if s.startswith("# "):
            return _title_case(s[2:].strip())[:200]
    return None


# Contract-type heuristics. Order matters: contracts that are
# *children of* another agreement (an Amendment on top of an MSA, an
# SOW pursuant to an MSA) come first so the more specific type wins
# when the body mentions both. Order is also used as tie-breaker on
# filename matches.
_CONTRACT_TYPE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "Amendment",
        re.compile(r"\b(amendment(?:\s+no\.?\s*\d+)?|addendum)\b", re.I),
    ),
    ("SOW", re.compile(r"\b(SOW|statement\s+of\s+work)\b", re.I)),
    ("NDA", re.compile(r"\b(NDA|non[\s\-]?disclosure(?:\s+agreement)?)\b", re.I)),
    (
        "DPA",
        re.compile(r"\b(DPA|data\s+processing\s+agreement)\b", re.I),
    ),
    (
        "MSA",
        re.compile(r"\b(MSA|master\s+services?(?:\s+agreement)?)\b", re.I),
    ),
    (
        "Employment Agreement",
        re.compile(r"\bemployment(?:\s+agreement|\s+contract)\b", re.I),
    ),
    ("Lease", re.compile(r"\b(lease(?:\s+agreement)?)\b", re.I)),
    (
        "Order Form",
        re.compile(r"\b(order\s+form)\b", re.I),
    ),
)


def _detect_contract_type(filename: str, body_text: str) -> str | None:
    # Use the normalized filename stem (separators → spaces) so ``\b``
    # word-boundary matches work the same on "NDA_Acme.pdf" as
    # "NDA Acme.pdf". The raw filename leaves ``_`` adjacent to the
    # acronym, which is a word character, so the boundary never fires.
    stem = _filename_stem(filename)
    haystack = f"{stem}\n{body_text}"
    for label, pattern in _CONTRACT_TYPE_PATTERNS:
        if pattern.search(haystack):
            return label
    return None


# Counterparty heuristics — deliberately conservative.
#
# We only suggest a counterparty when one of two patterns matches:
#   1. The body has an obvious "between X and Y" line and one of the
#      sides isn't a generic legal placeholder (we just take the first
#      non-empty side); OR
#   2. The filename carries a recognizable agreement marker followed
#      by a non-generic party token, like "NDA - Acme.pdf".
#
# Anything else returns None plus a ``counterparty_unknown`` warning.
# Hallucinating a counterparty on weak input is worse than admitting
# we don't know — users will (rightly) stop trusting the suggestion.
# Note: ``[A-Z]`` is intentional and NOT wrapped in ``re.IGNORECASE``.
# A counterparty in a real "between X and Y" line starts with a capital
# proper-noun letter; "between the parties and us" is the failure
# mode we're trying to suppress. Allowing lowercase starts on the
# party tokens would re-introduce it.
_BETWEEN_PATTERN = re.compile(
    r"\bbetween\s+(?P<a>[A-Z][A-Za-z0-9&'\- ]{0,80})\s+and\s+"
    r"(?P<b>[A-Z][A-Za-z0-9&'\- ]{0,80})"
)
_GENERIC_PARTY_TOKENS = frozenset(
    {
        "the parties",
        "the party",
        "the company",
        "the customer",
        "the supplier",
        "company",
        "customer",
        "supplier",
        "vendor",
        "client",
        "contractor",
        "us",
        "we",
    }
)
_FILENAME_AGREEMENT_TOKENS = (
    "NDA",
    "MSA",
    "SOW",
    "DPA",
    "MNDA",
    "agreement",
    "contract",
)


def _detect_counterparty(filename: str, body_text: str) -> str | None:
    # 1) body-text "between X and Y"
    if body_text:
        m = _BETWEEN_PATTERN.search(body_text)
        if m:
            a, b = m.group("a").strip(), m.group("b").strip()
            for candidate in (a, b):
                cand = re.sub(r"\s+", " ", candidate).strip(" ,.;:")
                cand_l = cand.lower()
                if (
                    cand
                    and cand_l not in _GENERIC_PARTY_TOKENS
                    and not cand_l.startswith("the ")
                ):
                    return cand[:200]

    # 2) filename pattern: "<type> - <name>" or "<type>_<name>"
    stem = _filename_stem(filename)
    if not stem:
        return None
    tokens = stem.split()
    if len(tokens) < 2:
        return None
    lowered = [t.lower() for t in tokens]
    for marker in _FILENAME_AGREEMENT_TOKENS:
        for i, tok in enumerate(lowered):
            if tok == marker.lower():
                remaining = [
                    t
                    for t in tokens[i + 1 :]
                    if t.lower() not in _GENERIC_PARTY_TOKENS
                    and not t.isdigit()
                    and not _looks_like_date_token(t)
                ]
                if remaining:
                    candidate = _title_case(" ".join(remaining[:4])).strip()
                    if candidate:
                        return candidate[:200]
    return None


_DATE_TOKEN_RE = re.compile(r"^\d{2,4}[-/]\d{1,2}([-/]\d{1,4})?$")


def _looks_like_date_token(token: str) -> bool:
    return bool(_DATE_TOKEN_RE.match(token))


# Effective-date heuristic. We *only* trust dates that appear in close
# proximity to the literal phrase "effective date" / "effective as of"
# / "dated this". Plain "January 1, 2026" anywhere in a contract body
# is too ambiguous (signature dates, recitals, etc.) for the
# "conservative, deterministic" bar this PR sets.
_EFFECTIVE_TRIGGER = re.compile(
    r"(?P<lead>effective\s+(?:date|as\s+of)|dated\s+(?:this\s+)?(?:as\s+of\s+)?)",
    re.I,
)
_ISO_DATE_RE = re.compile(r"\b(?P<y>\d{4})[-/](?P<m>\d{1,2})[-/](?P<d>\d{1,2})\b")
_US_DATE_RE = re.compile(
    r"\b(?P<m>\d{1,2})[/](?P<d>\d{1,2})[/](?P<y>\d{2,4})\b"
)
_MONTH_NAMES = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "sept": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}
_WORD_DATE_RE = re.compile(
    r"\b(?P<m>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|"
    r"jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|"
    r"nov(?:ember)?|dec(?:ember)?)\s+"
    r"(?P<d>\d{1,2})(?:st|nd|rd|th)?,?\s+(?P<y>\d{4})\b",
    re.I,
)


def _detect_effective_date(body_text: str) -> date | None:
    if not body_text:
        return None
    trigger = _EFFECTIVE_TRIGGER.search(body_text)
    if trigger is None:
        return None
    # Look in the 120-char window right after the trigger phrase. Most
    # "effective date: 2026-05-01" / "dated as of January 1, 2026"
    # patterns are within ~30 chars; 120 gives slack for parentheticals.
    window_start = trigger.end()
    window = body_text[window_start : window_start + 120]
    return _first_date_in(window)


def _first_date_in(text: str) -> date | None:
    iso = _ISO_DATE_RE.search(text)
    if iso is not None:
        d = _safe_date(int(iso["y"]), int(iso["m"]), int(iso["d"]))
        if d is not None:
            return d
    word = _WORD_DATE_RE.search(text)
    if word is not None:
        month = _MONTH_NAMES.get(word["m"].lower())
        if month is not None:
            d = _safe_date(int(word["y"]), month, int(word["d"]))
            if d is not None:
                return d
    us = _US_DATE_RE.search(text)
    if us is not None:
        year = int(us["y"])
        if year < 100:
            year += 2000
        d = _safe_date(year, int(us["m"]), int(us["d"]))
        if d is not None:
            return d
    return None


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year=year, month=month, day=day)
    except ValueError:
        return None
