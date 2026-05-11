"""Request + response schemas for the artifact compare route (PR #71).

These mirror the dataclasses in ``app.services.artifact_compare`` and
are kept narrow: only safe metadata (artifact_id, artifact_type,
user-facing label, filename, created_at) crosses the wire. Storage
internals (``storage_key`` / ``wrapped_dek``) and raw extracted text
are never part of the response surface.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ArtifactCompareRequest(BaseModel):
    """Pick two ContractArtifact rows on the same contract to diff.

    Both ids must belong to the path-scoped contract; the route
    enforces org + contract scoping before any text is extracted.
    """

    model_config = ConfigDict(extra="forbid")

    base_artifact_id: uuid.UUID
    compare_artifact_id: uuid.UUID


class ArtifactCompareSideResponse(BaseModel):
    """Safe descriptor for one side of the compare.

    The frontend renders ``label`` directly — there is no need for
    the client to re-translate ``artifact_type``. ``filename`` and
    ``created_at`` give the user enough context to confirm the right
    versions were selected.
    """

    model_config = ConfigDict(from_attributes=True)

    artifact_id: uuid.UUID
    artifact_type: str
    label: str
    filename: str | None
    created_at: datetime


class CompareSummaryResponse(BaseModel):
    """Top-of-panel counts.

    Computed against the FULL diff (not just the truncated preview)
    so the counts are always accurate even when ``warnings`` reports
    ``diff_lines_truncated``.
    """

    added_lines: int = Field(ge=0)
    removed_lines: int = Field(ge=0)
    changed_blocks: int = Field(ge=0)
    unchanged_lines: int = Field(ge=0)


class DiffLineResponse(BaseModel):
    type: Literal["context", "added", "removed"]
    text: str


class DiffBlockResponse(BaseModel):
    type: Literal["context", "added", "removed", "changed"]
    # 1-based line numbers in the original/compare documents — matches
    # how editors display them.
    base_line_start: int = Field(ge=1)
    compare_line_start: int = Field(ge=1)
    lines: list[DiffLineResponse]


class ArtifactCompareResponse(BaseModel):
    """Wire format the Document History "Compare versions" panel renders.

    ``warnings`` is a flat list of opaque tags (e.g.
    ``base_text_truncated``, ``diff_lines_truncated``) so the frontend
    can show user-facing notices like "compared first 200,000
    characters only" without rendering raw service-layer text.
    """

    base: ArtifactCompareSideResponse
    compare: ArtifactCompareSideResponse
    summary: CompareSummaryResponse
    diff_blocks: list[DiffBlockResponse]
    warnings: list[str] = Field(default_factory=list)
