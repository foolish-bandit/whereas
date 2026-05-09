"""ContractArtifact resolution + backfill helpers.

ContractArtifact is the official record of file-like objects associated
with a contract. This module exposes both the read-side helpers used by
the request handlers (``get_latest_artifact_by_type`` /
``get_latest_official_original_artifact``) and the operator-run
backfill that creates ``original_upload`` rows for contracts uploaded
before the artifact model landed.

Reads only on the helper side — write paths stay inline in the upload
handler so the artifact insert participates in the same request-scoped
transaction as the Contract row. The backfill runs from
``backend/scripts`` and is intentionally not invoked from any Alembic
migration: the project's existing migrations are schema-only, and a
long-running data scan does not belong in the migration step.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Contract, ContractArtifact

LEGACY_BACKFILL_SOURCE = "legacy_backfill"
ORIGINAL_UPLOAD = "original_upload"
ARTIFACT_TYPE_ORIGINAL_UPLOAD = ORIGINAL_UPLOAD
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
    ``organization_id`` filter here is defense in depth so a stray call
    cannot leak across tenants.
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
    ``is_official=True``. Returning ``None`` is the expected legacy path
    for contracts uploaded before the artifact model landed and not yet
    backfilled, and for generated contracts (which have no
    ``original_upload`` — only a ``generated_docx`` artifact).
    """
    return await get_latest_artifact_by_type(
        session,
        contract_id=contract_id,
        organization_id=organization_id,
        artifact_type=ARTIFACT_TYPE_ORIGINAL_UPLOAD,
        official_only=True,
    )


# Resolution order for the contract download endpoint. ``original_upload``
# is preferred so contracts that have one (the v1 upload flow) keep their
# user-supplied filename and content type. ``generated_docx`` is the
# fallback for contracts created by template generation, which never
# have an ``original_upload`` row. Anything past these two is left for
# the caller to handle (legacy ``Contract.s3_key``).
DOWNLOADABLE_ARTIFACT_TYPES_BY_PRIORITY: tuple[str, ...] = (
    ARTIFACT_TYPE_ORIGINAL_UPLOAD,
    "generated_docx",
)

# Resolution order for sending a contract to DocuSeal for signature.
# ``generated_docx`` wins so a draft generated from a template is the
# version that goes out for signature; only contracts uploaded directly
# fall through to ``original_upload``. Legacy contracts without any
# artifact are handled by the caller via ``Contract.s3_key``.
SIGNABLE_ARTIFACT_TYPES_BY_PRIORITY: tuple[str, ...] = (
    "generated_docx",
    ARTIFACT_TYPE_ORIGINAL_UPLOAD,
)


async def get_latest_official_downloadable_artifact(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ContractArtifact | None:
    """Resolve the artifact the download endpoint should serve.

    Walks ``DOWNLOADABLE_ARTIFACT_TYPES_BY_PRIORITY`` in order. Returns
    the first match or ``None`` so the caller can fall back to the
    legacy ``Contract.s3_key``. Org scoped, official-only.
    """
    for artifact_type in DOWNLOADABLE_ARTIFACT_TYPES_BY_PRIORITY:
        artifact = await get_latest_artifact_by_type(
            session,
            contract_id=contract_id,
            organization_id=organization_id,
            artifact_type=artifact_type,
            official_only=True,
        )
        if artifact is not None:
            return artifact
    return None


async def get_latest_official_signable_artifact(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ContractArtifact | None:
    """Resolve the artifact to send to DocuSeal for signature.

    Walks ``SIGNABLE_ARTIFACT_TYPES_BY_PRIORITY`` in order so a generated
    draft (``generated_docx``) takes precedence over the original upload
    when both are present. Returns ``None`` so the caller can fall back
    to the legacy ``Contract.s3_key`` or surface a clear error. Org
    scoped, official-only.
    """
    for artifact_type in SIGNABLE_ARTIFACT_TYPES_BY_PRIORITY:
        artifact = await get_latest_artifact_by_type(
            session,
            contract_id=contract_id,
            organization_id=organization_id,
            artifact_type=artifact_type,
            official_only=True,
        )
        if artifact is not None:
            return artifact
    return None


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
