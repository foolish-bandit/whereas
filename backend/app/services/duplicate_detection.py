"""Warning-only duplicate-contract detection for uploads.

PR #66 deliberately moves duplicate handling from "hard 409 reject"
to "warn + let the user proceed". Returning a candidate set as a
response field gives the UI everything it needs to surface "this
might be a duplicate of <existing contract>" without taking the
decision out of the user's hands.

The reasoning behind the soft warning:
- Exact-hash collisions are common in CLM (counterparty re-sends the
  same DOCX, signed PDF gets uploaded alongside the unsigned draft,
  same template is used twice intentionally).
- The user may *want* a separate Contract row for a separate
  workflow even when the bytes match.
- Hard-blocking forced operators to find the existing contract id
  out-of-band, which broke flows that should "just work".

Soft warnings give us the visibility without the lockout. A future
PR can layer a merge / "link to existing" UX on top of the same
candidate list.

Threat model / privacy:
- Org-scoped: candidates are always restricted to the caller's
  ``organization_id``. Cross-org rows cannot leak.
- Never returns ``storage_key``, ``wrapped_dek``, encrypted bytes,
  or any presigned URL. Only the metadata the contract list
  surface already exposes (id / title / status / created_at) plus
  the deterministic ``reason`` / ``confidence`` strings.
- Never raises. The caller's upload flow must not depend on
  duplicate detection succeeding.
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Contract

log = logging.getLogger(__name__)

DEFAULT_LIMIT = 5
MAX_LIMIT = 20

DuplicateReason = Literal[
    "exact_file_hash",
    "similar_title",
    "similar_title_and_counterparty",
]
DuplicateConfidence = Literal["exact", "possible"]


@dataclass(frozen=True)
class DuplicateCandidate:
    """One row in the duplicate-warning list.

    ``contract_id``, ``title``, and ``created_at`` are the only
    identifier fields surfaced. ``reason`` + ``confidence`` are
    closed strings so the UI can render specific copy per code
    without freeform parsing.
    """

    contract_id: uuid.UUID
    title: str
    reason: DuplicateReason
    confidence: DuplicateConfidence
    created_at: datetime
    status: str


async def find_possible_duplicate_contracts(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
    file_hash_sha256: str | None,
    suggested_title: str | None = None,
    counterparty_name: str | None = None,
    filename: str | None = None,
    exclude_contract_id: uuid.UUID | None = None,
    limit: int = DEFAULT_LIMIT,
) -> list[DuplicateCandidate]:
    """Return up to ``limit`` warning-level duplicate candidates.

    Priority order:
      1. Exact file-hash match (``confidence='exact'``,
         ``reason='exact_file_hash'``).
      2. Same normalized title within the same org AND same
         counterparty hint (``reason='similar_title_and_counterparty'``).
      3. Same normalized title within the same org
         (``reason='similar_title'``).

    Each candidate appears at most once in the result. When the same
    contract matches multiple categories the strongest reason wins.

    Filename-based matching falls back to the cleaned filename stem
    as a title alias so a counterparty re-uploading the same file
    under a different ``title=`` query param still surfaces. Body-text
    fingerprinting / shingle hashing is intentionally out of scope —
    it's the next-step follow-up if the warning-only model isn't
    catching enough true positives.
    """
    bounded_limit = max(1, min(MAX_LIMIT, limit))

    found: dict[uuid.UUID, DuplicateCandidate] = {}

    if file_hash_sha256:
        try:
            await _add_exact_hash_candidates(
                session,
                found=found,
                organization_id=organization_id,
                file_hash_sha256=file_hash_sha256,
                exclude_contract_id=exclude_contract_id,
                limit=bounded_limit,
            )
        except Exception:
            log.exception(
                "exact-hash duplicate lookup failed; continuing",
                extra={"organization_id": str(organization_id)},
            )

    # Build a title-or-filename alias set so a fresh upload with no
    # explicit ``title=`` but a recognizable filename still hits
    # near-duplicates. We dedup the normalized aliases so we don't run
    # the same query twice with different inputs.
    title_aliases = _normalized_aliases(suggested_title, filename)
    if title_aliases and len(found) < bounded_limit:
        try:
            await _add_title_candidates(
                session,
                found=found,
                organization_id=organization_id,
                title_aliases=title_aliases,
                counterparty_name=counterparty_name,
                exclude_contract_id=exclude_contract_id,
                limit=bounded_limit,
            )
        except Exception:
            log.exception(
                "title-based duplicate lookup failed; continuing",
                extra={"organization_id": str(organization_id)},
            )

    # Strongest reason first, then most recent. Tie-break on id for
    # deterministic ordering in tests.
    return sorted(
        found.values(),
        key=lambda c: (_REASON_ORDER[c.reason], _datetime_desc_key(c.created_at), c.contract_id),
    )[:bounded_limit]


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


_REASON_ORDER: dict[DuplicateReason, int] = {
    "exact_file_hash": 0,
    "similar_title_and_counterparty": 1,
    "similar_title": 2,
}


def _datetime_desc_key(ts: datetime) -> float:
    """Sort key that ranks newer ``ts`` ahead of older.

    Using ``-ts.timestamp()`` is the simplest stable descending sort
    that composes with the other keys above without an extra reverse.
    """
    return -ts.timestamp()


async def _add_exact_hash_candidates(
    session: AsyncSession,
    *,
    found: dict[uuid.UUID, DuplicateCandidate],
    organization_id: uuid.UUID,
    file_hash_sha256: str,
    exclude_contract_id: uuid.UUID | None,
    limit: int,
) -> None:
    stmt = (
        select(Contract)
        .where(
            Contract.organization_id == organization_id,
            Contract.file_hash_sha256 == file_hash_sha256,
        )
        .order_by(Contract.created_at.desc(), Contract.id.desc())
        .limit(limit)
    )
    rows = (await session.execute(stmt)).scalars().all()
    for row in rows:
        if exclude_contract_id is not None and row.id == exclude_contract_id:
            continue
        found[row.id] = DuplicateCandidate(
            contract_id=row.id,
            title=row.title,
            reason="exact_file_hash",
            confidence="exact",
            created_at=row.created_at,
            status=row.status,
        )


async def _add_title_candidates(
    session: AsyncSession,
    *,
    found: dict[uuid.UUID, DuplicateCandidate],
    organization_id: uuid.UUID,
    title_aliases: list[str],
    counterparty_name: str | None,
    exclude_contract_id: uuid.UUID | None,
    limit: int,
) -> None:
    # We pull a small window of candidate rows by Postgres-side
    # ``lower(title) IN (...)`` so we don't need to load every contract
    # in the org. ``Contract.title`` is bounded String(500) and indexed
    # on the org column; this is a cheap lookup.
    from sqlalchemy import func

    lowered_aliases = list({alias.lower() for alias in title_aliases})
    stmt = (
        select(Contract)
        .where(
            Contract.organization_id == organization_id,
            func.lower(Contract.title).in_(lowered_aliases),
        )
        .order_by(Contract.created_at.desc(), Contract.id.desc())
        .limit(limit * 4)
    )
    rows = (await session.execute(stmt)).scalars().all()
    cp_norm = _normalize_counterparty(counterparty_name)
    for row in rows:
        if exclude_contract_id is not None and row.id == exclude_contract_id:
            continue
        if row.id in found:
            # Already classified — exact-hash always wins over title.
            continue
        reason: DuplicateReason = "similar_title"
        if cp_norm and cp_norm in _normalize_counterparty(row.title) :
            reason = "similar_title_and_counterparty"
        found[row.id] = DuplicateCandidate(
            contract_id=row.id,
            title=row.title,
            reason=reason,
            confidence="possible",
            created_at=row.created_at,
            status=row.status,
        )


_FILENAME_SEP_RE = re.compile(r"[_\-\.]+")
_WHITESPACE_RE = re.compile(r"\s+")


def _normalize_title_value(value: str) -> str:
    """Canonical form for title comparison: lower / no separators / no ext."""
    if not value:
        return ""
    # If it looks like a filename, drop the extension.
    if "." in value and " " not in value:
        value = value.rsplit(".", 1)[0]
    value = _FILENAME_SEP_RE.sub(" ", value)
    return _WHITESPACE_RE.sub(" ", value).strip().lower()


def _normalized_aliases(
    suggested_title: str | None, filename: str | None
) -> list[str]:
    aliases: list[str] = []
    for source in (suggested_title, filename):
        if not source:
            continue
        normalized = _normalize_title_value(source)
        if normalized and normalized not in aliases:
            aliases.append(normalized)
    return aliases


def _normalize_counterparty(value: str | None) -> str:
    if not value:
        return ""
    return _WHITESPACE_RE.sub(" ", value).strip().lower()
