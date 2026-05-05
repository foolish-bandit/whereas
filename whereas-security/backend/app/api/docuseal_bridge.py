"""DocuSeal integration routes."""
from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.post("/contracts/{contract_id}/send-for-signature")
async def send_for_signature(contract_id: str, submitters: list[dict]) -> dict:
    """Send a contract to DocuSeal for signature collection.

    Pipeline:
      1. Generate a signed S3 URL for the contract PDF.
      2. POST to DocuSeal /api/submissions with the auth-bridge JWT.
      3. Store the docuseal_submission_id on the Contract row.
      4. Return the embed URL for the frontend to render the signing UI inline.
    """
    raise HTTPException(status_code=501, detail="Not implemented")


@router.post("/webhook")
async def docuseal_webhook(payload: dict) -> dict[str, str]:
    """Receive submission status updates from DocuSeal.

    On 'completed' events, update the Contract status to EXECUTED and store the
    signed PDF in S3 alongside the original.
    """
    raise HTTPException(status_code=501, detail="Not implemented")
