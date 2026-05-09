"""DocuSeal integration routes.

The send-for-signature flow lives on the contracts router as
``POST /api/contracts/{contract_id}/send-to-docuseal`` (see
``app.api.contracts.send_contract_to_docuseal``); it is org-scoped via
the existing contract helpers and resolves the right artifact through
the artifact model. This module retains the webhook stub only.
"""
from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.post("/webhook")
async def docuseal_webhook(payload: dict) -> dict[str, str]:
    """Receive submission status updates from DocuSeal.

    On 'completed' events, a future PR will materialize a
    ``signed_pdf`` ``ContractArtifact`` and flip the Contract status to
    EXECUTED. Webhook signature verification is gated on
    ``app.services.docuseal_bridge.verify_docuseal_webhook`` landing
    first; the stub exists so the route is discoverable.
    """
    raise HTTPException(status_code=501, detail="Not implemented")
