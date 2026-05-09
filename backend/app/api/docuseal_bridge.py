"""DocuSeal integration routes.

The send-for-signature flow lives on the contracts router as
``POST /api/contracts/{contract_id}/send-to-docuseal`` (see
``app.api.contracts.send_contract_to_docuseal``); it is org-scoped via
the existing contract helpers and resolves the right artifact through
the artifact model. This module owns the (public) completion webhook
that DocuSeal POSTs when a submission finishes.
"""
from __future__ import annotations

import json
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.services.docuseal_bridge import (
    WebhookVerificationError,
    verify_docuseal_webhook,
)
from app.services.docuseal_completion import (
    WebhookProcessingError,
    apply_completion_event,
)

log = logging.getLogger(__name__)

router = APIRouter()
DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.post("/webhook", status_code=202)
async def docuseal_webhook(
    request: Request,
    session: DbSession,
) -> dict[str, Any]:
    """Receive submission status updates from DocuSeal.

    Authenticated via ``verify_docuseal_webhook`` (HMAC-SHA256 over the
    raw body, or an interim shared-secret header — see the verifier).
    The endpoint always returns 202 on a verified request, including
    when the event is irrelevant or the submission id is unknown to
    Whereas, so DocuSeal will not retry-storm against us for events we
    intentionally ignore. Non-verified requests are 401.

    On a completed event we materialize a ``signed_pdf``
    ``ContractArtifact``, flip the contract status to ``EXECUTED``,
    and write a safe audit event. Idempotent: a duplicate completion
    event for the same submission is a no-op (returns
    ``status="duplicate"`` to operators reading logs but does not
    mutate state).

    The endpoint never echoes ``storage_key``, ``wrapped_dek``, raw
    document bytes, or signer PII back to DocuSeal.
    """
    body = await request.body()
    try:
        verify_docuseal_webhook(
            headers=dict(request.headers),
            body=body,
            settings=get_settings(),
        )
    except WebhookVerificationError as exc:
        # Don't leak which side of the secret check failed — DocuSeal
        # operators will recognize the 401 and re-check the secret;
        # an attacker probing for header names should not.
        log.warning(
            "Rejecting DocuSeal webhook: %s",
            exc,
            extra={"docuseal_webhook_status": exc.status_code},
        )
        raise HTTPException(status_code=exc.status_code, detail="Unauthorized.") from exc

    try:
        payload = json.loads(body) if body else {}
        if not isinstance(payload, dict):
            raise ValueError("Webhook body is not a JSON object.")
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="Webhook body is not valid JSON."
        ) from exc

    try:
        result = await apply_completion_event(session, payload=payload)
    except WebhookProcessingError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    return {
        "status": result.status,
        "contract_id": str(result.contract_id) if result.contract_id else None,
        "artifact_id": str(result.artifact_id) if result.artifact_id else None,
    }
