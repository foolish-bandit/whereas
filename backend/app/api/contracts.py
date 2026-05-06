"""Contract upload, listing, detail, and download routes."""
from __future__ import annotations

import hashlib
import os
import re
import uuid
import zipfile
from collections.abc import Sequence
from io import BytesIO
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import get_settings
from app.core.database import get_db
from app.models import Contract, ContractStatus, ExtractedField, Organization, User
from app.schemas.contracts import (
    ContractDetailResponse,
    ContractListItemResponse,
    ContractUploadResponse,
    ExtractedFieldResponse,
)
from app.security.audit_log import AuditEventType, record_event
from app.security.encryption import (
    EncryptionError,
    WrappedKey,
    load_instance_key,
    load_org_master_key,
)
from app.services.document_parser import (
    DocumentParseError,
    DocumentParseTimeoutError,
    DocumentTooLargeError,
    ParsedDocument,
    UnsupportedDocumentTypeError,
    parse_document,
)
from app.services.extraction import ExtractionError, extract_and_persist_metadata
from app.services.storage import DocumentStorage

router = APIRouter()
DbSession = Annotated[AsyncSession, Depends(get_db)]

_PDF_MIME = "application/pdf"
_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_SUPPORTED_MIME_BY_EXTENSION = {
    ".pdf": _PDF_MIME,
    ".docx": _DOCX_MIME,
}
_SAFE_FILENAME_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


@router.post("/upload", response_model=ContractUploadResponse, status_code=201)
async def upload_contract(
    file: Annotated[UploadFile, File()],
    session: DbSession,
    title: Annotated[str | None, Form()] = None,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractUploadResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    settings = get_settings()
    filename = _safe_input_filename(file.filename)
    file_bytes = await file.read()
    mime_type = _validate_upload(
        filename=filename,
        content_type=file.content_type,
        file_bytes=file_bytes,
        max_bytes=settings.CONTRACT_UPLOAD_MAX_BYTES,
    )
    file_hash = hashlib.sha256(file_bytes).hexdigest()

    duplicate = await _find_duplicate(session, user.organization_id, file_hash)
    if duplicate is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "This organization has already uploaded this file.",
                "existing_contract_id": str(duplicate.id),
            },
        )

    parsed = _parse_or_http(file_bytes=file_bytes, filename=filename)
    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)

    contract = Contract(
        organization_id=user.organization_id,
        uploaded_by=user.id,
        title=_derive_title(title, filename),
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
    except Exception as e:
        raise HTTPException(status_code=500, detail="Could not store encrypted document.") from e
    finally:
        del org_master_key

    contract.s3_key = stored.s3_key
    contract.wrapped_dek = stored.wrapped_dek_bytes
    contract.status = ContractStatus.EXTRACTING.value
    await session.flush()

    message: str | None = None
    try:
        extracted_fields = await extract_and_persist_metadata(
            session,
            contract=contract,
            actor_user_id=user.id,
        )
        contract.status = ContractStatus.READY.value
    except ExtractionError:
        # There is no READY_WITH_EXTRACTION_FAILURE status yet. Storage has
        # succeeded, so keep the contract and mark it failed instead of
        # rolling back the uploaded document.
        extracted_fields = []
        contract.status = ContractStatus.FAILED.value
        message = "metadata_extraction_failed"

    await session.flush()
    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.CONTRACT_UPLOADED,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(contract.id),
        details=_audit_contract_details(contract, filename=filename),
    )

    return _upload_response(contract, extracted_fields, message=message)


@router.get("", response_model=list[ContractListItemResponse])
async def list_contracts(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> list[ContractListItemResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    result = await session.execute(
        select(Contract)
        .where(Contract.organization_id == user.organization_id)
        .order_by(Contract.created_at.desc(), Contract.id.desc())
    )
    return [ContractListItemResponse.model_validate(row) for row in result.scalars()]


@router.get("/{contract_id}", response_model=ContractDetailResponse)
async def get_contract(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractDetailResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
        load_fields=True,
    )
    return _detail_response(contract)


@router.get("/{contract_id}/download")
async def download_contract(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> Response:
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    if contract.wrapped_dek is None:
        raise HTTPException(status_code=409, detail="Contract encryption metadata is missing.")

    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)
    storage = DocumentStorage(get_settings())
    try:
        plaintext = await storage.retrieve_decrypted(
            s3_key=contract.s3_key,
            document_id=str(contract.id),
            wrapped_dek_bytes=contract.wrapped_dek,
            org_master_key=org_master_key,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail="Could not retrieve encrypted document.") from e
    finally:
        del org_master_key

    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.CONTRACT_DOWNLOADED,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(contract.id),
        details=_audit_contract_details(contract, filename=None),
    )

    return Response(
        content=plaintext,
        media_type=contract.mime_type,
        headers={
            "Content-Disposition": f'attachment; filename="{_download_filename(contract)}"',
        },
    )


async def _current_dev_user(
    session: AsyncSession,
    header_value: str | None,
) -> User:
    if not header_value:
        raise HTTPException(status_code=401, detail="Missing X-Whereas-Dev-User header.")
    try:
        user_id = uuid.UUID(header_value)
    except ValueError as e:
        raise HTTPException(status_code=401, detail="Invalid X-Whereas-Dev-User header.") from e

    result = await session.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail="User not found.")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="User is inactive.")
    if user.organization_id is None:
        raise HTTPException(status_code=403, detail="User has no organization.")
    return user


