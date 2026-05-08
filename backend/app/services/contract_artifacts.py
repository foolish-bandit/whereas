"""ContractArtifact resolution helpers.

The artifact model (PR #34) lets Whereas track originals, signed PDFs,
generated DOCX, redlines, and exhibits as first-class rows. This module
is the seam the request handlers use to look those rows up without
hand-rolling the same query over and over.

Reads only — write paths stay inline in the upload handler so the
artifact insert participates in the same request-scoped transaction
as the Contract row.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ContractArtifact

ARTIFACT_TYPE_ORIGINAL_UPLOAD = "original_upload"


async def get_latest_artifact_by_type(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
    artifact_type: str,
    official_only: bool = False,
) -> ContractArtifact | None:
    """Return the most recent artifact of ``artifact_type`` for a contract.

    Org scoped — the caller is expected to have already validated that
    the contract belongs to the organization, but the extra ``organization_id``
    filter here is defense in depth so a stray call cannot leak across
    tenants.
    """
    stmt = select(ContractArtifact).where(
        ContractArtifact.contract_id == contract_id,
        ContractArtifact.organization_id == organization_id,
        ContractArtifact.artifact_type == artifact_type,
    )
    if official_only:
        stmt = stmt.where(ContractArtifact.is_official.is_(True))
    stmt = stmt.order_by(
        ContractArtifact.created_at.desc(), ContractArtifact.id.desc()
    ).limit(1)
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def get_latest_official_original_artifact(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ContractArtifact | None:
    """Convenience: latest ``original_upload`` artifact marked official.

    The original upload created by the upload handler always carries
    ``is_official=True``; future flows that import or re-upload an
    original should mirror that invariant. Returning ``None`` is the
    expected legacy path for contracts uploaded before PR #34 landed.
    """
    return await get_latest_artifact_by_type(
        session,
        contract_id=contract_id,
        organization_id=organization_id,
        artifact_type=ARTIFACT_TYPE_ORIGINAL_UPLOAD,
        official_only=True,
    )
