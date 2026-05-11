"""Schemas for the duplicate-merge endpoint (PR #76).

Request:
    POST /api/contracts/{target_contract_id}/merge-duplicate
    Body: ``DuplicateMergeRequest``

Response:
    200 ``DuplicateMergeResponse``

Privacy posture:

* Every model uses ``extra="forbid"`` so accidental server-side
  attributes cannot leak into the wire format.
* ``merge_note`` is accepted but its text is NOT echoed back, NOT
  persisted, and NOT recorded in the audit log — only the boolean
  "a note was present" survives. The default-no posture matches the
  rest of Whereas: operator prose only leaves the deployment when
  there is a UI to read it back safely.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class DuplicateMergeRequest(BaseModel):
    """Body of ``POST /api/contracts/{target_id}/merge-duplicate``."""

    model_config = ConfigDict(extra="forbid")

    source_contract_id: uuid.UUID
    merge_note: str | None = Field(default=None, max_length=2000)


class DuplicateMergeResponse(BaseModel):
    """Outcome of a successful merge.

    ``workflow_runs_attached_to_source`` and
    ``requests_attached_to_source`` are intentionally counts only.
    This PR does NOT rewire workflow / request links; surfacing the
    counts lets the UI render an honest "these stayed on the merged
    record" warning instead of overpromising.
    """

    model_config = ConfigDict(extra="forbid")

    target_contract_id: uuid.UUID
    source_contract_id: uuid.UUID
    artifacts_moved: int
    merged_at: datetime
    merged_by_user_id: uuid.UUID
    workflow_runs_attached_to_source: int = 0
    requests_attached_to_source: int = 0
