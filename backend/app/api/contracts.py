"""Contract upload, listing, detail, and download routes."""
from __future__ import annotations

import hashlib
import logging
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
from app.models import (
    Clause,
    Contract,
    ContractArtifact,
    ContractMarkdownSnapshot,
    ContractStatus,
    DeviationFinding,
    ExtractedField,
    Organization,
    Playbook,
    PlaybookReviewRun,
    User,
)
from app.schemas.artifacts import ContractArtifactResponse
from app.schemas.contracts import (
    ClauseResponse,
    ContractDetailResponse,
    ContractListItemResponse,
    ContractUploadResponse,
    ExtractedFieldResponse,
)
from app.schemas.findings import (
    CreateReviewRunRequest,
    DeviationFindingResponse,
    ReviewRunDetail,
    ReviewRunSummary,
    UpdateFindingStatusRequest,
)
from app.schemas.markdown import ContractMarkdownSnapshotResponse
from app.schemas.playbook_review import (
    PlaybookReviewRequest,
    PlaybookReviewResult,
    review_to_response,
)
from app.security.audit_log import AuditEventType, record_event
from app.security.encryption import (
    EncryptionError,
    WrappedKey,
    load_instance_key,
    load_org_master_key,
)
from app.services.clause_segmentation import segment_and_persist_clauses
from app.services.contract_artifacts import (
    get_latest_official_original_artifact,
)
from app.services.deviation_findings import (
    InvalidFindingStatusError,
    get_finding_for_org,
    get_review_run_for_org,
    list_findings_for_contract,
    list_findings_for_run,
    list_review_runs_for_contract,
    run_and_persist_review,
    update_finding_status,
)
from app.services.document_markdown import create_markdown_snapshot_for_contract
from app.services.document_parser import (
    DocumentParseError,
    DocumentParseTimeoutError,
    DocumentTooLargeError,
    ParsedDocument,
    UnsupportedDocumentTypeError,
    parse_document,
)
from app.services.extraction import ExtractionError, extract_and_persist_metadata
from app.services.playbook_loader import (
    PlaybookValidationError,
    parse_playbook,
)
from app.services.playbook_matcher import match_playbook
from app.services.storage import DocumentStorage

log = logging.getLogger(__name__)

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

    # Record the original upload as a ContractArtifact. The Contract row
    # still owns the canonical storage pointer for back-compat with
    # existing download/extract paths; this row is the new artifact-model
    # foundation. The whole upload runs in a single request-scoped
    # transaction (see ``get_db``), so we deliberately do NOT swallow
    # failures here — a failure would mean the Contract row also rolls
    # back, leaving only an orphaned S3 blob, which is preferable to a
    # half-written contract row that is missing its official artifact.
    original_artifact = ContractArtifact(
        organization_id=user.organization_id,
        contract_id=contract.id,
        artifact_type="original_upload",
        storage_backend="s3",
        storage_key=stored.s3_key,
        filename=filename,
        mime_type=mime_type,
        file_hash_sha256=file_hash,
        size_bytes=len(file_bytes),
        source="user_upload",
        is_official=True,
        created_by=user.id,
    )
    session.add(original_artifact)
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

    # Clause segmentation runs after metadata extraction. It only depends
    # on contract.full_text, so it is independent of extraction success.
    # A failure here is non-fatal: storage and metadata are already
    # persisted, and re-running segmentation later (e.g. via a backfill
    # job) is cheap. We do not flip contract.status — there is no
    # workflow engine and segmentation status is not modeled in v1.
    clauses: list[Clause] = []
    try:
        clauses = await segment_and_persist_clauses(session, contract)
    except Exception:
        log.exception(
            "Clause segmentation failed; contract remains usable",
            extra={"contract_id": str(contract.id)},
        )

    # Markdown working snapshot. Non-fatal: if conversion fails or no
    # converter is installed, the upload still succeeds. The original
    # DOCX/PDF remains the legal artifact; this is a working copy used
    # for fast preview/search and future local-first sync.
    try:
        await create_markdown_snapshot_for_contract(
            session,
            contract=contract,
            file_bytes=file_bytes,
            fallback_plain_text=parsed.full_text,
            actor_user_id=user.id,
        )
    except Exception:
        log.exception(
            "Markdown snapshot creation failed; contract remains usable",
            extra={"contract_id": str(contract.id)},
        )

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
    await _refresh_upload_response_rows(session, contract, extracted_fields, clauses)

    return _upload_response(contract, extracted_fields, clauses, message=message)


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
        load_clauses=True,
    )
    return _detail_response(contract)


