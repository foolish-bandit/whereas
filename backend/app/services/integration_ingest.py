"""Ingest files pulled in through a Nango integration.

A Nango sync (or a Nango webhook) hands us a record describing a file
that lives in Google Drive / OneDrive / SharePoint / a mailbox. This
module turns that record into a Whereas ``Contract`` (with the same
encryption, parsing, and clause segmentation guarantees as a direct
upload) and, when the connection is in ``inbox_review`` mode, an
``InboxItem`` for a human to confirm the file actually is a contract.

Idempotency is the load-bearing property here: the same provider file
id may arrive from a webhook AND a manual-sync sweep AND a re-delivery
after a transient error. ``IntegrationImportedFile`` rows are keyed
unique on ``(connection_id, provider_file_id)``; a second delivery
finds the row, sees ``contract_id`` is already set, and short-circuits.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import uuid
import zipfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from io import BytesIO

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.models import (
    Contract,
    ContractArtifact,
    ContractStatus,
    InboxItem,
    InboxItemStatus,
    IntegrationConnection,
    IntegrationConnectionStatus,
    IntegrationImportedFile,
    IntegrationIngestMode,
    Organization,
)
from app.security.audit_log import AuditEventType, record_event
from app.security.encryption import (
    EncryptionError,
    WrappedKey,
    load_instance_key,
    load_org_master_key,
)
from app.services.clause_segmentation import segment_and_persist_clauses
from app.services.document_markdown import create_markdown_snapshot_for_contract
from app.services.document_parser import parse_document
from app.services.extraction import ExtractionError, extract_and_persist_metadata
from app.services.nango_client import NangoError, NangoFile, download_file
from app.services.storage import DocumentStorage

log = logging.getLogger(__name__)

_PDF_MIME = "application/pdf"
_DOCX_MIME = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
_SUPPORTED_MIME_BY_EXTENSION = {
    ".pdf": _PDF_MIME,
    ".docx": _DOCX_MIME,
}
_DEFAULT_MAX_BYTES = 50 * 1024 * 1024
_SAFE_FILENAME_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


class IngestSkippedError(Exception):
    """The file is not eligible for ingest (unsupported type, too large, etc.).

    Raised so the caller (webhook handler, manual-sync loop) can record
    the skip on the ``IntegrationImportedFile`` row without aborting
    the whole batch.
    """


@dataclass(frozen=True)
class IngestResult:
    contract_id: uuid.UUID | None
    imported_file_id: uuid.UUID
    created: bool
    skipped_reason: str | None = None


# Callable signature for the file-bytes fetcher. Defaults to the Nango
# proxy download but tests inject an in-memory stub.
FileFetcher = Callable[[IntegrationConnection, NangoFile], Awaitable[bytes]]


async def _default_fetcher(
    connection: IntegrationConnection, file: NangoFile
) -> bytes:
    if not file.download_url:
        raise NangoError("File record has no download_url.")
    return await download_file(
        connection_id=connection.nango_connection_id,
        provider=connection.provider,
        download_url=file.download_url,
    )


async def ingest_file(
    session: AsyncSession,
    *,
    connection: IntegrationConnection,
    file: NangoFile,
    settings: Settings | None = None,
    fetcher: FileFetcher | None = None,
    now: datetime | None = None,
) -> IngestResult:
    """Ingest one file from a Nango sync.

    Idempotent on ``(connection.id, file.provider_file_id)``. Returns an
    :class:`IngestResult` indicating whether a new ``Contract`` was
    created, the file was skipped, or the same delivery had already
    produced a ``Contract`` on a prior call.

    The whole operation runs inside the caller's transaction; the
    caller (route handler) is responsible for the commit.
    """
    settings = settings or get_settings()
    fetcher = fetcher or _default_fetcher
    now = now or datetime.now(UTC)

    imported = await _get_or_create_imported_file_row(
        session, connection=connection, file=file, now=now
    )
    if imported.contract_id is not None:
        # We've ingested this file before. Refresh `last_seen_at` for
        # the audit trail but don't re-process.
        imported.last_seen_at = now
        return IngestResult(
            contract_id=imported.contract_id,
            imported_file_id=imported.id,
            created=False,
        )

    filename = _safe_filename(file.filename)
    try:
        mime_type = _validate_filename_and_mime(filename, file.mime_type)
    except IngestSkippedError as exc:
        imported.error_message = str(exc)
        imported.last_seen_at = now
        return IngestResult(
            contract_id=None,
            imported_file_id=imported.id,
            created=False,
            skipped_reason=str(exc),
        )

    try:
        file_bytes = await fetcher(connection, file)
    except NangoError as exc:
        imported.error_message = f"download_failed: {exc}"
        imported.last_seen_at = now
        log.warning(
            "Nango download failed for imported file",
            extra={
                "connection_id": str(connection.id),
                "provider_file_id": file.provider_file_id,
            },
        )
        raise

    max_bytes = settings.CONTRACT_UPLOAD_MAX_BYTES or _DEFAULT_MAX_BYTES
    try:
        _validate_file_bytes(
            filename=filename,
            mime_type=mime_type,
            file_bytes=file_bytes,
            max_bytes=max_bytes,
        )
    except IngestSkippedError as exc:
        imported.error_message = str(exc)
        imported.last_seen_at = now
        return IngestResult(
            contract_id=None,
            imported_file_id=imported.id,
            created=False,
            skipped_reason=str(exc),
        )

    org = await _load_organization(session, connection.organization_id)
    org_master_key = _load_org_master_key(org)

    file_hash = hashlib.sha256(file_bytes).hexdigest()
    parsed = parse_document(file_bytes, filename)

    contract = Contract(
        organization_id=connection.organization_id,
        uploaded_by=_uploaded_by(connection),
        title=filename,
        status=ContractStatus.UPLOADED.value,
        s3_key="pending",
        mime_type=mime_type,
        file_hash_sha256=file_hash,
        page_count=parsed.page_count,
        full_text=parsed.full_text,
    )
    session.add(contract)
    await session.flush()

    storage = DocumentStorage(settings)
    try:
        stored = await storage.store_encrypted(
            plaintext_bytes=file_bytes,
            document_id=str(contract.id),
            org_master_key=org_master_key,
        )
    finally:
        del org_master_key

    contract.s3_key = stored.s3_key
    contract.wrapped_dek = stored.wrapped_dek_bytes
    contract.status = ContractStatus.EXTRACTING.value
    await session.flush()

    session.add(
        ContractArtifact(
            organization_id=connection.organization_id,
            contract_id=contract.id,
            artifact_type="original_upload",
            storage_backend="s3",
            storage_key=stored.s3_key,
            filename=filename,
            mime_type=mime_type,
            file_hash_sha256=file_hash,
            size_bytes=len(file_bytes),
            source=f"integration:{connection.provider}",
            is_official=True,
            created_by=connection.created_by,
            metadata_json={
                "integration_connection_id": str(connection.id),
                "provider": connection.provider,
                "provider_file_id": file.provider_file_id,
            },
        )
    )

    # Extraction + segmentation + markdown are all best-effort. A
    # failure leaves the contract in FAILED / unsegmented state; an
    # operator can re-trigger them once the underlying issue is fixed.
    try:
        await extract_and_persist_metadata(
            session,
            contract=contract,
            actor_user_id=connection.created_by,
        )
        contract.status = ContractStatus.READY.value
    except ExtractionError:
        contract.status = ContractStatus.FAILED.value

    try:
        await segment_and_persist_clauses(session, contract)
    except Exception:
        log.exception(
            "Clause segmentation failed during integration ingest",
            extra={"contract_id": str(contract.id)},
        )

    try:
        await create_markdown_snapshot_for_contract(
            session,
            contract=contract,
            file_bytes=file_bytes,
            fallback_plain_text=parsed.full_text,
            actor_user_id=connection.created_by,
        )
    except Exception:
        log.exception(
            "Markdown snapshot failed during integration ingest",
            extra={"contract_id": str(contract.id)},
        )

    if connection.ingest_mode == IntegrationIngestMode.INBOX_REVIEW.value:
        session.add(
            InboxItem(
                organization_id=connection.organization_id,
                title=f"Review imported document: {filename}",
                description=(
                    f"Imported from {connection.provider}. Confirm this is "
                    "a contract and adjust metadata before it joins the "
                    "Repository."
                ),
                item_type="imported_document_review",
                status=InboxItemStatus.OPEN.value,
                contract_id=contract.id,
                created_by=connection.created_by,
                metadata_json={
                    "integration_connection_id": str(connection.id),
                    "provider": connection.provider,
                    "provider_file_id": file.provider_file_id,
                },
            )
        )

    imported.contract_id = contract.id
    imported.filename = filename
    imported.mime_type = mime_type
    imported.size_bytes = len(file_bytes)
    imported.provider_file_revision = file.revision
    imported.imported_at = now
    imported.last_seen_at = now
    imported.error_message = None

    connection.last_synced_at = now
    connection.last_sync_error = None
    connection.status = IntegrationConnectionStatus.ACTIVE.value

    await record_event(
        session,
        organization_id=connection.organization_id,
        event_type=AuditEventType.INTEGRATION_FILE_IMPORTED,
        actor_user_id=connection.created_by,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "provider": connection.provider,
            "connection_id": str(connection.id),
            "filename": filename,
            "mime_type": mime_type,
            "file_hash_sha256": file_hash,
            "size_bytes": len(file_bytes),
        },
    )

    return IngestResult(
        contract_id=contract.id,
        imported_file_id=imported.id,
        created=True,
    )


async def _get_or_create_imported_file_row(
    session: AsyncSession,
    *,
    connection: IntegrationConnection,
    file: NangoFile,
    now: datetime,
) -> IntegrationImportedFile:
    result = await session.execute(
        select(IntegrationImportedFile).where(
            IntegrationImportedFile.connection_id == connection.id,
            IntegrationImportedFile.provider_file_id == file.provider_file_id,
        )
    )
    row = result.scalar_one_or_none()
    if row is not None:
        return row
    row = IntegrationImportedFile(
        organization_id=connection.organization_id,
        connection_id=connection.id,
        provider=connection.provider,
        provider_file_id=file.provider_file_id,
        provider_file_revision=file.revision,
        filename=_safe_filename(file.filename),
        mime_type=file.mime_type,
        size_bytes=file.size_bytes,
        last_seen_at=now,
    )
    session.add(row)
    await session.flush()
    return row


def _validate_filename_and_mime(
    filename: str, mime_type: str | None
) -> str:
    ext = os.path.splitext(filename)[1].lower()
    expected = _SUPPORTED_MIME_BY_EXTENSION.get(ext)
    if expected is None:
        raise IngestSkippedError(
            f"unsupported_extension: {ext or '(none)'}"
        )
    # When Nango/the provider reports a mime, sanity-check it against
    # the extension. ``application/octet-stream`` is treated as "I don't
    # know" rather than a mismatch.
    if mime_type and mime_type not in {expected, "application/octet-stream"}:
        raise IngestSkippedError(f"mime_mismatch: {mime_type} vs {expected}")
    return expected


def _validate_file_bytes(
    *,
    filename: str,
    mime_type: str,
    file_bytes: bytes,
    max_bytes: int,
) -> None:
    if not file_bytes:
        raise IngestSkippedError("empty_file")
    if len(file_bytes) > max_bytes:
        raise IngestSkippedError("file_too_large")
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".pdf" and not file_bytes.startswith(b"%PDF-"):
        raise IngestSkippedError("not_a_pdf")
    if ext == ".docx" and not _looks_like_docx(file_bytes):
        raise IngestSkippedError("not_a_docx")


def _looks_like_docx(file_bytes: bytes) -> bool:
    try:
        with zipfile.ZipFile(BytesIO(file_bytes)) as archive:
            names = set(archive.namelist())
            total_uncompressed = sum(info.file_size for info in archive.infolist())
    except zipfile.BadZipFile:
        return False
    # Decompression-bomb guard: a small malicious zip can declare wildly
    # oversized member sizes. Reject before anything downstream extracts it.
    if total_uncompressed > get_settings().DOCX_MAX_UNCOMPRESSED_BYTES:
        return False
    return "[Content_Types].xml" in names and "word/document.xml" in names


def _safe_filename(filename: str | None) -> str:
    base = (filename or "imported_file").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    cleaned = _SAFE_FILENAME_CHARS.sub("_", base).strip("._") or "imported_file"
    return cleaned[:200]


async def _load_organization(
    session: AsyncSession, organization_id: uuid.UUID
) -> Organization:
    result = await session.execute(
        select(Organization).where(Organization.id == organization_id)
    )
    org = result.scalar_one_or_none()
    if org is None:
        raise IngestSkippedError("organization_not_found")
    return org


def _load_org_master_key(org: Organization) -> bytes:
    if org.wrapped_master_key is None:
        raise IngestSkippedError("org_keys_not_initialized")
    try:
        instance_key = load_instance_key()
    except EncryptionError as exc:
        raise IngestSkippedError("instance_key_unconfigured") from exc
    try:
        return load_org_master_key(
            wrapped_master_key=WrappedKey.from_bytes(org.wrapped_master_key),
            organization_id=str(org.id),
            instance_key=instance_key,
        )
    except (EncryptionError, ValueError) as exc:
        raise IngestSkippedError("org_keys_unloadable") from exc


def _uploaded_by(connection: IntegrationConnection) -> uuid.UUID:
    """Pick a user id to attribute the import to.

    Contracts have a NOT NULL ``uploaded_by`` FK. We attribute imported
    contracts to whoever set up the connection so the Document History
    view has a meaningful actor. If the connection has no
    ``created_by`` (older row), we fail closed — the operator must
    re-connect through the UI before files can flow in.
    """
    if connection.created_by is None:
        raise IngestSkippedError("connection_has_no_owner")
    return connection.created_by
