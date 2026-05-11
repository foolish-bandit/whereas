"""Response projections for upload-intake intelligence (PR #66).

Both ``/api/contracts/upload`` and ``/api/requests/{id}/convert-upload``
return a small block of *suggestions* alongside the persisted Contract:
deterministic, filename + body-text driven metadata extraction (no
LLM), plus a warning-level duplicate-candidate list scoped to the
caller's org.

Privacy posture:
- Both response models use ``extra='forbid'`` so additional server-side
  attributes can't accidentally leak into a response payload.
- Only allowlisted scalar identifier fields appear: never
  ``storage_key`` / ``wrapped_dek`` / raw bytes / raw text / signed
  URLs / encrypted blob hashes.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ExtractedContractMetadataResponse(BaseModel):
    """Deterministic best-effort metadata pulled off the upload.

    Every field is optional. The empty result + an explanatory
    ``warnings`` list is the "we don't know enough to suggest
    anything" state — extraction never blocks an upload.
    """

    model_config = ConfigDict(extra="forbid")

    suggested_title: str | None = None
    likely_contract_type: str | None = None
    possible_counterparty_name: str | None = None
    effective_date: date | None = None
    warnings: list[str] = Field(default_factory=list)


class DuplicateContractCandidateResponse(BaseModel):
    """One row in the warning-level duplicate list.

    ``reason`` and ``confidence`` are closed strings so the UI can map
    each row to specific copy without freeform parsing.

    PR #66 deliberately keeps this warning-only: duplicates are
    surfaced for visibility, never to hard-block an upload.
    """

    model_config = ConfigDict(extra="forbid")

    contract_id: uuid.UUID
    title: str
    reason: Literal[
        "exact_file_hash",
        "similar_title",
        "similar_title_and_counterparty",
    ]
    confidence: Literal["exact", "possible"]
    created_at: datetime
    status: str
