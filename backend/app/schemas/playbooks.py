"""Request and response schemas for the playbooks API.

The persistence layer stores `parsed_rules` as raw JSON, but the
public API surfaces strongly-typed responses so the frontend gets
narrowed types out of the box. The validation layer
(`app.services.playbook_loader`) is the single source of truth for
rule shape; these schemas mirror it for API contract purposes.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# We reuse PLAYBOOK_SCHEMA_VERSION so a /validate response can advertise
# which schema version produced the parse — useful when the format
# eventually evolves and clients need to know what they're looking at.
from app.services.playbook_loader import PLAYBOOK_SCHEMA_VERSION


class PlaybookCreateRequest(BaseModel):
    """Body for `POST /api/playbooks`.

    Only the YAML source is required. `name` and metadata fields all
    come from the YAML itself; this avoids a desync between "what the
    user typed in the editor" and "what the server thinks the playbook
    is called".
    """

    yaml_source: str = Field(min_length=1)


class PlaybookValidateRequest(BaseModel):
    """Body for `POST /api/playbooks/validate`.

    Same shape as create — the only difference is that validate does
    not persist, so the editor can surface errors before save.
    """

    yaml_source: str = Field(min_length=1)


class PlaybookRuleSummary(BaseModel):
    """Compact projection of a parsed rule for list views.

    The full rule body is available via `parsed_rules` on the detail
    response; this is what the in-app list page renders without
    pulling the whole rule object across the wire.
    """

    id: str
    title: str
    rule_type: str
    clause_type: str
    severity: str


class PlaybookSummaryResponse(BaseModel):
    """List-item projection of a Playbook row."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    jurisdiction: str | None
    contract_type: str | None
    version: str
    is_active: bool
    rule_count: int
    created_at: datetime
    updated_at: datetime


class PlaybookDetailResponse(PlaybookSummaryResponse):
    """Detail projection. Includes the validated rule list and YAML.

    Returning the YAML here lets the editor open an existing playbook
    without a second round-trip; the `parsed_rules` JSON is also
    returned so the UI can drive read-only views without re-parsing.
    """

    yaml_source: str
    parsed_rules: dict[str, Any]
    rules: list[PlaybookRuleSummary]


class PlaybookValidateResponse(BaseModel):
    """Successful response for `POST /api/playbooks/validate`."""

    ok: bool = True
    schema_version: str = PLAYBOOK_SCHEMA_VERSION
    name: str
    description: str | None
    jurisdiction: str | None
    contract_type: str | None
    version: str
    rule_count: int
    rules: list[PlaybookRuleSummary]


class PlaybookValidationIssue(BaseModel):
    """One validation failure surfaced from the loader."""

    message: str
    path: str | None = None


class PlaybookValidationErrorResponse(BaseModel):
    """Error body returned with HTTP 400 for invalid playbooks."""

    ok: bool = False
    errors: list[PlaybookValidationIssue]