@router.get("/{contract_id}/clauses", response_model=list[ClauseResponse])
async def list_contract_clauses(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> list[ClauseResponse]:
    """Return the persisted clauses for a contract, ordered by ordinal.

    Same auth and org-scoping rules as the contract detail endpoint:
    a 404 is returned if the contract does not belong to the caller's
    organization. The detail endpoint already includes the clauses
    array; this route exists for clients that want clauses without
    re-fetching `full_text`.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
        load_clauses=True,
    )
    return [ClauseResponse.model_validate(c) for c in _ordered_clauses(contract)]


@router.get(
    "/{contract_id}/markdown",
    response_model=ContractMarkdownSnapshotResponse,
)
async def get_contract_markdown(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractMarkdownSnapshotResponse:
    """Return the latest markdown working snapshot for a contract.

    Org scoped: a 404 is returned for cross-org contracts and for
    contracts that do not have any persisted snapshot yet. The
    markdown snapshot is a lightweight working copy; the DOCX/PDF
    remains the original legal artifact.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    stmt = (
        select(ContractMarkdownSnapshot)
        .where(
            ContractMarkdownSnapshot.contract_id == contract_id,
            ContractMarkdownSnapshot.organization_id == user.organization_id,
            ContractMarkdownSnapshot.conversion_status == "ready",
        )
        .order_by(ContractMarkdownSnapshot.created_at.desc())
        .limit(1)
    )
    result = await session.execute(stmt)
    snapshot = result.scalar_one_or_none()
    if snapshot is None:
        raise HTTPException(
            status_code=404, detail="Markdown snapshot not found."
        )
    return ContractMarkdownSnapshotResponse.model_validate(snapshot)


@router.get(
    "/{contract_id}/artifacts",
    response_model=list[ContractArtifactResponse],
)
async def list_contract_artifacts(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> list[ContractArtifactResponse]:
    """List artifacts for a contract, newest first.

    Metadata only — this endpoint does not retrieve file contents and
    does not surface signed URLs. Use the existing download endpoint
    for the original artifact's bytes. Org scoped: a 404 is returned
    when the contract does not belong to the caller's organization.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    stmt = (
        select(ContractArtifact)
        .where(
            ContractArtifact.contract_id == contract_id,
            ContractArtifact.organization_id == user.organization_id,
        )
        .order_by(
            ContractArtifact.created_at.desc(), ContractArtifact.id.desc()
        )
    )
    result = await session.execute(stmt)
    return [
        ContractArtifactResponse.model_validate(row)
        for row in result.scalars()
    ]


@router.post(
    "/{contract_id}/playbook-review",
    response_model=PlaybookReviewResult,
)
async def review_contract_with_playbook(
    contract_id: uuid.UUID,
    payload: PlaybookReviewRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> PlaybookReviewResult:
    """Run a deterministic playbook review against a contract's clauses.

    PR #21 scope: pure rule matching only. The endpoint never persists
    findings, never mutates the contract, the clauses, or the
    playbook, and never calls an LLM. Results are transient — every
    call computes them from scratch against the current segmented
    clauses.

    Behavior:
      - 404 if the contract does not belong to the caller's org.
      - 404 if the playbook does not belong to the caller's org or is
        inactive (consistent with the playbooks router; do not leak
        existence).
      - 409 if the contract has no segmented clauses yet (the rule
        matcher would only ever return all-fail in that case, which
        makes for a confusing result; surface it as a precondition).
      - 200 with a `PlaybookReviewResult` otherwise.

    Whereas surfaces information about contracts; it does not provide
    legal advice. Reviewers must treat results as a triage signal.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
        load_clauses=True,
    )
    playbook = await _get_active_playbook_for_org(
        session,
        playbook_id=payload.playbook_id,
        organization_id=user.organization_id,
    )
    clauses = _ordered_clauses(contract)
    if not clauses:
        raise HTTPException(
            status_code=409,
            detail=(
                "Contract has no segmented clauses to review yet. Wait for "
                "segmentation to complete or re-upload the document."
            ),
        )

    try:
        parsed = parse_playbook(playbook.yaml_source)
    except PlaybookValidationError as exc:
        # A persisted playbook that fails revalidation is a corrupted
        # row — should not happen because creation goes through the same
        # validator, but surface a clean 500 rather than a partial result.
        log.exception(
            "Stored playbook failed revalidation during review",
            extra={"playbook_id": str(playbook.id)},
        )
        raise HTTPException(
            status_code=500,
            detail=(
                "Playbook could not be parsed for review. The stored YAML "
                "is invalid; deactivate and recreate the playbook."
            ),
        ) from exc

    review = match_playbook(parsed, clauses)
    return review_to_response(
        playbook_id=playbook.id,
        playbook_name=playbook.name,
        contract_id=contract.id,
        review=review,
    )


# --------------------------------------------------------------------------
# Persisted playbook review (runs + findings)
#
# The transient endpoint above stays in place for callers that want a
# read-only review without writing rows. The endpoints below persist the
# matcher's failed outcomes into `playbook_review_runs` and
# `deviation_findings` so reviewers can revisit, mark, and triage them.
# --------------------------------------------------------------------------


@router.post(
    "/{contract_id}/playbook-review/runs",
    response_model=ReviewRunDetail,
    status_code=201,
)
async def create_playbook_review_run(
    contract_id: uuid.UUID,
    payload: CreateReviewRunRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ReviewRunDetail:
    """Run a deterministic review and persist its results.

    Behavior:
      - 404 if the contract or playbook is cross-org or the playbook
        is inactive (mirrors the transient endpoint; do not leak
        existence).
      - 409 if the contract has no segmented clauses yet (consistent
        with the transient endpoint).
      - 201 with a ``ReviewRunDetail`` otherwise. The detail carries
        both the persisted failed findings and the matcher's full
        per-rule outcomes so the UI can render passes too.

    Side effects:
      - Inserts one ``PlaybookReviewRun`` row.
      - Inserts one ``DeviationFinding`` row per failed rule outcome.
        Pass results are not persisted.
      - Marks any prior ``finding_status='open'`` findings on this
        ``(contract, playbook)`` as ``'superseded'``. ``reviewed`` and
        ``ignored`` findings are left untouched.

    Whereas surfaces information about contracts; it does not provide
    legal advice.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
        load_clauses=True,
    )
    playbook = await _get_active_playbook_for_org(
        session,
        playbook_id=payload.playbook_id,
        organization_id=user.organization_id,
    )
    clauses = _ordered_clauses(contract)
    if not clauses:
        raise HTTPException(
            status_code=409,
            detail=(
                "Contract has no segmented clauses to review yet. Wait for "
                "segmentation to complete or re-upload the document."
            ),
        )

    try:
        parsed = parse_playbook(playbook.yaml_source)
    except PlaybookValidationError as exc:
        log.exception(
            "Stored playbook failed revalidation during persisted review",
            extra={"playbook_id": str(playbook.id)},
        )
        raise HTTPException(
            status_code=500,
            detail=(
                "Playbook could not be parsed for review. The stored YAML "
                "is invalid; deactivate and recreate the playbook."
            ),
        ) from exc

    run, findings, review = await run_and_persist_review(
        session,
        contract=contract,
        playbook=playbook,
        parsed_playbook=parsed,
        clauses=clauses,
    )
    return _run_detail_response(
        run=run,
        playbook_name=playbook.name,
        contract_id=contract.id,
        findings=findings,
        review=review,
    )


@router.get(
    "/{contract_id}/playbook-review/runs",
    response_model=list[ReviewRunSummary],
)
async def list_playbook_review_runs(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> list[ReviewRunSummary]:
    """List review runs for a contract, newest first. Org scoped."""
    user = await _current_dev_user(session, x_whereas_dev_user)
    await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    runs = await list_review_runs_for_contract(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    if not runs:
        return []
    playbook_names = await _playbook_names_by_id(
        session,
        organization_id=user.organization_id,
        playbook_ids={run.playbook_id for run in runs},
    )
    return [
        _run_summary_response(
            run=run,
            playbook_name=playbook_names.get(run.playbook_id, "(unknown playbook)"),
        )
        for run in runs
    ]


@router.get(
    "/{contract_id}/playbook-review/runs/{run_id}",
    response_model=ReviewRunDetail,
)
async def get_playbook_review_run(
    contract_id: uuid.UUID,
    run_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ReviewRunDetail:
    """Return a single review run with its findings and per-rule outcomes.

    Org scoped: a 404 is returned for cross-org runs and for runs whose
    contract is not in the caller's org.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
        load_clauses=True,
    )
    run = await get_review_run_for_org(
        session,
        run_id=run_id,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Review run not found.")

    playbook = await _get_playbook_for_org_any_status(
        session,
        playbook_id=run.playbook_id,
        organization_id=user.organization_id,
    )
    findings = await list_findings_for_run(session, run_id=run.id)

    # Recompute the matcher's per-rule outcomes so the UI can render
    # passes alongside the persisted fails. The matcher is deterministic
    # and reads only `contract.clauses`; the contract's clause set may
    # have changed since the run was written, in which case the
    # recomputed results may differ from the persisted findings. That's
    # the intended trade-off: the run row remains the audit signal of
    # "we ran this on date X with these counts"; the per-rule view
    # reflects the contract as it stands now.
    review = None
    try:
        parsed = parse_playbook(playbook.yaml_source)
        review = match_playbook(parsed, _ordered_clauses(contract))
    except PlaybookValidationError:
        log.warning(
            "Stored playbook failed revalidation; serving run without per-rule view",
            extra={"playbook_id": str(playbook.id)},
        )

    return _run_detail_response(
        run=run,
        playbook_name=playbook.name,
        contract_id=contract.id,
        findings=findings,
        review=review,
    )


@router.get(
    "/{contract_id}/findings",
    response_model=list[DeviationFindingResponse],
)
async def list_contract_findings(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    playbook_id: uuid.UUID | None = None,
    finding_status: str | None = None,
    severity: str | None = None,
    review_run_id: uuid.UUID | None = None,
    include_superseded: bool = False,
) -> list[DeviationFindingResponse]:
    """List findings for a contract with optional filters.

    By default ``superseded`` rows are omitted so the UI's default
    "what's open" view doesn't have to know about the rerun sweep.
    Pass ``?include_superseded=true`` (or filter explicitly with
    ``?finding_status=superseded``) to surface them.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    findings = await list_findings_for_contract(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
        playbook_id=playbook_id,
        finding_status=finding_status,
        severity=severity,
        review_run_id=review_run_id,
        include_superseded=include_superseded,
    )
    return [_finding_response(f) for f in findings]


@router.patch(
    "/{contract_id}/findings/{finding_id}",
    response_model=DeviationFindingResponse,
)
async def update_contract_finding_status(
    contract_id: uuid.UUID,
    finding_id: uuid.UUID,
    payload: UpdateFindingStatusRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> DeviationFindingResponse:
    """Update the reviewer workflow state of a finding.

    Only ``finding_status`` is updatable. Deterministic fields
    (``status``, ``message``, span, ``rule_*``) are immutable through
    this endpoint. Org scoped: a 404 is returned for cross-org or
    cross-contract findings.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    finding = await get_finding_for_org(
        session,
        finding_id=finding_id,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    if finding is None:
        raise HTTPException(status_code=404, detail="Finding not found.")
    try:
        await update_finding_status(
            session, finding=finding, new_status=payload.finding_status
        )
    except InvalidFindingStatusError as exc:
        # Pydantic validates the literal at the boundary; this is a
        # belt-and-braces 422 in case service-layer rules diverge.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _finding_response(finding)


@router.get("/{contract_id}/download")
async def download_contract(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> Response:
    """Download the original legal artifact for a contract.

    Resolution order:
      1. Latest official ``original_upload`` ContractArtifact, if any
         (the v1 upload flow writes one of these per upload).
      2. Legacy ``Contract.s3_key`` / ``Contract.mime_type``, for
         contracts uploaded before the artifact model landed and not
         yet backfilled.

    The wrapped DEK still lives on the Contract row in v1 — artifacts
    don't carry their own wrapping yet, so the encryption seam is
    unchanged. ``storage_key`` is read off the resolved source and
    never echoed back to the client.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    if contract.wrapped_dek is None:
        raise HTTPException(status_code=409, detail="Contract encryption metadata is missing.")

    artifact = await get_latest_official_original_artifact(
        session,
        contract_id=contract.id,
        organization_id=user.organization_id,
    )
    storage_key = (
        artifact.storage_key
        if artifact is not None and artifact.storage_key
        else contract.s3_key
    )
    mime_type = (
        artifact.mime_type
        if artifact is not None and artifact.mime_type
        else contract.mime_type
    )

    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)
    storage = DocumentStorage(get_settings())
    try:
        plaintext = await storage.retrieve_decrypted(
            s3_key=storage_key,
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
        details=_audit_contract_details(
            contract,
            filename=artifact.filename if artifact is not None else None,
            artifact_id=artifact.id if artifact is not None else None,
        ),
    )

    return Response(
        content=plaintext,
        media_type=mime_type,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{_download_filename(contract, artifact=artifact)}"'
            ),
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
    load_clauses: bool = False,
) -> Contract:
    stmt = select(Contract).where(
        Contract.id == contract_id,
        Contract.organization_id == organization_id,
    )
    if load_fields:
        stmt = stmt.options(selectinload(Contract.extracted_fields))
    if load_clauses:
        stmt = stmt.options(selectinload(Contract.clauses))
    result = await session.execute(stmt)
    contract = result.scalar_one_or_none()
    if contract is None:
        raise HTTPException(status_code=404, detail="Contract not found.")
    return contract


def _ordered_clauses(contract: Contract) -> list[Clause]:
    """Stable ordering for clause responses: by ordinal ascending."""
    return sorted(contract.clauses, key=lambda c: c.ordinal)


async def _get_active_playbook_for_org(
    session: AsyncSession,
    *,
    playbook_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> Playbook:
    """Fetch a playbook scoped to an org, requiring it be active.

    Returns 404 — not 403 — both for cross-org access and for
    deactivated playbooks. Mirrors the playbooks router so callers
    can't distinguish "playbook does not exist" from "playbook exists
    but you cannot see it".
    """
    stmt = select(Playbook).where(
        Playbook.id == playbook_id,
        Playbook.organization_id == organization_id,
    )
    result = await session.execute(stmt)
    playbook = result.scalar_one_or_none()
    if playbook is None or not playbook.is_active:
        raise HTTPException(status_code=404, detail="Playbook not found.")
    return playbook


def _derive_title(title: str | None, filename: str) -> str:
    clean = title.strip() if title else ""
    if clean:
        return clean[:500]
    stem = os.path.splitext(os.path.basename(filename))[0].strip()
    return (stem or "Untitled contract")[:500]


def _safe_input_filename(filename: str | None) -> str:
    basename = os.path.basename((filename or "").replace("\\", "/")).strip()
    return basename or "contract"


def _download_filename(
    contract: Contract,
    *,
    artifact: ContractArtifact | None = None,
) -> str:
    """Pick a safe download filename, preferring the artifact's filename.

    The artifact records the user's original filename at upload time,
    which is the most useful name for an export. Falls back to the
    contract title when the artifact has no filename or when no
    artifact row exists (legacy contracts).
    """
    mime_type = (
        artifact.mime_type if artifact is not None and artifact.mime_type
        else contract.mime_type
    )
    ext = ".pdf" if mime_type == _PDF_MIME else ".docx"
    raw_base = (
        artifact.filename if artifact is not None and artifact.filename
        else contract.title
    )
    base = _SAFE_FILENAME_CHARS.sub("_", raw_base).strip("._") or "contract"
    if not base.lower().endswith(ext):
        base = f"{base}{ext}"
    return base[:180]


def _audit_contract_details(
    contract: Contract,
    *,
    filename: str | None,
    artifact_id: uuid.UUID | None = None,
) -> dict[str, object]:
    details: dict[str, object] = {
        "contract_id": str(contract.id),
        "title": contract.title,
        "mime_type": contract.mime_type,
        "file_hash_sha256": contract.file_hash_sha256,
        "page_count": contract.page_count,
    }
    if filename is not None:
        details["filename"] = filename
    if artifact_id is not None:
        details["artifact_id"] = str(artifact_id)
    return details


async def _refresh_upload_response_rows(
    session: AsyncSession,
    contract: Contract,
    extracted_fields: Sequence[ExtractedField],
    clauses: Sequence[Clause],
) -> None:
    await session.refresh(contract)
    for field in extracted_fields:
        await session.refresh(field)
    for clause in clauses:
        await session.refresh(clause)


def _upload_response(
    contract: Contract,
    extracted_fields: Sequence[ExtractedField],
    clauses: Sequence[Clause],
    *,
    message: str | None,
) -> ContractUploadResponse:
    data = ContractListItemResponse.model_validate(contract).model_dump()
    data["extracted_fields"] = [
        ExtractedFieldResponse.model_validate(field) for field in extracted_fields
    ]
    data["clauses"] = [
        ClauseResponse.model_validate(clause)
        for clause in sorted(clauses, key=lambda c: c.ordinal)
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
    data["clauses"] = [
        ClauseResponse.model_validate(clause) for clause in _ordered_clauses(contract)
    ]
    return ContractDetailResponse.model_validate(data)


# --------------------------------------------------------------------------
# Persisted-review helpers
# --------------------------------------------------------------------------


async def _get_playbook_for_org_any_status(
    session: AsyncSession,
    *,
    playbook_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> Playbook:
    """Fetch a playbook scoped to an org, regardless of ``is_active``.

    The active-only variant 404s on deactivated playbooks so callers
    can't run new reviews against them. Run-detail / list responses
    must still resolve the playbook name even after deactivation, so
    this helper allows inactive rows. A 404 is still returned for
    cross-org access.
    """
    stmt = select(Playbook).where(
        Playbook.id == playbook_id,
        Playbook.organization_id == organization_id,
    )
    result = await session.execute(stmt)
    playbook = result.scalar_one_or_none()
    if playbook is None:
        raise HTTPException(status_code=404, detail="Playbook not found.")
    return playbook


async def _playbook_names_by_id(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
    playbook_ids: set[uuid.UUID],
) -> dict[uuid.UUID, str]:
    """Bulk-load playbook names for a set of ids, scoped to one org."""
    if not playbook_ids:
        return {}
    stmt = select(Playbook.id, Playbook.name).where(
        Playbook.organization_id == organization_id,
        Playbook.id.in_(playbook_ids),
    )
    result = await session.execute(stmt)
    return {row.id: row.name for row in result}


def _run_summary_response(
    *, run: PlaybookReviewRun, playbook_name: str
) -> ReviewRunSummary:
    return ReviewRunSummary(
        id=run.id,
        organization_id=run.organization_id,
        contract_id=run.contract_id,
        playbook_id=run.playbook_id,
        playbook_name=playbook_name,
        rules_checked=run.rules_checked,
        passed_count=run.passed_count,
        failed_count=run.failed_count,
        created_at=run.created_at,
    )


def _run_detail_response(
    *,
    run: PlaybookReviewRun,
    playbook_name: str,
    contract_id: uuid.UUID,
    findings: Sequence[DeviationFinding],
    review,
) -> ReviewRunDetail:
    summary = _run_summary_response(run=run, playbook_name=playbook_name)
    summary_data = summary.model_dump()
    finding_responses = [_finding_response(f) for f in findings]
    if review is None:
        results: list = []
    else:
        # Reuse the transient endpoint's response builder so the
        # per-rule shape is identical between the two surfaces.
        results = review_to_response(
            playbook_id=run.playbook_id,
            playbook_name=playbook_name,
            contract_id=contract_id,
            review=review,
        ).results
    return ReviewRunDetail(
        **summary_data, findings=finding_responses, results=results
    )


def _finding_response(finding: DeviationFinding) -> DeviationFindingResponse:
    return DeviationFindingResponse(
        id=finding.id,
        organization_id=finding.organization_id,
        contract_id=finding.contract_id,
        playbook_id=finding.playbook_id,
        review_run_id=finding.review_run_id,
        rule_id=finding.rule_id,
        rule_title=finding.rule_title,
        rule_type=finding.rule_type,
        clause_type=finding.clause_type,
        severity=finding.severity,
        status=finding.status,  # type: ignore[arg-type]
        finding_status=finding.finding_status,  # type: ignore[arg-type]
        message=finding.message,
        clause_id=finding.clause_id,
        evidence_text=finding.evidence_text,
        span_start=finding.span_start,
        span_end=finding.span_end,
        matched_terms=list(finding.matched_terms or ()),
        expected_value=finding.expected_value,
        guidance=finding.guidance,
        preferred_language=finding.preferred_language,
        created_at=finding.created_at,
        updated_at=finding.updated_at,
    )
