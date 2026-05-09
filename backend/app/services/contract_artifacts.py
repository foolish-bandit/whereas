"""ContractArtifact resolution and backfill utilities.

ContractArtifact is the official record of file-like objects associated
with a contract. Contracts created before that model existed only have
the legacy storage columns on ``Contract`` (``s3_key``, ``mime_type``,
``file_hash_sha256``). The download path falls back to those columns
when no ``original_upload`` artifact exists, but the artifact row is
the source of truth going forward.

This module provides a service function and the supporting result type
used by the operator-run backfill script in ``backend/scripts``. It is
intentionally not invoked from any Alembic migration: the project's
existing migrations are schema-only, and a long-running data scan does
not belong in the migration step. Operators run the script explicitly.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Contract, ContractArtifact

LEGACY_BACKFILL_SOURCE = "legacy_backfill"
ORIGINAL_UPLOAD = "original_upload"
DEFAULT_STORAGE_BACKEND = "s3"


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
    the contract belongs to the organization, but the extra
    ``organization_id`` filter here is defense in depth so a stray
    call cannot leak across tenants.
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

    The upload handler always writes the original with
    ``is_official=True``; the backfill path mirrors that. Returning
    ``None`` is the expected legacy path for contracts uploaded
    before the artifact model landed and not yet backfilled.
    """
    return await get_latest_artifact_by_type(
        session,
        contract_id=contract_id,
        organization_id=organization_id,
        artifact_type=ORIGINAL_UPLOAD,
        official_only=True,
    )


@dataclass
class BackfillResult:
    """Counters returned by :func:`backfill_original_upload_artifacts`.

    ``created`` reflects rows actually inserted. In dry-run mode it is
    always 0 and ``would_create`` carries the count instead, so callers
    can report either path uniformly.
    """

    scanned: int = 0
    created: int = 0
    would_create: int = 0
    skipped_existing: int = 0
    skipped_no_storage: int = 0


async def backfill_original_upload_artifacts(
    db: AsyncSession,
    *,
    organization_id: uuid.UUID | None = None,
    dry_run: bool = False,
) -> BackfillResult:
    """Create ``original_upload`` artifacts for legacy contracts.

    For each ``Contract`` that has a legacy ``s3_key`` but no
    ``original_upload`` ContractArtifact, insert one with
    ``source='legacy_backfill'`` and ``is_official=True``. Idempotent:
    re-running is a no-op once every legacy contract has an artifact.

    The function commits its own transaction on success so the script
    entry point doesn't need to know about session lifecycles. In
    ``dry_run`` mode no rows are inserted and the session is rolled
    back at the end.
    """
    result = BackfillResult()

    contract_q = select(Contract)
    if organization_id is not None:
        contract_q = contract_q.where(Contract.organization_id == organization_id)

    contracts = (await db.execute(contract_q)).scalars().all()
    result.scanned = len(contracts)

    for contract in contracts:
        if not contract.s3_key:
            result.skipped_no_storage += 1
            continue

        existing = (
            await db.execute(
                select(ContractArtifact.id).where(
                    ContractArtifact.contract_id == contract.id,
                    ContractArtifact.artifact_type == ORIGINAL_UPLOAD,
                )
            )
        ).first()
        if existing is not None:
            result.skipped_existing += 1
            continue

        if dry_run:
            result.would_create += 1
            continue

        artifact = ContractArtifact(
            organization_id=contract.organization_id,
            contract_id=contract.id,
            artifact_type=ORIGINAL_UPLOAD,
            storage_backend=DEFAULT_STORAGE_BACKEND,
            storage_key=contract.s3_key,
            filename=contract.title,
            mime_type=contract.mime_type,
            file_hash_sha256=contract.file_hash_sha256,
            size_bytes=None,
            source=LEGACY_BACKFILL_SOURCE,
            is_official=True,
            metadata_json={"backfilled_from": "contract_legacy_storage_fields"},
        )
        db.add(artifact)
        result.created += 1

    if dry_run:
        await db.rollback()
    else:
        await db.commit()

    return result
