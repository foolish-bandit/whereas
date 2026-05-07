"""Dev-only first-run setup endpoints.

These endpoints are NOT real auth. They exist solely so a developer running
Whereas locally can create the minimum scaffolding needed to use the app:
an Organization with a wrapped master key and an active User whose UUID
the frontend can place into the `X-Whereas-Dev-User` header.

Hard rules:
  - Disabled in production. Both endpoints return 403 when
    `Settings.ENVIRONMENT == "production"` so production deployments don't
    leak org/user counts and definitely don't grant a working caller
    identity.
  - Never returns key material. The response carries UUIDs and
    human-readable strings only.
  - Idempotent. Repeated calls return the existing oldest active user
    instead of creating duplicates.
  - Backfill is conservative. A stranded org with `wrapped_master_key=None`
    gets one populated, but an existing wrapped key is never overwritten.
  - Audit logging uses the existing USER_CREATED event type. No new audit
    event types are introduced (the hash chain serialization is
    load-bearing and out of scope here).
"""
from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.models import Organization, User
from app.schemas.setup import (
    CreateDevSetupRequest,
    CreateDevSetupResponse,
    SetupStatusResponse,
)
from app.security.audit_log import AuditEventType, record_event
from app.security.encryption import (
    EncryptionError,
    create_org_master_key,
    load_instance_key,
)

router = APIRouter()
log = logging.getLogger(__name__)

DbSession = Annotated[AsyncSession, Depends(get_db)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

DEFAULT_ORG_NAME = "Local Workspace"
DEFAULT_USER_EMAIL = "dev@whereas.local"
DEFAULT_USER_NAME = "Local Developer"

# A non-empty placeholder so the NOT-NULL constraint on `users.password_hash`
# is satisfied without anyone mistaking this for a real credential. The
# auth stubs do not log in, and there is no production code path that
# evaluates this value as a hash.
_DEV_PASSWORD_PLACEHOLDER = "!dev-no-password!"


def _require_dev_mode(settings: SettingsDep) -> Settings:
    if settings.ENVIRONMENT == "production":
        raise HTTPException(
            status_code=403,
            detail="First-run setup is disabled in production.",
        )
    return settings


@router.get("/status", response_model=SetupStatusResponse)
async def get_setup_status(
    session: DbSession,
    settings: Annotated[Settings, Depends(_require_dev_mode)],
) -> SetupStatusResponse:
    org_count = await _count(session, Organization)
    user_count = await _count(session, User)
    setup_required = org_count == 0 or user_count == 0
    return SetupStatusResponse(
        setup_required=setup_required,
        organization_count=org_count,
        user_count=user_count,
        dev_mode_enabled=settings.ENVIRONMENT != "production",
        message=(
            "Run POST /api/setup/dev to create a local development workspace."
            if setup_required
            else "A development workspace already exists."
        ),
    )


@router.post(
    "/dev", response_model=CreateDevSetupResponse, status_code=200
)
async def create_dev_setup(
    payload: CreateDevSetupRequest,
    session: DbSession,
    _settings: Annotated[Settings, Depends(_require_dev_mode)],
) -> CreateDevSetupResponse:
    org_name = _clean_str(payload.organization_name) or DEFAULT_ORG_NAME
    user_name = _clean_str(payload.user_name) or DEFAULT_USER_NAME
    user_email = _clean_email(payload.user_email) or DEFAULT_USER_EMAIL

    # Pick the oldest org if any exists; otherwise create one. Picking by
    # creation time keeps the heuristic stable across repeated calls in
    # databases with multiple orgs.
    org = await _oldest_org(session)
    org_was_created = False
    backfilled_key = False
    if org is None:
        org = Organization(name=org_name)
        session.add(org)
        await session.flush()
        org_was_created = True

    # Backfill the wrapped master key only when it is missing. Never
    # overwrite an existing wrapped key — that would orphan every document
    # in the org.
    if org.wrapped_master_key is None:
        instance_key = _load_instance_key_or_http()
        try:
            wrapped = create_org_master_key(
                organization_id=str(org.id),
                instance_key=instance_key,
            )
        finally:
            del instance_key
        org.wrapped_master_key = wrapped.to_bytes()
        await session.flush()
        backfilled_key = backfilled_key or not org_was_created

    # Existing active user in this org → return it. Otherwise create one.
    user = await _oldest_active_user(session, org.id)
    user_was_created = False
    if user is None:
        user = User(
            organization_id=org.id,
            email=user_email,
            display_name=user_name,
            password_hash=_DEV_PASSWORD_PLACEHOLDER,
            is_active=True,
            is_admin=True,
        )
        session.add(user)
        try:
            await session.flush()
        except Exception as e:
            # Most likely cause: a unique-email collision against an inactive
            # or other-org user. Surface a clean 409 instead of a stack trace.
            await session.rollback()
            raise HTTPException(
                status_code=409,
                detail=(
                    "Could not create a development user. The email may "
                    "already be registered. Pass a different user_email "
                    "and try again."
                ),
            ) from e
        user_was_created = True
        await record_event(
            session,
            organization_id=org.id,
            event_type=AuditEventType.USER_CREATED,
            actor_user_id=user.id,
            target_type="user",
            target_id=str(user.id),
            details={"via": "dev_setup", "email": user.email},
        )

    message = _summary_message(
        org_was_created=org_was_created,
        user_was_created=user_was_created,
        backfilled_key=backfilled_key,
    )

    return CreateDevSetupResponse(
        organization_id=org.id,
        user_id=user.id,
        dev_user_id=user.id,
        organization_name=org.name,
        user_email=user.email,
        message=message,
    )


async def _count(session: AsyncSession, model: type) -> int:
    result = await session.execute(select(func.count()).select_from(model))
    return int(result.scalar_one())


async def _oldest_org(session: AsyncSession) -> Organization | None:
    result = await session.execute(
        select(Organization).order_by(Organization.created_at.asc()).limit(1)
    )
    return result.scalar_one_or_none()


async def _oldest_active_user(
    session: AsyncSession, organization_id: uuid.UUID
) -> User | None:
    result = await session.execute(
        select(User)
        .where(User.organization_id == organization_id, User.is_active.is_(True))
        .order_by(User.created_at.asc())
        .limit(1)
    )
    return result.scalar_one_or_none()


def _clean_str(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _clean_email(value: str | None) -> str | None:
    """Light email validation. Empty/whitespace-only is treated as absent.

    A real email validator is intentionally not used here; this is a
    dev-only flow and the surrounding code never sends mail. We just
    reject obviously broken inputs.
    """
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    if "@" not in cleaned or cleaned.startswith("@") or cleaned.endswith("@"):
        raise HTTPException(
            status_code=422,
            detail="user_email must be a valid email address.",
        )
    return cleaned


def _load_instance_key_or_http() -> bytes:
    try:
        return load_instance_key()
    except EncryptionError as e:
        raise HTTPException(
            status_code=500,
            detail="Encryption instance key is not configured.",
        ) from e


def _summary_message(
    *,
    org_was_created: bool,
    user_was_created: bool,
    backfilled_key: bool,
) -> str:
    if org_was_created and user_was_created:
        return "Created new development workspace."
    if user_was_created and backfilled_key:
        return (
            "Returned existing development workspace. Backfilled wrapped "
            "master key and added an active user."
        )
    if user_was_created:
        return (
            "Returned existing development workspace and added an active "
            "user."
        )
    if backfilled_key:
        return (
            "Returned existing development workspace. Backfilled wrapped "
            "master key."
        )
    return "Returned existing development workspace."
