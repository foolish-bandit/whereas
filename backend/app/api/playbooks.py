"""Playbook routes — read-only management of YAML rule libraries.

v1 scope (this PR):
  - Validate a YAML playbook without persisting it (`POST /validate`).
  - Create a playbook from validated YAML (`POST ""`).
  - List the calling org's playbooks (`GET ""`).
  - Read one playbook's parsed rules (`GET /{id}`).
  - Soft-delete (deactivate) a playbook (`DELETE /{id}`).

What this PR does NOT do:
  - Match playbook rules against segmented clauses.
  - Generate deviation findings.
  - Suggest redlines.

Auth model mirrors `app.api.contracts`: the dev-only
`X-Whereas-Dev-User` header identifies the caller; org scoping is
derived from `User.organization_id`. Any production-grade auth comes
later.
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import Playbook, User
from app.schemas.playbooks import (
    PlaybookCreateRequest,
    PlaybookDetailResponse,
    PlaybookRuleSummary,
    PlaybookSummaryResponse,
    PlaybookValidateRequest,
    PlaybookValidateResponse,
    PlaybookValidationErrorResponse,
)
from app.services.playbook_loader import (
    PlaybookDocument,
    PlaybookValidationError,
    parse_playbook,
    serialize_playbook,
)

log = logging.getLogger(__name__)

router = APIRouter()
DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.post(
    "/validate",
    response_model=PlaybookValidateResponse,
    responses={400: {"model": PlaybookValidationErrorResponse}},
)
async def validate_playbook(
    payload: PlaybookValidateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> PlaybookValidateResponse:
    """Validate a YAML playbook without persisting it.

    Useful for the in-app YAML editor to surface errors before save.
    The endpoint requires an authenticated dev user so it is not a
    public parse-anything-arbitrary surface.
    """
    await _current_dev_user(session, x_whereas_dev_user)
    playbook = _parse_or_400(payload.yaml_source)
    return _validate_response(playbook)


@router.post(
    "",
    response_model=PlaybookDetailResponse,
    status_code=201,
    responses={400: {"model": PlaybookValidationErrorResponse}},
)
async def create_playbook(
    payload: PlaybookCreateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> PlaybookDetailResponse:
    """Create a playbook from validated YAML."""
    user = await _current_dev_user(session, x_whereas_dev_user)
    parsed = _parse_or_400(payload.yaml_source)

    # Org-scoped name uniqueness. We treat the (org, name) collision
    # as a 409: the user can pick a different name or, eventually,
    # update the existing playbook (PATCH support is a follow-up).
    existing = await session.execute(
        select(Playbook).where(
            Playbook.organization_id == user.organization_id,
            Playbook.name == parsed.name,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"A playbook named {parsed.name!r} already exists in this "
                "organization. Pick a different name."
            ),
        )

    playbook = Playbook(
        organization_id=user.organization_id,
        name=parsed.name,
        description=parsed.description,
        jurisdiction=parsed.jurisdiction,
        contract_type=parsed.contract_type,
        version=parsed.version,
        yaml_source=payload.yaml_source,
        parsed_rules=serialize_playbook(parsed),
        is_active=True,
    )
    session.add(playbook)
    await session.flush()
    await session.refresh(playbook)
    return _detail_response(playbook, parsed=parsed)


@router.get("", response_model=list[PlaybookSummaryResponse])
async def list_playbooks(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    include_inactive: bool = False,
) -> list[PlaybookSummaryResponse]:
    """List playbooks for the calling user's organization.

    By default, only `is_active=true` playbooks are returned —
    deactivated rows are kept for audit and for future deviation-
    finding back-references, but they should not show up in the
    common "what playbooks do we have?" view. Pass
    `?include_inactive=true` to return everything in the org.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    stmt = (
        select(Playbook)
        .where(Playbook.organization_id == user.organization_id)
        .order_by(Playbook.created_at.desc(), Playbook.id.desc())
    )
    if not include_inactive:
        stmt = stmt.where(Playbook.is_active.is_(True))
    result = await session.execute(stmt)
    return [_summary_response(p) for p in result.scalars()]


@router.get("/{playbook_id}", response_model=PlaybookDetailResponse)
async def get_playbook(
    playbook_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    include_inactive: bool = False,
) -> PlaybookDetailResponse:
    """Return one playbook with its YAML and parsed rule list.

    Inactive playbooks 404 by default. The caller must opt in via
    `?include_inactive=true` to fetch a deactivated row. This keeps
    the default behavior consistent with `GET /api/playbooks` and
    avoids accidentally surfacing archived rules in clients that
    don't filter on `is_active` themselves.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    playbook = await _get_playbook_for_org(
        session,
        playbook_id=playbook_id,
        organization_id=user.organization_id,
    )
    if not playbook.is_active and not include_inactive:
        # 404 not 403: same logic as cross-org access — do not leak
        # the existence of deactivated playbooks to callers that
        # haven't explicitly asked for them.
        raise HTTPException(status_code=404, detail="Playbook not found.")
    return _detail_response(playbook)


@router.delete("/{playbook_id}", response_model=PlaybookSummaryResponse)
async def deactivate_playbook(
    playbook_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> PlaybookSummaryResponse:
    """Soft-delete: flip `is_active` to false.

    Hard delete is intentionally omitted in v1. Future deviation
    findings will be pinned to a playbook id, and removing the
    underlying row would leave them dangling. Deactivation is
    reversible — a future PATCH endpoint will flip the flag back.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    playbook = await _get_playbook_for_org(
        session,
        playbook_id=playbook_id,
        organization_id=user.organization_id,
    )
    if playbook.is_active:
        playbook.is_active = False
        await session.flush()
        await session.refresh(playbook)
    return _summary_response(playbook)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


