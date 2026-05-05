"""Contract management routes.

These are stubs that show the intended shape; full implementation is the next
milestone. Do not rely on them yet.
"""
from fastapi import APIRouter, UploadFile

router = APIRouter()


@router.post("/upload")
async def upload_contract(file: UploadFile) -> dict[str, str]:
    """Upload a contract.

    Pipeline (to be implemented):
      1. Save to S3 with a content-addressed key (sha256).
      2. Create Contract row in status=UPLOADED.
      3. Enqueue extraction job.
      4. Return the contract id; client polls or subscribes for status.
    """
    return {"status": "not_implemented", "filename": file.filename or "unknown"}


@router.get("")
async def list_contracts() -> list[dict]:
    """List contracts for the current user's organization."""
    return []


@router.get("/{contract_id}")
async def get_contract(contract_id: str) -> dict[str, str]:
    """Get a single contract with its extracted fields and clauses."""
    return {"id": contract_id, "status": "not_implemented"}


@router.get("/{contract_id}/fields")
async def list_extracted_fields(contract_id: str) -> list[dict]:
    """List extracted metadata fields for a contract.

    Each field includes the value, the span (with character offsets), and the
    confidence score. The frontend renders the span as a clickable highlight
    in the document viewer.
    """
    return []


@router.get("/{contract_id}/deviations")
async def list_deviations(contract_id: str) -> list[dict]:
    """List playbook deviation findings for a contract."""
    return []
