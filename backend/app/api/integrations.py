"""HTTP routes for third-party integrations (Nango bridge).

The flow:

1. ``GET /providers`` lists the providers the Nango deployment is
   actually configured for.
2. ``POST /connect-sessions`` mints a Nango Connect session token. The
   frontend hands the token to Nango's Connect widget, which runs the
   OAuth dance and returns a ``connection_id`` to the frontend.
3. ``POST /connections`` records the ``connection_id`` against the
   caller's organization, creating (or refreshing) the
   ``IntegrationConnection`` row.
4. ``POST /connections/{id}/sync`` walks Nango's record set for the
   connection and ingests each new file (idempotent).
5. ``POST /webhook`` is the receiver Nango POSTs to whenever a sync
   produces new records. Signature is verified per
   ``nango_client.verify_webhook``.
"""
from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.contracts import _current_dev_user
from app.core.config import get_settings
from app.core.database import get_db
from app.models import (
    IntegrationConnection,
    IntegrationConnectionStatus,
    IntegrationIngestMode,
    IntegrationProvider,
    User,
)
from app.schemas.integrations import (
    CompleteConnectionRequest,
    CreateConnectSessionRequest,
    CreateConnectSessionResponse,
    IntegrationConnectionResponse,
    IntegrationProviderResponse,
    ManualSyncResponse,
    UpdateConnectionRequest,
)
from app.security.audit_log import AuditEventType, record_event
from app.services import integration_ingest, nango_client
from app.services.nango_client import (
    NangoError,
    NangoWebhookVerificationError,
)

log = logging.getLogger(__name__)

router = APIRouter()
DbSession = Annotated[AsyncSession, Depends(get_db)]

_VALID_PROVIDERS = {p.value for p in IntegrationProvider}
_VALID_INGEST_MODES = {m.value for m in IntegrationIngestMode}

_PROVIDER_LABELS: dict[str, tuple[str, str]] = {
    IntegrationProvider.GOOGLE_DRIVE.value: (
        "Google Drive",
        "Import contracts from a connected Google Drive folder.",
    ),
    IntegrationProvider.MICROSOFT_ONEDRIVE.value: (
        "Microsoft OneDrive",
        "Import contracts from a connected OneDrive folder.",
    ),
    IntegrationProvider.MICROSOFT_SHAREPOINT.value: (
        "Microsoft SharePoint",
        "Import contracts from a connected SharePoint document library.",
    ),
    IntegrationProvider.GMAIL.value: (
        "Gmail",
        "Ingest contracts attached to incoming Gmail messages.",
    ),
    IntegrationProvider.OUTLOOK.value: (
        "Microsoft Outlook",
        "Ingest contracts attached to incoming Outlook messages.",
    ),
}


def _enabled_providers() -> set[str]:
    settings = get_settings()
    return {
        p.strip()
        for p in (settings.NANGO_ENABLED_PROVIDERS or "").split(",")
        if p.strip()
    }


def _require_admin(user: User) -> None:
    if not user.is_admin:
        raise HTTPException(
            status_code=403,
            detail="Only administrators can manage integrations.",
        )


