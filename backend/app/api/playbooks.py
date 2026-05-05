"""Playbook routes - CRUD over firm-defined position libraries."""
from fastapi import APIRouter, HTTPException

from app.services.playbook_schema import PlaybookParseError, parse_playbook

router = APIRouter()


@router.post("/validate")
async def validate_playbook(yaml_source: str) -> dict:
    """Validate a playbook YAML without persisting it.

    Useful for the in-app YAML editor to surface errors before save.
    """
    try:
        playbook = parse_playbook(yaml_source)
    except PlaybookParseError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {
        "ok": True,
        "name": playbook.name,
        "rule_count": len(playbook.rules),
    }


@router.get("")
async def list_playbooks() -> list[dict]:
    """List playbooks for the current organization."""
    return []


@router.post("")
async def create_playbook(name: str, yaml_source: str) -> dict[str, str]:
    """Create a new playbook from YAML source."""
    try:
        parse_playbook(yaml_source)
    except PlaybookParseError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"status": "not_implemented", "name": name}
