"""Persist deterministic playbook review findings.

Builds on the pure-function matcher in
``app.services.playbook_matcher`` and writes the failed rule outcomes
to the database, alongside a parent ``PlaybookReviewRun`` row that
captures the aggregate counts.

Design choices
--------------

**Failed-only persistence.** ``RuleMatchResult.status == "fail"`` rows
become ``DeviationFinding`` rows; passes are not stored. The
``PlaybookReviewRun`` row holds ``passed_count`` and ``rules_checked``
so the audit signal is preserved without the per-rule pass noise. A
caller that needs the full per-rule list for a historical run can
re-run the matcher (the matcher is deterministic and cheap).

**Supersede-on-rerun.** When a new run is created for the same
``(contract, playbook)`` pair, any prior findings on that pair whose
``finding_status`` is still ``OPEN`` are flipped to ``SUPERSEDED`` in
the same transaction. ``REVIEWED`` and ``IGNORED`` findings are left
alone — those are deliberate human decisions and rerunning the same
playbook should not silently reset them.

**Exact-span integrity.** Span fields (``span_start``, ``span_end``,
``evidence_text``, ``clause_id``) are copied verbatim off the matcher
result, which itself mirrors the source ``Clause`` row. This module
never paraphrases, recomputes, or re-derives spans; a regression that
broke span fidelity has to fail the unit tests here.

**No mutation of upstream rows.** The service writes only to
``playbook_review_runs`` and ``deviation_findings`` (plus the
``finding_status`` of pre-existing findings during the supersede
sweep). It never touches ``Contract``, ``Clause``, or ``Playbook``
rows, and it never calls an LLM.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Contract,
    DeviationFinding,
    FindingStatus,
    Playbook,
    PlaybookReviewRun,
)
from app.services.playbook_matcher import (
    PlaybookReview,
    RuleMatchResult,
    match_playbook,
)

log = logging.getLogger(__name__)


# Reviewer-settable values for `finding_status`. `superseded` is
# deliberately excluded — only the rerun path may set it.
_REVIEWER_STATUSES: frozenset[str] = frozenset(
    {FindingStatus.OPEN.value, FindingStatus.REVIEWED.value, FindingStatus.IGNORED.value}
)


class InvalidFindingStatusError(ValueError):
    """Raised when a caller asks to set an unsupported finding_status."""


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------


async def run_and_persist_review(
    session: AsyncSession,
    *,
    contract: Contract,
    playbook: Playbook,
    parsed_playbook,
    clauses: Sequence | None = None,
    review: PlaybookReview | None = None,
) -> tuple[PlaybookReviewRun, list[DeviationFinding], PlaybookReview]:
    """Compute a deterministic review and persist its results.

    The caller is expected to have already resolved org scoping for
    both ``contract`` and ``playbook``. This function does not
    validate cross-org access; that's the API layer's job, mirroring
    how the upload pipeline keeps services purely about persistence.

    ``clauses`` may be passed explicitly when the caller already has
    them in hand (e.g. the API layer ordered them for the response).
    If omitted, ``contract.clauses`` is used — which in async usage
    requires the caller to have eager-loaded the relationship.

    If ``review`` is supplied, it is used as-is — useful for tests and
    for callers that have already run the matcher. Otherwise the
    matcher is invoked here.

    Returns ``(review_run, persisted_findings, review)``. The
    ``review`` object is the full matcher result (including the
    transient pass rows the API layer might want to surface).
    """
    if review is None:
        clause_rows = clauses if clauses is not None else contract.clauses
        review = match_playbook(parsed_playbook, clause_rows)

    # Mark prior open findings on this (contract, playbook) as superseded
    # *before* inserting the new run so we don't accidentally supersede
    # findings we just wrote.
    await _supersede_open_findings(
        session,
        contract_id=contract.id,
        playbook_id=playbook.id,
    )

    run = PlaybookReviewRun(
        organization_id=contract.organization_id,
        contract_id=contract.id,
        playbook_id=playbook.id,
        rules_checked=review.rules_checked,
        passed_count=review.passed_count,
        failed_count=review.failed_count,
    )
    session.add(run)
    await session.flush()

    findings = [
        _build_finding(
            organization_id=contract.organization_id,
            contract_id=contract.id,
            playbook_id=playbook.id,
            review_run_id=run.id,
            result=result,
        )
        for result in review.results
        if result.status == "fail"
    ]
    if findings:
        session.add_all(findings)
        await session.flush()

    return run, findings, review


async def update_finding_status(
    session: AsyncSession,
    *,
    finding: DeviationFinding,
    new_status: str,
) -> DeviationFinding:
    """Update a finding's reviewer workflow status.

    Validates that ``new_status`` is one of the reviewer-settable values
    (``open``, ``reviewed``, ``ignored``). The ``superseded`` value is
    intentionally not in the allowed set — it is owned by the rerun
    sweep.

    The function does not mutate any deterministic field
    (``status``, ``message``, span, ``rule_*``); only ``finding_status``
    and the ``updated_at`` timestamp change.
    """
    if new_status not in _REVIEWER_STATUSES:
        raise InvalidFindingStatusError(
            f"finding_status must be one of {sorted(_REVIEWER_STATUSES)!r}; "
            f"got {new_status!r}."
        )
    finding.finding_status = new_status
    await session.flush()
    # Refresh so the server-computed `updated_at` (onupdate=now()) is
    # available without triggering a lazy load when the API layer reads
    # it back.
    await session.refresh(finding)
    return finding


# --------------------------------------------------------------------------
# Internals
# --------------------------------------------------------------------------


async def _supersede_open_findings(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    playbook_id: uuid.UUID,
) -> int:
    """Flip prior ``OPEN`` findings on (contract, playbook) to ``SUPERSEDED``.

    Returns the number of rows that were flipped. The sweep is keyed
    on ``finding_status == OPEN`` exactly: ``REVIEWED`` and ``IGNORED``
    are deliberate human decisions and must persist across reruns.
    """
    stmt = (
        update(DeviationFinding)
        .where(
            DeviationFinding.contract_id == contract_id,
            DeviationFinding.playbook_id == playbook_id,
            DeviationFinding.finding_status == FindingStatus.OPEN.value,
        )
        .values(finding_status=FindingStatus.SUPERSEDED.value)
    )
    result = await session.execute(stmt)
    # `rowcount` is informational; tests assert it via a follow-up SELECT
    # rather than relying on this driver-dependent value.
    return result.rowcount or 0


def _build_finding(
    *,
    organization_id: uuid.UUID,
    contract_id: uuid.UUID,
    playbook_id: uuid.UUID,
    review_run_id: uuid.UUID,
    result: RuleMatchResult,
) -> DeviationFinding:
    """Materialize a `DeviationFinding` row from a matcher result.

    Span and clause fields are copied verbatim off ``result``. The
    matcher is the single source of truth for span fidelity; we do not
    revalidate against the source ``Clause`` here because doing so
    would invite a divergent definition of "matches".
    """
    matched_terms_value: list[str] | None
    matched_terms_value = list(result.matched_terms) if result.matched_terms else None

    clause_id_value: uuid.UUID | None = None
    if result.clause_id is not None:
        clause_id_value = uuid.UUID(result.clause_id)

    return DeviationFinding(
        organization_id=organization_id,
        contract_id=contract_id,
        playbook_id=playbook_id,
        review_run_id=review_run_id,
        rule_id=result.rule_id,
        rule_title=result.title,
        rule_type=result.rule_type,
        clause_type=result.clause_type,
        severity=result.severity,
        status=result.status,
        finding_status=FindingStatus.OPEN.value,
        message=result.message,
        clause_id=clause_id_value,
        evidence_text=result.evidence_text,
        span_start=result.span_start,
        span_end=result.span_end,
        matched_terms=matched_terms_value,
        expected_value=result.expected_value,
        guidance=result.guidance,
        preferred_language=result.preferred_language,
    )


async def list_review_runs_for_contract(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> Sequence[PlaybookReviewRun]:
    """Return runs for a contract, newest first."""
    stmt = (
        select(PlaybookReviewRun)
        .where(
            PlaybookReviewRun.contract_id == contract_id,
            PlaybookReviewRun.organization_id == organization_id,
        )
        .order_by(
            PlaybookReviewRun.created_at.desc(),
            PlaybookReviewRun.id.desc(),
        )
    )
    result = await session.execute(stmt)
    return result.scalars().all()


async def get_review_run_for_org(
    session: AsyncSession,
    *,
    run_id: uuid.UUID,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> PlaybookReviewRun | None:
    """Fetch one run by id, scoped to (contract, org)."""
    stmt = select(PlaybookReviewRun).where(
        PlaybookReviewRun.id == run_id,
        PlaybookReviewRun.contract_id == contract_id,
        PlaybookReviewRun.organization_id == organization_id,
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def list_findings_for_run(
    session: AsyncSession,
    *,
    run_id: uuid.UUID,
) -> Sequence[DeviationFinding]:
    """Return findings for a run, ordered by created_at then id (stable)."""
    stmt = (
        select(DeviationFinding)
        .where(DeviationFinding.review_run_id == run_id)
        .order_by(DeviationFinding.created_at.asc(), DeviationFinding.id.asc())
    )
    result = await session.execute(stmt)
    return result.scalars().all()


async def list_findings_for_contract(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
    playbook_id: uuid.UUID | None = None,
    finding_status: str | None = None,
    severity: str | None = None,
    review_run_id: uuid.UUID | None = None,
    include_superseded: bool = False,
) -> Sequence[DeviationFinding]:
    """List findings for a contract with optional filters.

    By default, ``superseded`` rows are excluded so the UI's "what
    needs my attention now" view doesn't have to know about the rerun
    sweep. Pass ``include_superseded=True`` to opt back in.
    """
    stmt = select(DeviationFinding).where(
        DeviationFinding.contract_id == contract_id,
        DeviationFinding.organization_id == organization_id,
    )
    if playbook_id is not None:
        stmt = stmt.where(DeviationFinding.playbook_id == playbook_id)
    if finding_status is not None:
        stmt = stmt.where(DeviationFinding.finding_status == finding_status)
    elif not include_superseded:
        stmt = stmt.where(
            DeviationFinding.finding_status != FindingStatus.SUPERSEDED.value
        )
    if severity is not None:
        stmt = stmt.where(DeviationFinding.severity == severity)
    if review_run_id is not None:
        stmt = stmt.where(DeviationFinding.review_run_id == review_run_id)
    stmt = stmt.order_by(
        DeviationFinding.created_at.desc(),
        DeviationFinding.id.desc(),
    )
    result = await session.execute(stmt)
    return result.scalars().all()


async def get_finding_for_org(
    session: AsyncSession,
    *,
    finding_id: uuid.UUID,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> DeviationFinding | None:
    """Fetch a finding by id, scoped to (contract, org)."""
    stmt = select(DeviationFinding).where(
        DeviationFinding.id == finding_id,
        DeviationFinding.contract_id == contract_id,
        DeviationFinding.organization_id == organization_id,
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()