@router.get("/providers", response_model=list[IntegrationProviderResponse])
async def list_providers(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> list[IntegrationProviderResponse]:
    await _current_dev_user(session, x_whereas_dev_user)
    enabled = _enabled_providers()
    return [
        IntegrationProviderResponse(
            key=key,
            label=label,
            description=description,
            available=key in enabled,
        )
        for key, (label, description) in _PROVIDER_LABELS.items()
    ]


@router.get("/connections", response_model=list[IntegrationConnectionResponse])
async def list_connections(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> list[IntegrationConnectionResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    rows = (
        await session.execute(
            select(IntegrationConnection)
            .where(IntegrationConnection.organization_id == user.organization_id)
            .order_by(IntegrationConnection.created_at)
        )
    ).scalars().all()
    return [IntegrationConnectionResponse.model_validate(r) for r in rows]


@router.post(
    "/connect-sessions",
    response_model=CreateConnectSessionResponse,
    status_code=201,
)
async def create_connect_session(
    payload: CreateConnectSessionRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> CreateConnectSessionResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    _require_admin(user)
    if payload.provider not in _VALID_PROVIDERS:
        raise HTTPException(status_code=400, detail="Unknown provider.")
    if payload.provider not in _enabled_providers():
        raise HTTPException(
            status_code=503,
            detail="This integration is not enabled on the Nango deployment.",
        )
    try:
        result = await nango_client.create_connect_session(
            organization_id=str(user.organization_id),
            provider=payload.provider,
            end_user_email=user.email,
        )
    except NangoError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return CreateConnectSessionResponse(
        token=result.token,
        expires_at=result.expires_at,
    )


@router.post(
    "/connections",
    response_model=IntegrationConnectionResponse,
    status_code=201,
)
async def upsert_connection(
    payload: CompleteConnectionRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> IntegrationConnectionResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    _require_admin(user)
    if payload.provider not in _VALID_PROVIDERS:
        raise HTTPException(status_code=400, detail="Unknown provider.")
    ingest_mode = _validate_ingest_mode(payload.ingest_mode)

    existing = (
        await session.execute(
            select(IntegrationConnection).where(
                IntegrationConnection.organization_id == user.organization_id,
                IntegrationConnection.provider == payload.provider,
            )
        )
    ).scalar_one_or_none()

    if existing is None:
        connection = IntegrationConnection(
            organization_id=user.organization_id,
            provider=payload.provider,
            nango_connection_id=payload.nango_connection_id,
            status=IntegrationConnectionStatus.ACTIVE.value,
            ingest_mode=ingest_mode
            or IntegrationIngestMode.INBOX_REVIEW.value,
            display_name=payload.display_name,
            created_by=user.id,
        )
        session.add(connection)
        event = AuditEventType.INTEGRATION_CONNECTION_CREATED
    else:
        existing.nango_connection_id = payload.nango_connection_id
        existing.status = IntegrationConnectionStatus.ACTIVE.value
        if payload.display_name is not None:
            existing.display_name = payload.display_name
        if ingest_mode is not None:
            existing.ingest_mode = ingest_mode
        existing.last_sync_error = None
        connection = existing
        event = AuditEventType.INTEGRATION_CONNECTION_UPDATED

    await session.flush()
    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=event,
        actor_user_id=user.id,
        target_type="integration_connection",
        target_id=str(connection.id),
        details={
            "provider": connection.provider,
            "ingest_mode": connection.ingest_mode,
        },
    )
    await session.refresh(connection)
    return IntegrationConnectionResponse.model_validate(connection)


@router.patch(
    "/connections/{connection_id}",
    response_model=IntegrationConnectionResponse,
)
async def update_connection(
    connection_id: uuid.UUID,
    payload: UpdateConnectionRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> IntegrationConnectionResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    _require_admin(user)
    connection = await _load_connection(session, connection_id, user.organization_id)
    ingest_mode = _validate_ingest_mode(payload.ingest_mode)
    if payload.display_name is not None:
        connection.display_name = payload.display_name
    if ingest_mode is not None:
        connection.ingest_mode = ingest_mode
    await session.flush()
    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.INTEGRATION_CONNECTION_UPDATED,
        actor_user_id=user.id,
        target_type="integration_connection",
        target_id=str(connection.id),
        details={
            "provider": connection.provider,
            "ingest_mode": connection.ingest_mode,
        },
    )
    await session.refresh(connection)
    return IntegrationConnectionResponse.model_validate(connection)


@router.delete("/connections/{connection_id}", status_code=204)
async def delete_connection(
    connection_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> None:
    user = await _current_dev_user(session, x_whereas_dev_user)
    _require_admin(user)
    connection = await _load_connection(session, connection_id, user.organization_id)
    # Best-effort: tell Nango to forget the connection. A Nango failure
    # here must not block us from forgetting the row on our side, but a
    # transport-level error gets surfaced so the operator knows the
    # remote side may still hold the token.
    nango_error: str | None = None
    try:
        await nango_client.delete_connection(
            connection_id=connection.nango_connection_id,
            provider=connection.provider,
        )
    except NangoError as exc:
        log.warning(
            "Nango delete_connection failed; removing local row anyway",
            extra={"connection_id": str(connection.id)},
        )
        nango_error = str(exc)
    await session.delete(connection)
    await session.flush()
    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.INTEGRATION_CONNECTION_DELETED,
        actor_user_id=user.id,
        target_type="integration_connection",
        target_id=str(connection_id),
        details={
            "provider": connection.provider,
            "nango_error": nango_error,
        },
    )


@router.post(
    "/connections/{connection_id}/sync",
    response_model=ManualSyncResponse,
)
async def trigger_sync(
    connection_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ManualSyncResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    _require_admin(user)
    connection = await _load_connection(session, connection_id, user.organization_id)

    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.INTEGRATION_SYNC_TRIGGERED,
        actor_user_id=user.id,
        target_type="integration_connection",
        target_id=str(connection.id),
        details={"provider": connection.provider},
    )

    try:
        files, cursor = await nango_client.list_files(
            connection_id=connection.nango_connection_id,
            provider=connection.provider,
        )
    except NangoError as exc:
        connection.last_sync_error = str(exc)
        connection.status = IntegrationConnectionStatus.ERROR.value
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    created = 0
    skipped = 0
    for file in files:
        try:
            result = await integration_ingest.ingest_file(
                session, connection=connection, file=file
            )
        except integration_ingest.IngestSkippedError as exc:
            skipped += 1
            log.info(
                "Integration file skipped",
                extra={
                    "connection_id": str(connection.id),
                    "provider_file_id": file.provider_file_id,
                    "reason": str(exc),
                },
            )
            continue
        except NangoError as exc:
            connection.last_sync_error = str(exc)
            connection.status = IntegrationConnectionStatus.ERROR.value
            raise HTTPException(
                status_code=exc.status_code, detail=str(exc)
            ) from exc
        if result.created:
            created += 1
        elif result.skipped_reason is not None:
            skipped += 1

    return ManualSyncResponse(
        connection_id=connection.id,
        files_seen=len(files),
        contracts_created=created,
        skipped=skipped,
        cursor=cursor,
    )


@router.post("/webhook", status_code=202)
async def nango_webhook(
    request: Request,
    session: DbSession,
) -> dict[str, str]:
    """Receive a Nango outbound webhook.

    Nango fires this whenever a sync completes for a connection. We
    re-pull the list of records (using the manual-sync path) instead
    of trusting the webhook payload to carry file content, because
    the payload shape varies by sync template and we want one ingest
    code path, not two.
    """
    body = await request.body()
    try:
        nango_client.verify_webhook(headers=request.headers, body=body)
    except NangoWebhookVerificationError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="Body is not JSON.") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Body is not a JSON object.")

    nango_connection_id = payload.get("connectionId") or payload.get("connection_id")
    provider = (
        payload.get("providerConfigKey")
        or payload.get("provider_config_key")
        or payload.get("provider")
    )
    if not isinstance(nango_connection_id, str) or not isinstance(provider, str):
        # Unknown shape — acknowledge so Nango doesn't keep retrying;
        # log so an operator can investigate.
        log.warning(
            "Nango webhook missing connection_id or provider; ignoring",
            extra={"keys": sorted(payload.keys())},
        )
        return {"status": "ignored"}

    connection = (
        await session.execute(
            select(IntegrationConnection).where(
                IntegrationConnection.nango_connection_id == nango_connection_id,
                IntegrationConnection.provider == provider,
            )
        )
    ).scalar_one_or_none()
    if connection is None:
        log.info(
            "Nango webhook for unknown connection",
            extra={"provider": provider},
        )
        return {"status": "ignored"}

    try:
        files, _ = await nango_client.list_files(
            connection_id=connection.nango_connection_id,
            provider=connection.provider,
        )
    except NangoError as exc:
        connection.last_sync_error = str(exc)
        connection.status = IntegrationConnectionStatus.ERROR.value
        log.warning(
            "Nango webhook list_files failed",
            extra={"connection_id": str(connection.id)},
        )
        return {"status": "error"}

    created = 0
    for file in files:
        try:
            result = await integration_ingest.ingest_file(
                session, connection=connection, file=file
            )
        except integration_ingest.IngestSkippedError:
            continue
        except NangoError:
            connection.status = IntegrationConnectionStatus.ERROR.value
            break
        if result.created:
            created += 1

    log.info(
        "Nango webhook processed",
        extra={
            "connection_id": str(connection.id),
            "files_seen": len(files),
            "contracts_created": created,
        },
    )
    return {"status": "ok"}


async def _load_connection(
    session: AsyncSession,
    connection_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> IntegrationConnection:
    row = (
        await session.execute(
            select(IntegrationConnection).where(
                IntegrationConnection.id == connection_id,
                IntegrationConnection.organization_id == organization_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Connection not found.")
    return row


def _validate_ingest_mode(value: str | None) -> str | None:
    if value is None:
        return None
    if value not in _VALID_INGEST_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"ingest_mode must be one of {sorted(_VALID_INGEST_MODES)}.",
        )
    return value
