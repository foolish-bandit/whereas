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


# ---------------------------------------------------------------------------
# PR #67 — User-confirmed metadata correction
#
# After an upload or request-conversion lands, the UI lets the user
# review the suggested metadata and either keep the auto-derived
# values or override them. ``PATCH /api/contracts/{id}/metadata``
# accepts the override; the response carries the merged ``saved``
# state so the UI can drop its local form state.
#
# The endpoint persists ``title`` on the Contract row (the only
# Contract column that exists for these fields today) and the rest
# on the latest ``original_upload`` artifact's ``metadata_json``.
# That keeps PR #67 schema-migration-free while still preserving the
# values across reloads.
# ---------------------------------------------------------------------------


class ContractMetadataUpdateRequest(BaseModel):
    """Patch payload for user-confirmed contract metadata.

    All fields are optional — only the keys actually present in the
    request body are updated. An explicit empty string normalizes to
    ``null`` so users can clear a previously-set counterparty.
    Storage / encryption fields are not part of this surface and
    cannot be patched here.
    """

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=500)
    counterparty_name: str | None = Field(default=None, max_length=255)
    contract_type: str | None = Field(default=None, max_length=64)
    effective_date: date | None = None


class ContractMetadataResponse(BaseModel):
    """Compact merged-metadata view for the upload-review surface.

    ``title`` is read off ``Contract.title``; the rest are read off
    the latest ``original_upload`` artifact's ``metadata_json``. The
    response forbids extra attributes so additional server-side state
    cannot accidentally leak through this projection.
    """

    model_config = ConfigDict(extra="forbid")

    contract_id: uuid.UUID
    title: str
    counterparty_name: str | None = None
    contract_type: str | None = None
    effective_date: date | None = None
    updated_at: datetime
    changed_fields: list[str] = Field(default_factory=list)