async def _load_organization(session: AsyncSession, organization_id: uuid.UUID) -> Organization:
    result = await session.execute(
        select(Organization).where(Organization.id == organization_id)
    )
    org = result.scalar_one_or_none()
    if org is None:
        raise HTTPException(status_code=403, detail="Organization not found.")
    return org


def _load_org_key_or_http(org: Organization) -> bytes:
    if org.wrapped_master_key is None:
        raise HTTPException(status_code=409, detail="Organization keys are not initialized.")
    try:
        instance_key = load_instance_key()
    except EncryptionError as e:
        raise HTTPException(status_code=500, detail="Encryption instance key is not configured.") from e
    try:
        return load_org_master_key(
            wrapped_master_key=WrappedKey.from_bytes(org.wrapped_master_key),
            organization_id=str(org.id),
            instance_key=instance_key,
        )
    except (EncryptionError, ValueError) as e:
        raise HTTPException(status_code=409, detail="Organization keys are not initialized.") from e


def _validate_upload(
    *,
    filename: str,
    content_type: str | None,
    file_bytes: bytes,
    max_bytes: int,
) -> str:
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(file_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail="Uploaded file exceeds the size limit.")

    ext = os.path.splitext(filename)[1].lower()
    expected_mime = _SUPPORTED_MIME_BY_EXTENSION.get(ext)
    if expected_mime is None:
        raise HTTPException(status_code=400, detail="Unsupported file extension.")

    if ext == ".pdf" and not file_bytes.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="File content is not a valid PDF.")
    if ext == ".docx" and not _looks_like_docx(file_bytes):
        raise HTTPException(status_code=400, detail="File content is not a valid DOCX.")

    if content_type and content_type not in {expected_mime, "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="File MIME type does not match extension.")
    return expected_mime


def _looks_like_docx(file_bytes: bytes) -> bool:
    try:
        with zipfile.ZipFile(BytesIO(file_bytes)) as archive:
            names = set(archive.namelist())
    except zipfile.BadZipFile:
        return False
    return "[Content_Types].xml" in names and "word/document.xml" in names


def _parse_or_http(*, file_bytes: bytes, filename: str) -> ParsedDocument:
    try:
        return parse_document(file_bytes, filename)
    except UnsupportedDocumentTypeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except DocumentTooLargeError as e:
        raise HTTPException(status_code=413, detail=str(e)) from e
    except DocumentParseTimeoutError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except DocumentParseError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


async def _find_duplicate(
    session: AsyncSession,
    organization_id: uuid.UUID,
    file_hash: str,
) -> Contract | None:
    result = await session.execute(
        select(Contract)
        .where(
            Contract.organization_id == organization_id,
            Contract.file_hash_sha256 == file_hash,
        )
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _get_contract_for_org(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
    load_fields: bool = False,
) -> Contract:
    stmt = select(Contract).where(
        Contract.id == contract_id,
        Contract.organization_id == organization_id,
    )
    if load_fields:
        stmt = stmt.options(selectinload(Contract.extracted_fields))
    result = await session.execute(stmt)
    contract = result.scalar_one_or_none()
    if contract is None:
        raise HTTPException(status_code=404, detail="Contract not found.")
    return contract


def _derive_title(title: str | None, filename: str) -> str:
    clean = title.strip() if title else ""
    if clean:
        return clean[:500]
    stem = os.path.splitext(os.path.basename(filename))[0].strip()
    return (stem or "Untitled contract")[:500]


def _safe_input_filename(filename: str | None) -> str:
    basename = os.path.basename((filename or "").replace("\\", "/")).strip()
    return basename or "contract"


def _download_filename(contract: Contract) -> str:
    ext = ".pdf" if contract.mime_type == _PDF_MIME else ".docx"
    base = _SAFE_FILENAME_CHARS.sub("_", contract.title).strip("._") or "contract"
    if not base.lower().endswith(ext):
        base = f"{base}{ext}"
    return base[:180]


def _audit_contract_details(contract: Contract, *, filename: str | None) -> dict[str, object]:
    details: dict[str, object] = {
        "contract_id": str(contract.id),
        "title": contract.title,
        "mime_type": contract.mime_type,
        "file_hash_sha256": contract.file_hash_sha256,
        "page_count": contract.page_count,
    }
    if filename is not None:
        details["filename"] = filename
    return details


def _upload_response(
    contract: Contract,
    extracted_fields: Sequence[ExtractedField],
    *,
    message: str | None,
) -> ContractUploadResponse:
    data = ContractListItemResponse.model_validate(contract).model_dump()
    data["extracted_fields"] = [
        ExtractedFieldResponse.model_validate(field) for field in extracted_fields
    ]
    data["message"] = message
    return ContractUploadResponse.model_validate(data)


def _detail_response(contract: Contract) -> ContractDetailResponse:
    data = ContractListItemResponse.model_validate(contract).model_dump()
    data["full_text"] = contract.full_text
    data["extracted_fields"] = [
        ExtractedFieldResponse.model_validate(field)
        for field in contract.extracted_fields
    ]
    return ContractDetailResponse.model_validate(data)