async def _current_dev_user(
    session: AsyncSession,
    header_value: str | None,
) -> User:
    """Resolve the dev user from the X-Whereas-Dev-User header.

    Mirrors `app.api.contracts._current_dev_user`. Kept local so a
    future swap to real auth doesn't have to thread through both
    routers at once.
    """
    if not header_value:
        raise HTTPException(status_code=401, detail="Missing X-Whereas-Dev-User header.")
    try:
        user_id = uuid.UUID(header_value)
    except ValueError as exc:
        raise HTTPException(
            status_code=401, detail="Invalid X-Whereas-Dev-User header."
        ) from exc

    result = await session.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail="User not found.")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="User is inactive.")
    if user.organization_id is None:
        raise HTTPException(status_code=403, detail="User has no organization.")
    return user


async def _get_playbook_for_org(
    session: AsyncSession,
    *,
    playbook_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> Playbook:
    stmt = select(Playbook).where(
        Playbook.id == playbook_id,
        Playbook.organization_id == organization_id,
    )
    result = await session.execute(stmt)
    playbook = result.scalar_one_or_none()
    if playbook is None:
        # 404, not 403, on cross-org access: do not leak existence.
        raise HTTPException(status_code=404, detail="Playbook not found.")
    return playbook


def _parse_or_400(yaml_source: str) -> PlaybookDocument:
    """Run the YAML loader, translating loader errors into HTTP 400s."""
    try:
        return parse_playbook(yaml_source)
    except PlaybookValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "ok": False,
                "errors": [issue.to_dict() for issue in exc.errors],
            },
        ) from exc


def _rule_summaries(parsed: PlaybookDocument) -> list[PlaybookRuleSummary]:
    return [
        PlaybookRuleSummary(
            id=rule.id,
            title=rule.title,
            rule_type=rule.rule_type,
            clause_type=rule.clause_type,
            severity=rule.severity,
        )
        for rule in parsed.rules
    ]


def _rule_count(parsed_rules: Any) -> int:
    """Count rules in the persisted JSON projection.

    Defensive against a malformed row (which shouldn't happen because
    the column is non-NULL and writes go through the validator).
    """
    if not isinstance(parsed_rules, dict):
        return 0
    rules = parsed_rules.get("rules", [])
    if not isinstance(rules, list):
        return 0
    return len(rules)


def _summary_response(playbook: Playbook) -> PlaybookSummaryResponse:
    return PlaybookSummaryResponse(
        id=playbook.id,
        name=playbook.name,
        description=playbook.description,
        jurisdiction=playbook.jurisdiction,
        contract_type=playbook.contract_type,
        version=playbook.version,
        is_active=playbook.is_active,
        rule_count=_rule_count(playbook.parsed_rules),
        created_at=playbook.created_at,
        updated_at=playbook.updated_at,
    )


def _detail_response(
    playbook: Playbook,
    *,
    parsed: PlaybookDocument | None = None,
) -> PlaybookDetailResponse:
    """Build the detail projection.

    If `parsed` is provided (e.g. from create / validate, where the
    parsed object is in hand), use it for the rule summaries to avoid
    a round-trip through the JSON column. Otherwise re-validate the
    persisted YAML; if revalidation fails (a corrupt row), fall back
    to summarizing whatever rule shapes we find in `parsed_rules` so
    the UI can still surface and let the user fix or delete the row.
    """
    if parsed is None:
        try:
            parsed = parse_playbook(playbook.yaml_source)
        except PlaybookValidationError:
            log.warning(
                "Stored playbook failed re-validation; serving best-effort summary",
                extra={"playbook_id": str(playbook.id)},
            )
            parsed = None

    rules: list[PlaybookRuleSummary]
    rules = _rule_summaries(parsed) if parsed is not None else list(
        _rules_from_persisted(playbook.parsed_rules)
    )

    summary = _summary_response(playbook)
    summary_data = summary.model_dump()
    summary_data["rule_count"] = len(rules)

    parsed_rules = playbook.parsed_rules if isinstance(playbook.parsed_rules, dict) else {}
    return PlaybookDetailResponse(
        **summary_data,
        yaml_source=playbook.yaml_source,
        parsed_rules=parsed_rules,
        rules=rules,
    )


def _rules_from_persisted(parsed_rules: Any) -> Iterable[PlaybookRuleSummary]:
    """Best-effort summary of a persisted parsed_rules dict.

    Used only when revalidation fails; does not enforce schema.
    Skips any entry that lacks the minimum fields.
    """
    if not isinstance(parsed_rules, dict):
        return
    rules = parsed_rules.get("rules", [])
    if not isinstance(rules, list):
        return
    for entry in rules:
        if not isinstance(entry, dict) or "id" not in entry:
            continue
        try:
            yield PlaybookRuleSummary(
                id=str(entry["id"]),
                title=str(entry.get("title", entry["id"])),
                rule_type=str(entry.get("rule_type", "unknown")),
                clause_type=str(entry.get("clause_type", "")),
                severity=str(entry.get("severity", "info")),
            )
        except (KeyError, TypeError):
            continue


def _validate_response(parsed: PlaybookDocument) -> PlaybookValidateResponse:
    return PlaybookValidateResponse(
        name=parsed.name,
        description=parsed.description,
        jurisdiction=parsed.jurisdiction,
        contract_type=parsed.contract_type,
        version=parsed.version,
        rule_count=len(parsed.rules),
        rules=_rule_summaries(parsed),
    )
