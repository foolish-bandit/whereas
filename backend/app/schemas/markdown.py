"""Response schemas for the contract markdown snapshot routes."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class ContractMarkdownSnapshotResponse(BaseModel):
    """Public projection of a persisted ``ContractMarkdownSnapshot``.

    Storage / encryption details (none on this row today) and the
    ``organization_id`` are not surfaced — the org is implicit in the
    contract scope of the calling endpoint.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    contract_id: uuid.UUID
    markdown_text: str
    source_kind: str
    converter_name: str
    converter_version: str | None = None
    conversion_status: str
    conversion_warnings: list[Any] | None = None
    created_at: datetime
