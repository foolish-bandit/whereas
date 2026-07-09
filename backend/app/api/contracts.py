"""Contract upload, listing, detail, and download routes."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import uuid
import zipfile
from collections.abc import Sequence
from datetime import date
from io import BytesIO
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import JSONResponse, Response
from sqlalchemy import or_, select
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
from app.schemas.activity import ActivityTimelineResponse
from app.schemas.artifacts import ContractArtifactResponse
from app.schemas.compare import (
    ArtifactCompareRequest,
    ArtifactCompareResponse,
    ArtifactCompareSideResponse,
    CompareSummaryResponse,
    DiffBlockResponse,
    DiffLineResponse,
)
from app.schemas.contract_intake import (
    ContractMetadataResponse,
    ContractMetadataUpdateRequest,
)
from app.schemas.contracts import (
    ClauseResponse,
    ContractDetailResponse,
    ContractListItemResponse,
    ContractUploadResponse,
    ExtractedFieldResponse,
)
from app.schemas.docuseal import (
    ContractApprovalGateResponse,
    SendContractToDocuSealRequest,
    SendContractToDocuSealResponse,
)
from app.schemas.duplicate_merge import (
    DuplicateMergeRequest,
    DuplicateMergeResponse,
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
from app.security.rate_limit import UPLOAD_RATE_LIMIT, limiter
from app.services import activity_export
from app.services import activity_timeline as activity_timeline_module
from app.services.approval_gating import can_send_contract_to_docuseal
from app.services.artifact_compare import (
    CompareTextExtractionError,
    artifact_compare_label,
    compute_text_diff,
    extract_comparable_text,
)
from app.services.clause_segmentation import segment_and_persist_clauses
from app.services.compare_report_docx import (
    CompareSideMetadata,
    build_export_filename,
    render_compare_report_docx,
)
from app.services.contract_artifacts import (
    get_latest_official_downloadable_artifact,
    get_latest_official_signable_artifact,
)
from app.services.contract_metadata import (
    ExtractedContractMetadata,
    extract_basic_contract_metadata,
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
from app.services.document_preview import (
    ConversionFailedError,
    ConverterUnavailableError,
    convert_to_pdf_preview,
)
from app.services.docuseal_bridge import (
    DocuSealError,
    send_document_to_docuseal,
)
from app.services.duplicate_detection import (
    DEFAULT_LIMIT as DUP_DEFAULT_LIMIT,
)
from app.services.duplicate_detection import (
    DuplicateCandidate,
    find_possible_duplicate_contracts,
)
from app.services.duplicate_merge import (
    DuplicateMergeError,
    merge_duplicate_contract,
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
@limiter.limit(UPLOAD_RATE_LIMIT)
async def upload_contract(
    request: Request,
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

    # Docling parsing is CPU-bound and can run long; keep it off the event
    # loop so one large upload doesn't stall every other in-flight request.
    parsed = await asyncio.to_thread(_parse_or_http, file_bytes=file_bytes, filename=filename)

    # PR #66 — deterministic, best-effort metadata extraction. We
    # compute it before persisting the Contract so the chosen title
    # honors the user > extracted-suggestion > filename precedence.
    # Failure is non-fatal: an empty result still produces a usable
    # response.
    extracted_metadata = _safe_extract_metadata(
        filename=filename,
        mime_type=mime_type,
        markdown_text=None,
        plain_text=parsed.full_text,
    )
    chosen_title = _choose_title(title, extracted_metadata, filename)

    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)

    contract = Contract(
        organization_id=user.organization_id,
        uploaded_by=user.id,
        title=chosen_title,
        status=ContractStatus.UPLOADED.value,
        s3_key="pending",
        mime_type=mime_type,
        file_hash_sha256=file_hash,
        page_count=parsed.page_count,
        full_text=parsed.full_text,
    )
    session.add(contract)
    await session.flush()

    # PR #66 — warning-level duplicate candidates. Hash-collisions used
    # to hard-block this route with a 409; the new policy surfaces them
    # to the user instead. The new contract is excluded so it can't
    # match itself. Failure is non-fatal.
    duplicate_candidates = await _safe_find_duplicates(
        session,
        organization_id=user.organization_id,
        file_hash_sha256=file_hash,
        suggested_title=extracted_metadata.suggested_title,
        counterparty_name=extracted_metadata.possible_counterparty_name,
        filename=filename,
        exclude_contract_id=contract.id,
    )

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

    return _upload_response(
        contract,
        extracted_fields,
        clauses,
        message=message,
        extracted_metadata=extracted_metadata,
        duplicate_candidates=duplicate_candidates,
    )


@router.get("", response_model=list[ContractListItemResponse])
async def list_contracts(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    include_merged: bool = Query(
        default=False,
        description=(
            "Include Repository records that have been merged into "
            "another record. False by default so the canonical list "
            "is not cluttered with merged duplicates."
        ),
    ),
    q: str | None = Query(
        default=None,
        max_length=200,
        description=(
            "Optional case-insensitive substring match against the "
            "Repository record title or any org-scoped Text preview "
            "(``ContractMarkdownSnapshot``) attached to the record. "
            "Org-scoped; the merged filter still applies (records "
            "merged into another record stay hidden unless "
            "``include_merged=true``). PR #95 introduced the title "
            "match; PR #100 extended it to safely match Text preview "
            "content as well — raw snapshot text is never returned "
            "in this list response. Storage internals, document "
            "bytes, and ``metadata_json`` are not part of the "
            "search predicate."
        ),
    ),
) -> list[ContractListItemResponse]:
    """List Repository records for the caller's organization.

    Records that have been merged into another record (i.e.
    ``merged_into_contract_id IS NOT NULL``) are filtered out by
    default; PR #76 introduced the merge workflow and surfacing
    them as active Repository rows would re-create the duplicate
    clutter the merge was meant to resolve. Pass
    ``?include_merged=true`` to see them — useful for audit /
    "where did this go" queries.

    PR #95 / PR #100 — when ``q`` is provided, results are narrowed
    to records whose ``title`` *or* attached Text preview
    (``ContractMarkdownSnapshot.markdown_text``) contains ``q`` as a
    case-insensitive substring. The query is org-scoped through the
    same WHERE clause that enforces tenant isolation on every read in
    this module; the Text-preview match is gated on a correlated
    ``EXISTS`` against ``contract_markdown_snapshots`` filtered by
    the same ``organization_id``, so cross-org snapshot rows can
    never widen results. There is no JSON path query, no FTS index,
    and no storage metadata in the search predicate. Raw snapshot
    text is *not* returned in the response — only the existing
    ``ContractListItemResponse`` fields are projected — so even a
    matched record never leaks the body of its Text preview.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    base_where = [Contract.organization_id == user.organization_id]
    if not include_merged:
        base_where.append(Contract.merged_into_contract_id.is_(None))
    needle = q.strip() if q is not None else ""
    if needle:
        # ILIKE is fine on the title column and on Text preview
        # content; an explicit ``escape`` keeps stray ``%`` / ``_``
        # in the user input from being interpreted as wildcards.
        # The snapshot match uses a correlated ``EXISTS`` so a
        # contract with multiple snapshots only appears once even
        # when several rows match.
        escaped = needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        title_match = Contract.title.ilike(pattern, escape="\\")
        snapshot_exists = (
            select(ContractMarkdownSnapshot.id)
            .where(
                ContractMarkdownSnapshot.contract_id == Contract.id,
                ContractMarkdownSnapshot.organization_id
                == user.organization_id,
                ContractMarkdownSnapshot.markdown_text.ilike(
                    pattern, escape="\\"
                ),
            )
            .exists()
        )
        stmt = (
            select(
                Contract,
                title_match.label("title_match"),
                snapshot_exists.label("text_preview_match"),
            )
            .where(*base_where)
            .where(or_(title_match, snapshot_exists))
            .order_by(Contract.created_at.desc(), Contract.id.desc())
        )
        result = await session.execute(stmt)
        rows: list[ContractListItemResponse] = []
        for contract, title_hit, text_hit in result.all():
            item = ContractListItemResponse.model_validate(contract)
            item.search_match_source = _match_source(bool(title_hit), bool(text_hit))
            rows.append(item)
        return rows
    stmt = (
        select(Contract)
        .where(*base_where)
        .order_by(Contract.created_at.desc(), Contract.id.desc())
    )
    result = await session.execute(stmt)
    return [ContractListItemResponse.model_validate(row) for row in result.scalars()]


def _match_source(title_hit: bool, text_hit: bool) -> str | None:
    # PR #101 — closed enum of search match sources. We never expose
    # the raw matched snippet here; the UI gets a tiny categorical
    # hint so a user knows *why* a record showed up. Both flags False
    # should be impossible (the WHERE clause guarantees at least one
    # hit) but we return ``None`` defensively rather than guessing.
    if title_hit and text_hit:
        return "title_and_text_preview"
    if title_hit:
        return "title"
    if text_hit:
        return "text_preview"
    return None


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


@router.get(
    "/{contract_id}/activity",
    response_model=ActivityTimelineResponse,
)
async def get_contract_activity(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    limit: int = Query(
        # Canonical default + cap come from the timeline service so the
        # request and contract endpoints can't drift apart on the bounds.
        default=activity_timeline_module.DEFAULT_LIMIT,
        ge=1,
        le=activity_timeline_module.MAX_LIMIT,
        description=(
            "Max number of timeline items to return. Default "
            f"{activity_timeline_module.DEFAULT_LIMIT}, hard-capped at "
            f"{activity_timeline_module.MAX_LIMIT}."
        ),
    ),
) -> ActivityTimelineResponse:
    """Chronological activity feed for a contract (PR #58).

    Visibility-only: assembled from existing ``AuditEvent`` rows. Cross-org
    access returns 404 (via ``_get_contract_for_org``). Storage internals
    cannot leak — the projection only allowlists scalar identifier fields.

    Surfaces:
      * Approval events (workflow created / step activated / step
        approved-or-rejected / workflow completed-rejected-cancelled)
        for any ``ApprovalWorkflowRun`` directly attached to this
        contract via ``workflow_run.contract_id``.
      * DocuSeal send + completion events that target this contract
        (``CONTRACT_SENT_FOR_SIGNATURE`` from PR #44, ``CONTRACT_EXECUTED``
        from PR #45).

    Approval workflow runs that are only attached via a related
    ``ContractRequest`` (``workflow_run.request_id`` set, no
    ``contract_id``) are deliberately not pulled in here — that's the
    request endpoint's job. The request timeline already aggregates both.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    items = await activity_timeline_module.load_contract_activity(
        session, contract, limit=limit
    )
    return ActivityTimelineResponse(items=items)


@router.get("/{contract_id}/activity/export")
async def export_contract_activity(
    contract_id: uuid.UUID,
    session: DbSession,
    export_format: str = Query(
        default="csv",
        alias="format",
        description="Export format: 'csv' or 'json'.",
    ),
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> Response:
    """Download the contract's activity timeline as CSV or JSON (PR #75).

    Reuses the same sanitized projection as ``GET /activity`` — the
    timeline service decides which audit detail keys are exposed; this
    handler only formats that projection into bytes. Storage internals,
    raw audit details, document bytes, signer PII, and DocuSeal
    payloads cannot leak through this path.

    Cross-org / missing contracts return 404 via ``_get_contract_for_org``.
    Unsupported ``?format=`` values return 422.
    """
    fmt = export_format.lower().strip()
    if fmt not in activity_export.SUPPORTED_FORMATS:
        raise HTTPException(
            status_code=422,
            detail="Unsupported export format. Use 'csv' or 'json'.",
        )

    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    items = await activity_timeline_module.load_contract_activity(
        session,
        contract,
        limit=activity_timeline_module.EXPORT_MAX_LIMIT,
        max_cap=activity_timeline_module.EXPORT_MAX_LIMIT,
    )

    filename = activity_export.export_filename(
        subject_type="contract",
        subject_id=contract.id,
        fmt=fmt,  # type: ignore[arg-type]
    )

    # Record an audit event for the export itself. Safe details only:
    # subject id, format, event count. The exported content is NEVER
    # written to the audit log. The new event type is intentionally
    # outside the timeline projection's event-type list so an export
    # does not appear inside the timeline it just produced.
    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.CONTRACT_ACTIVITY_EXPORTED,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "format": fmt,
            "event_count": len(items),
        },
    )

    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    if fmt == "csv":
        return Response(
            content=activity_export.render_csv(items),
            media_type=activity_export.CSV_MEDIA_TYPE,
            headers=headers,
        )
    envelope = activity_export.render_json_envelope(
        subject_type="contract",
        subject_id=contract.id,
        items=items,
    )
    return JSONResponse(
        content=envelope,
        media_type=activity_export.JSON_MEDIA_TYPE,
        headers=headers,
    )


@router.get("/{contract_id}/duplicate-candidates")
async def list_duplicate_candidates_for_contract(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """List possible duplicate Repository records for an existing contract (PR #76).

    The upload route already attaches a warning-level duplicate list
    to fresh uploads. PR #76 surfaces the same lookup on an existing
    contract so the detail page can offer a "merge duplicate" action
    against historical clutter. Same safety posture as the upload
    surface: org-scoped lookup; never returns storage internals;
    candidates are exact-hash and normalized-title matches only.

    Cross-org / missing target → 404. The target itself, and any
    already-merged contract, are excluded from the candidate list.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    raw_candidates = await _safe_find_duplicates(
        session,
        organization_id=user.organization_id,
        file_hash_sha256=contract.file_hash_sha256,
        suggested_title=contract.title,
        counterparty_name=None,
        filename=None,
        exclude_contract_id=contract.id,
    )
    # Filter merged rows. ``DuplicateCandidate`` does not carry the
    # merge flag, so we have to look the rows up. The list is small
    # (DEFAULT_LIMIT=5) so this is cheap; using ``in_`` keeps it to
    # one query.
    candidate_ids = [c.contract_id for c in raw_candidates]
    merged_ids: set[uuid.UUID] = set()
    if candidate_ids:
        merged_rows = await session.execute(
            select(Contract.id).where(
                Contract.id.in_(candidate_ids),
                Contract.merged_into_contract_id.is_not(None),
            )
        )
        merged_ids = set(merged_rows.scalars().all())
    return {
        "candidates": [
            _duplicate_response(c)
            for c in raw_candidates
            if c.contract_id not in merged_ids
        ]
    }


@router.post(
    "/{target_contract_id}/merge-duplicate",
    response_model=DuplicateMergeResponse,
)
async def merge_duplicate_into_contract(
    target_contract_id: uuid.UUID,
    payload: DuplicateMergeRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> DuplicateMergeResponse:
    """Merge a duplicate Repository record into this canonical record (PR #76).

    Both rows must belong to the caller's organization (cross-org
    returns 404). ``source_contract_id == target_contract_id``
    returns 400. Already-merged source or target returns 409 with a
    safe error code (``source_already_merged`` /
    ``target_already_merged``) so the UI can branch.

    Merge behavior:

    * Reassigns ``ContractArtifact`` rows from source to target.
      Artifact storage keys, wrapped DEKs, filenames, hashes, and
      timestamps are preserved verbatim — the only mutation is the
      ``contract_id`` foreign key.
    * Does NOT delete the source row, source document bytes, or any
      artifact. The source row is flagged with
      ``merged_into_contract_id`` / ``merged_at`` / ``merged_by_user_id``
      so deep links still resolve and render a safe "merged into …"
      notice.
    * Does NOT trigger DocuSeal, does NOT change contract status,
      does NOT change approval gates / workflow state, does NOT
      rewire ``ContractRequest`` links, and does NOT mutate
      ``ApprovalWorkflowRun`` rows. The response carries counts so
      the UI can warn about any links that stayed on the source.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    target = await _get_contract_for_org(
        session,
        contract_id=target_contract_id,
        organization_id=user.organization_id,
    )
    source = await _get_contract_for_org(
        session,
        contract_id=payload.source_contract_id,
        organization_id=user.organization_id,
    )

    try:
        result = await merge_duplicate_contract(
            session,
            target=target,
            source=source,
            merged_by_user_id=user.id,
            merge_note=payload.merge_note,
        )
    except DuplicateMergeError as e:
        raise HTTPException(status_code=e.http_status, detail=e.message) from e

    # Paired audit events. Both payloads are intentionally compact:
    # safe identifier fields, a count, and ``merge_note_present`` —
    # never the note text, never storage internals, never raw
    # artifact metadata.
    merge_note_present = bool(
        payload.merge_note is not None and payload.merge_note.strip()
    )
    safe_details = {
        "target_contract_id": str(target.id),
        "source_contract_id": str(source.id),
        "artifacts_moved": result.artifacts_moved,
        "merge_note_present": merge_note_present,
        "workflow_runs_attached_to_source": (
            result.workflow_runs_attached_to_source
        ),
        "requests_attached_to_source": result.requests_attached_to_source,
    }
    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.CONTRACT_DUPLICATE_MERGED,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(target.id),
        details=safe_details,
    )
    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.CONTRACT_MERGED_INTO,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(source.id),
        details=safe_details,
    )

    return DuplicateMergeResponse(
        target_contract_id=result.target_contract_id,
        source_contract_id=result.source_contract_id,
        artifacts_moved=result.artifacts_moved,
        merged_at=result.merged_at,
        merged_by_user_id=result.merged_by_user_id,
        workflow_runs_attached_to_source=(
            result.workflow_runs_attached_to_source
        ),
        requests_attached_to_source=result.requests_attached_to_source,
    )


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


# ---------------------------------------------------------------------------
# PR #67 — User-confirmed metadata correction
# ---------------------------------------------------------------------------


@router.get(
    "/{contract_id}/metadata",
    response_model=ContractMetadataResponse,
)
async def get_contract_metadata(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractMetadataResponse:
    """Return the merged metadata view used by the upload-review panel.

    Reads ``title`` off ``Contract.title`` and the rest off the latest
    ``original_upload`` ``ContractArtifact`` row's ``metadata_json``.
    Org scoped via ``_get_contract_for_org`` — cross-org returns 404.
    Storage internals never appear (the response schema forbids
    extras and the underlying artifact row's storage fields are not
    projected).
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    artifact_metadata = await _latest_original_upload_metadata(
        session,
        contract_id=contract.id,
        organization_id=user.organization_id,
    )
    return _build_metadata_response(contract, artifact_metadata, changed_fields=[])


@router.patch(
    "/{contract_id}/metadata",
    response_model=ContractMetadataResponse,
)
async def update_contract_metadata(
    contract_id: uuid.UUID,
    payload: ContractMetadataUpdateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractMetadataResponse:
    """User-confirmed metadata update for an existing contract.

    Behavior:

    * ``title`` is persisted on ``Contract.title`` (the only Contract
      column for these fields today). Empty strings normalize to
      ``"Untitled contract"`` rather than ``null`` — ``Contract.title``
      is non-nullable and the existing upload pipeline already coerces
      empty input to that sentinel.
    * ``counterparty_name`` / ``contract_type`` / ``effective_date``
      are persisted on the latest ``original_upload`` artifact's
      ``metadata_json``. Empty strings clear the key (the field
      effectively goes back to ``null``); explicit ``null`` does the
      same. Missing keys leave the existing value alone.
    * Other artifact rows (``generated_docx``, ``signed_pdf``) are not
      touched. File storage, wrapped DEKs, markdown snapshots,
      DocuSeal submission ids, approval workflows, and the gate are
      all untouched.
    * Cross-org → 404 (via ``_get_contract_for_org``).
    * Backfill case: if no ``original_upload`` artifact exists yet,
      the non-title fields are not persisted (we don't invent an
      artifact row just to hold metadata). Title still updates;
      ``changed_fields`` reflects what was actually written.

    Audit:

    * Emits ``CONTRACT_METADATA_UPDATED`` with only the
      ``changed_fields`` list — never the old/new values. The values
      are PII; we keep them in the encrypted Contract / artifact rows.
    * No audit event is emitted when nothing actually changed.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )

    changes = payload.model_dump(exclude_unset=True)
    changed_fields: list[str] = []

    # Title is mandatory + non-nullable on the Contract row, so we
    # coerce empty input to the same "Untitled contract" sentinel the
    # upload route uses rather than treating it as "clear me".
    if "title" in changes:
        new_title = (changes["title"] or "").strip()[:500] or "Untitled contract"
        if new_title != contract.title:
            contract.title = new_title
            changed_fields.append("title")

    artifact = await _latest_original_upload_artifact(
        session,
        contract_id=contract.id,
        organization_id=user.organization_id,
    )

    # Non-title fields go on the latest original_upload artifact's
    # metadata_json. When no artifact exists (pre-PR #36 backfill case)
    # we skip these — we'd rather lose the override silently than
    # invent an artifact row from a metadata patch.
    if artifact is not None:
        meta = dict(artifact.metadata_json or {})
        for field_name in ("counterparty_name", "contract_type"):
            if field_name not in changes:
                continue
            new_value_raw = changes[field_name]
            new_value: str | None
            if new_value_raw is None or new_value_raw == "":
                new_value = None
            else:
                cap = 255 if field_name == "counterparty_name" else 64
                new_value = str(new_value_raw).strip()[:cap] or None
            current_value = meta.get(field_name)
            if new_value != current_value:
                if new_value is None:
                    meta.pop(field_name, None)
                else:
                    meta[field_name] = new_value
                changed_fields.append(field_name)

        if "effective_date" in changes:
            new_date = changes["effective_date"]
            new_iso: str | None = new_date.isoformat() if new_date else None
            current_iso = meta.get("effective_date")
            if new_iso != current_iso:
                if new_iso is None:
                    meta.pop("effective_date", None)
                else:
                    meta["effective_date"] = new_iso
                changed_fields.append("effective_date")

        if changed_fields:
            artifact.metadata_json = meta

    if changed_fields:
        await session.flush()
        await record_event(
            session,
            organization_id=user.organization_id,
            event_type=AuditEventType.CONTRACT_METADATA_UPDATED,
            actor_user_id=user.id,
            target_type="contract",
            target_id=str(contract.id),
            details={
                "contract_id": str(contract.id),
                "changed_fields": list(changed_fields),
            },
        )
        await session.refresh(contract)
        if artifact is not None:
            await session.refresh(artifact)

    artifact_metadata = (artifact.metadata_json or {}) if artifact is not None else None
    return _build_metadata_response(
        contract, artifact_metadata, changed_fields=changed_fields
    )


async def _latest_original_upload_artifact(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ContractArtifact | None:
    stmt = (
        select(ContractArtifact)
        .where(
            ContractArtifact.contract_id == contract_id,
            ContractArtifact.organization_id == organization_id,
            ContractArtifact.artifact_type == "original_upload",
        )
        .order_by(
            ContractArtifact.created_at.desc(), ContractArtifact.id.desc()
        )
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _latest_original_upload_metadata(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> dict | None:
    artifact = await _latest_original_upload_artifact(
        session, contract_id=contract_id, organization_id=organization_id
    )
    if artifact is None:
        return None
    return artifact.metadata_json or {}


def _build_metadata_response(
    contract: Contract,
    artifact_metadata: dict | None,
    *,
    changed_fields: list[str],
) -> ContractMetadataResponse:
    meta = artifact_metadata or {}
    counterparty = meta.get("counterparty_name") if isinstance(meta.get("counterparty_name"), str) else None
    contract_type = meta.get("contract_type") if isinstance(meta.get("contract_type"), str) else None
    effective_iso = meta.get("effective_date")
    effective: date | None = None
    if isinstance(effective_iso, str):
        try:
            effective = date.fromisoformat(effective_iso)
        except ValueError:
            effective = None
    return ContractMetadataResponse(
        contract_id=contract.id,
        title=contract.title,
        counterparty_name=counterparty,
        contract_type=contract_type,
        effective_date=effective,
        updated_at=contract.updated_at,
        changed_fields=list(changed_fields),
    )


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
    """Download the official legal artifact for a contract.

    Resolution order:
      1. Latest official ``signed_pdf`` ContractArtifact, if present
         (DocuSeal completion writes this — once a contract has been
         executed, the signed PDF is the official record).
      2. Latest official ``generated_docx`` ContractArtifact (template
         generation flow; the contract has no ``original_upload``).
      3. Latest official ``original_upload`` ContractArtifact (the v1
         upload flow writes one of these per upload).
      4. Legacy ``Contract.s3_key`` / ``Contract.mime_type``, for
         contracts uploaded before the artifact model landed and not
         yet backfilled.

    The wrapped DEK is read from the artifact row when present
    (``signed_pdf`` always carries its own DEK; older artifacts may
    not). When the artifact has no wrapped DEK we fall back to
    ``Contract.wrapped_dek`` — the pre-#45 invariant where every
    artifact for a contract was encrypted under the same DEK.
    ``storage_key`` is read off the resolved source and never echoed
    back to the client.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )

    artifact = await get_latest_official_downloadable_artifact(
        session,
        contract_id=contract.id,
        organization_id=user.organization_id,
    )
    return await _stream_contract_artifact_download(
        session,
        user=user,
        contract=contract,
        artifact=artifact,
        audit_event_type=AuditEventType.CONTRACT_DOWNLOADED,
        allow_legacy_fallback=True,
    )


@router.get("/{contract_id}/artifacts/{artifact_id}/download")
async def download_contract_artifact(
    contract_id: uuid.UUID,
    artifact_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> Response:
    """Download a specific ContractArtifact version (PR #70).

    Used by the Document History row's "Download version" action so
    users can pull a specific source upload, generated DOCX, signed
    PDF, redline, exhibit, or attachment rather than only the current
    priority-winning document.

    Resolution rules:
      * Contract must belong to the caller's organization (cross-org
        access returns 404 via ``_get_contract_for_org``).
      * The artifact must match ``artifact_id``, belong to this
        contract, and belong to the same organization — any miss
        returns 404, matching the contract-not-found shape so callers
        cannot distinguish "wrong artifact" from "wrong contract".
      * No legacy ``Contract.s3_key`` fallback — this endpoint is
        per-artifact, so a request for a specific artifact_id that
        has no retrievable storage metadata returns 409 instead of
        silently serving a different file.

    Decryption uses the same storage + AAD logic as the contract
    download endpoint via ``_stream_contract_artifact_download``;
    no presigned URLs are produced and no storage internals
    (``storage_key``, ``wrapped_dek``) are echoed to the client.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    artifact = await _resolve_downloadable_artifact(
        session,
        contract_id=contract.id,
        artifact_id=artifact_id,
        organization_id=user.organization_id,
    )
    return await _stream_contract_artifact_download(
        session,
        user=user,
        contract=contract,
        artifact=artifact,
        audit_event_type=AuditEventType.CONTRACT_ARTIFACT_DOWNLOADED,
        allow_legacy_fallback=False,
    )



@router.get("/{contract_id}/artifacts/{artifact_id}/preview")
async def preview_contract_artifact(
    contract_id: uuid.UUID,
    artifact_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> Response:
    """Inline PDF preview for a specific Repository document version."""
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    artifact = await _resolve_downloadable_artifact(
        session,
        contract_id=contract.id,
        artifact_id=artifact_id,
        organization_id=user.organization_id,
    )

    mime_type = artifact.mime_type or contract.mime_type
    if mime_type not in {_PDF_MIME, _DOCX_MIME}:
        raise HTTPException(status_code=415, detail="Unsupported file type for preview.")

    plaintext, _ = await _decrypt_artifact_bytes(
        session,
        user=user,
        contract=contract,
        artifact=artifact,
        allow_legacy_fallback=False,
    )

    try:
        # LibreOffice conversion shells out to a subprocess and can take
        # a couple seconds; run it off the event loop.
        preview_result = await asyncio.to_thread(convert_to_pdf_preview, plaintext, mime_type)
    except ConverterUnavailableError as exc:
        raise HTTPException(
            status_code=422,
            detail="PDF preview could not be generated for this file.",
        ) from exc
    except ConversionFailedError as exc:
        raise HTTPException(
            status_code=422,
            detail="PDF preview could not be generated for this file.",
        ) from exc

    filename = _download_filename(contract, artifact=artifact)
    if filename.lower().endswith(".docx"):
        filename = f"{filename[:-5]}.pdf"

    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.CONTRACT_ARTIFACT_PREVIEWED,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "artifact_id": str(artifact.id),
            "artifact_type": artifact.artifact_type,
            "filename": artifact.filename,
            "mime_type": mime_type,
            "preview_format": "pdf",
            "conversion_source": preview_result.conversion_source,
        },
    )

    return Response(
        content=preview_result.pdf_bytes,
        media_type=_PDF_MIME,
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
        },
    )


@router.post(
    "/{contract_id}/artifacts/compare",
    response_model=ArtifactCompareResponse,
)
async def compare_contract_artifacts(
    contract_id: uuid.UUID,
    payload: ArtifactCompareRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ArtifactCompareResponse:
    """Text-based comparison between two ContractArtifact versions (PR #71).

    Powers the Document History "Compare versions" action. Resolution
    rules mirror the per-artifact download endpoint so the same audit
    posture and the same scoping invariants apply:

      * Contract must belong to the caller's organization (cross-org
        → 404 via ``_get_contract_for_org``).
      * Both ``base_artifact_id`` and ``compare_artifact_id`` must
        match an artifact on this contract and this organization.
        Any miss returns 404 — the response cannot distinguish
        "wrong artifact" from "wrong contract" from "wrong org".
      * Each artifact must have retrievable storage metadata
        (``storage_key`` + decryptable DEK). A miss returns 409.
      * Extraction is best-effort via the existing MarkItDown-backed
        converter. If either side cannot be converted to plain text,
        the route returns 422 with a clear, side-tagged message. No
        OCR, no Docling, no remote service, no LLM.

    The response carries safe metadata only: artifact ids, types,
    user-facing labels, filenames, and structured diff lines. The
    extracted text is not stored; raw bytes, ``storage_key``,
    ``wrapped_dek``, and signer PII never reach the client.

    On success a ``contract.artifacts_compared`` audit event is
    appended with the two artifact ids/types and the line-count
    summary — never the extracted text.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    base_artifact = await _resolve_downloadable_artifact(
        session,
        contract_id=contract.id,
        artifact_id=payload.base_artifact_id,
        organization_id=user.organization_id,
    )
    compare_artifact = await _resolve_downloadable_artifact(
        session,
        contract_id=contract.id,
        artifact_id=payload.compare_artifact_id,
        organization_id=user.organization_id,
    )

    base_bytes, base_mime = await _decrypt_artifact_bytes(
        session,
        user=user,
        contract=contract,
        artifact=base_artifact,
        allow_legacy_fallback=False,
    )
    compare_bytes, compare_mime = await _decrypt_artifact_bytes(
        session,
        user=user,
        contract=contract,
        artifact=compare_artifact,
        allow_legacy_fallback=False,
    )

    warnings: list[str] = []
    try:
        base_extracted = extract_comparable_text(
            file_bytes=base_bytes,
            mime_type=base_mime,
            filename=base_artifact.filename,
            side="base",
        )
    except CompareTextExtractionError as exc:
        raise HTTPException(
            status_code=422,
            detail=(
                "The base version could not be converted to comparable text."
            ),
        ) from exc
    try:
        compare_extracted = extract_comparable_text(
            file_bytes=compare_bytes,
            mime_type=compare_mime,
            filename=compare_artifact.filename,
            side="compare",
        )
    except CompareTextExtractionError as exc:
        raise HTTPException(
            status_code=422,
            detail=(
                "The compare version could not be converted to comparable text."
            ),
        ) from exc
    warnings.extend(base_extracted.warnings)
    warnings.extend(compare_extracted.warnings)

    # Defensive: zero the decrypted bytes references so they aren't
    # kept around longer than needed. The plaintext lives in memory
    # in any case while difflib runs, but after the diff we no longer
    # need it.
    del base_bytes, compare_bytes

    diff = compute_text_diff(base_extracted.text, compare_extracted.text)
    warnings.extend(diff.warnings)

    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.CONTRACT_ARTIFACTS_COMPARED,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "base_artifact_id": str(base_artifact.id),
            "compare_artifact_id": str(compare_artifact.id),
            "base_artifact_type": base_artifact.artifact_type,
            "compare_artifact_type": compare_artifact.artifact_type,
            "added_lines": diff.summary.added_lines,
            "removed_lines": diff.summary.removed_lines,
            "changed_blocks": diff.summary.changed_blocks,
        },
    )

    return ArtifactCompareResponse(
        base=_compare_side_response(base_artifact),
        compare=_compare_side_response(compare_artifact),
        summary=CompareSummaryResponse(
            added_lines=diff.summary.added_lines,
            removed_lines=diff.summary.removed_lines,
            changed_blocks=diff.summary.changed_blocks,
            unchanged_lines=diff.summary.unchanged_lines,
        ),
        diff_blocks=[
            DiffBlockResponse(
                type=block.type,
                base_line_start=block.base_line_start,
                compare_line_start=block.compare_line_start,
                lines=[
                    DiffLineResponse(type=line.type, text=line.text)
                    for line in block.lines
                ],
            )
            for block in diff.diff_blocks
        ],
        warnings=warnings,
    )


@router.post(
    "/{contract_id}/artifacts/compare/export",
    responses={
        200: {
            "content": {_DOCX_MIME: {}},
            "description": "Comparison report as DOCX bytes.",
        },
        404: {"description": "Contract or artifact not found in this org."},
        409: {"description": "Selected artifact has no retrievable storage metadata."},
        422: {"description": "Either side could not be converted to comparable text."},
    },
)
async def export_contract_artifacts_compare(
    contract_id: uuid.UUID,
    payload: ArtifactCompareRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> Response:
    """On-demand redline-style export of a comparison report DOCX (PR #90).

    This is the export counterpart to ``compare_contract_artifacts``.
    Same resolution rules, same scoping invariants, same extraction
    fallback semantics; the difference is the wire format: instead of
    a JSON diff structure we render the diff as a downloadable
    comparison-report DOCX.

    Important user-visible framing: this is NOT a Word tracked-changes
    file. Generating a true ``w:ins``/``w:del`` redline from arbitrary
    text input is error-prone, so PR #90 ships a clearly labelled
    *comparison report* instead. The first paragraph of the rendered
    DOCX makes that explicit.

    Nothing is persisted. The DOCX bytes are returned to the caller
    and forgotten — no ``ContractArtifact`` row is created, no
    download priority changes. A safe
    ``contract.artifacts_compare_exported`` audit event records that
    the export happened (allowlisted fields only — never the diff
    text, the extracted text, storage internals, or signer PII).
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    base_artifact = await _resolve_downloadable_artifact(
        session,
        contract_id=contract.id,
        artifact_id=payload.base_artifact_id,
        organization_id=user.organization_id,
    )
    compare_artifact = await _resolve_downloadable_artifact(
        session,
        contract_id=contract.id,
        artifact_id=payload.compare_artifact_id,
        organization_id=user.organization_id,
    )

    base_bytes, base_mime = await _decrypt_artifact_bytes(
        session,
        user=user,
        contract=contract,
        artifact=base_artifact,
        allow_legacy_fallback=False,
    )
    compare_bytes, compare_mime = await _decrypt_artifact_bytes(
        session,
        user=user,
        contract=contract,
        artifact=compare_artifact,
        allow_legacy_fallback=False,
    )

    try:
        base_extracted = extract_comparable_text(
            file_bytes=base_bytes,
            mime_type=base_mime,
            filename=base_artifact.filename,
            side="base",
        )
    except CompareTextExtractionError as exc:
        raise HTTPException(
            status_code=422,
            detail=(
                "The base version could not be converted to comparable text."
            ),
        ) from exc
    try:
        compare_extracted = extract_comparable_text(
            file_bytes=compare_bytes,
            mime_type=compare_mime,
            filename=compare_artifact.filename,
            side="compare",
        )
    except CompareTextExtractionError as exc:
        raise HTTPException(
            status_code=422,
            detail=(
                "The compare version could not be converted to comparable text."
            ),
        ) from exc

    # Drop the decrypted bytes references before we render — the
    # rendered DOCX only needs the extracted text strings from here on.
    del base_bytes, compare_bytes

    diff = compute_text_diff(base_extracted.text, compare_extracted.text)
    diff.warnings.extend(base_extracted.warnings)
    diff.warnings.extend(compare_extracted.warnings)

    base_label = artifact_compare_label(
        base_artifact.artifact_type, base_artifact.source
    )
    compare_label = artifact_compare_label(
        compare_artifact.artifact_type, compare_artifact.source
    )
    docx_bytes = render_compare_report_docx(
        diff=diff,
        base=CompareSideMetadata(
            label=base_label,
            filename=base_artifact.filename,
            created_at=base_artifact.created_at,
        ),
        compare=CompareSideMetadata(
            label=compare_label,
            filename=compare_artifact.filename,
            created_at=compare_artifact.created_at,
        ),
        contract_title=contract.title,
    )

    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.CONTRACT_ARTIFACTS_COMPARE_EXPORTED,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "base_artifact_id": str(base_artifact.id),
            "compare_artifact_id": str(compare_artifact.id),
            "base_artifact_type": base_artifact.artifact_type,
            "compare_artifact_type": compare_artifact.artifact_type,
            "added_lines": diff.summary.added_lines,
            "removed_lines": diff.summary.removed_lines,
            "changed_blocks": diff.summary.changed_blocks,
            "format": "docx",
            "byte_count": len(docx_bytes),
        },
    )

    filename = build_export_filename(contract.title)
    return Response(
        content=docx_bytes,
        media_type=_DOCX_MIME,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@router.post(
    "/{contract_id}/artifacts/compare/save",
    response_model=ContractArtifactResponse,
    status_code=201,
    responses={
        201: {"description": "Comparison report persisted as a redline artifact."},
        404: {"description": "Contract or artifact not found in this org."},
        409: {"description": "Selected artifact has no retrievable storage metadata."},
        422: {"description": "Either side could not be converted to comparable text."},
    },
)
async def save_contract_artifacts_compare(
    contract_id: uuid.UUID,
    payload: ArtifactCompareRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractArtifactResponse:
    """Persist a comparison report as a ``redline`` ``ContractArtifact`` (PR #91).

    Same resolution rules and scoping invariants as
    ``export_contract_artifacts_compare``; the difference is that the
    rendered DOCX bytes are encrypted via the existing
    ``DocumentStorage`` pipeline (fresh per-artifact DEK) and a new
    ``ContractArtifact`` row is written with ``artifact_type="redline"``,
    ``is_official=False`` and ``source="comparison_report"``.

    Saved redlines are deliberately **not** "official": the default
    *Download current document* action keeps preferring
    ``signed_pdf`` → ``generated_docx`` → ``original_upload`` (see
    ``DOWNLOADABLE_ARTIFACT_TYPES_BY_PRIORITY``), which filters to
    official rows. Redlines surface in Document History and are
    retrievable via the existing per-artifact download endpoint
    (PR #70).

    Metadata stored on the redline row is allowlisted: the two source
    artifact ids/types, the diff summary counts, and ``format=docx``.
    The diff text, extracted text, ``storage_key``, ``wrapped_dek``,
    and any signer PII never enter the metadata blob or the audit
    event.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    base_artifact = await _resolve_downloadable_artifact(
        session,
        contract_id=contract.id,
        artifact_id=payload.base_artifact_id,
        organization_id=user.organization_id,
    )
    compare_artifact = await _resolve_downloadable_artifact(
        session,
        contract_id=contract.id,
        artifact_id=payload.compare_artifact_id,
        organization_id=user.organization_id,
    )

    base_bytes, base_mime = await _decrypt_artifact_bytes(
        session,
        user=user,
        contract=contract,
        artifact=base_artifact,
        allow_legacy_fallback=False,
    )
    compare_bytes, compare_mime = await _decrypt_artifact_bytes(
        session,
        user=user,
        contract=contract,
        artifact=compare_artifact,
        allow_legacy_fallback=False,
    )

    try:
        base_extracted = extract_comparable_text(
            file_bytes=base_bytes,
            mime_type=base_mime,
            filename=base_artifact.filename,
            side="base",
        )
    except CompareTextExtractionError as exc:
        raise HTTPException(
            status_code=422,
            detail=(
                "The base version could not be converted to comparable text."
            ),
        ) from exc
    try:
        compare_extracted = extract_comparable_text(
            file_bytes=compare_bytes,
            mime_type=compare_mime,
            filename=compare_artifact.filename,
            side="compare",
        )
    except CompareTextExtractionError as exc:
        raise HTTPException(
            status_code=422,
            detail=(
                "The compare version could not be converted to comparable text."
            ),
        ) from exc

    del base_bytes, compare_bytes

    diff = compute_text_diff(base_extracted.text, compare_extracted.text)
    diff.warnings.extend(base_extracted.warnings)
    diff.warnings.extend(compare_extracted.warnings)

    base_label = artifact_compare_label(
        base_artifact.artifact_type, base_artifact.source
    )
    compare_label = artifact_compare_label(
        compare_artifact.artifact_type, compare_artifact.source
    )
    docx_bytes = render_compare_report_docx(
        diff=diff,
        base=CompareSideMetadata(
            label=base_label,
            filename=base_artifact.filename,
            created_at=base_artifact.created_at,
        ),
        compare=CompareSideMetadata(
            label=compare_label,
            filename=compare_artifact.filename,
            created_at=compare_artifact.created_at,
        ),
        contract_title=contract.title,
    )

    # Encrypt and persist via the existing storage pipeline. Fresh
    # per-artifact DEK so the redline doesn't piggyback on any other
    # artifact's key (matches the signed_pdf pattern from PR #45).
    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)
    storage = DocumentStorage(get_settings())
    document_id = f"contract-{contract.id}-redline-{uuid.uuid4()}"
    try:
        stored = await storage.store_encrypted(
            plaintext_bytes=docx_bytes,
            document_id=document_id,
            org_master_key=org_master_key,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not store the redline artifact.",
        ) from exc
    finally:
        del org_master_key

    file_hash = hashlib.sha256(docx_bytes).hexdigest()
    filename = build_export_filename(contract.title)
    metadata: dict[str, Any] = {
        "base_artifact_id": str(base_artifact.id),
        "compare_artifact_id": str(compare_artifact.id),
        "base_artifact_type": base_artifact.artifact_type,
        "compare_artifact_type": compare_artifact.artifact_type,
        "added_lines": diff.summary.added_lines,
        "removed_lines": diff.summary.removed_lines,
        "changed_blocks": diff.summary.changed_blocks,
        "unchanged_lines": diff.summary.unchanged_lines,
        "format": "docx",
        "source_kind": "comparison_report",
    }

    artifact = ContractArtifact(
        organization_id=contract.organization_id,
        contract_id=contract.id,
        artifact_type="redline",
        storage_backend="s3",
        storage_key=stored.s3_key,
        wrapped_dek=stored.wrapped_dek_bytes,
        filename=filename,
        mime_type=_DOCX_MIME,
        file_hash_sha256=file_hash,
        size_bytes=len(docx_bytes),
        source="comparison_report",
        is_official=False,
        created_by=user.id,
        metadata_json=metadata,
    )
    session.add(artifact)
    await session.flush()

    # Drop the plaintext reference now that the ciphertext is in
    # storage and the metadata row is staged for commit.
    del docx_bytes

    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.CONTRACT_ARTIFACT_REDLINE_SAVED,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "artifact_id": str(artifact.id),
            "base_artifact_id": str(base_artifact.id),
            "compare_artifact_id": str(compare_artifact.id),
            "base_artifact_type": base_artifact.artifact_type,
            "compare_artifact_type": compare_artifact.artifact_type,
            "added_lines": diff.summary.added_lines,
            "removed_lines": diff.summary.removed_lines,
            "changed_blocks": diff.summary.changed_blocks,
            "format": "docx",
        },
    )

    return ContractArtifactResponse.model_validate(artifact)


def _compare_side_response(artifact: ContractArtifact) -> ArtifactCompareSideResponse:
    """Project a ContractArtifact into a compare-panel side descriptor.

    Only safe metadata travels: id, type, user-facing label, the
    user-provided filename, and the timestamp. No ``metadata_json``,
    no ``storage_key``, no ``wrapped_dek``.
    """
    return ArtifactCompareSideResponse(
        artifact_id=artifact.id,
        artifact_type=artifact.artifact_type,
        label=artifact_compare_label(artifact.artifact_type, artifact.source),
        filename=artifact.filename,
        created_at=artifact.created_at,
    )


async def _resolve_downloadable_artifact(
    session: AsyncSession,
    *,
    contract_id: uuid.UUID,
    artifact_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ContractArtifact:
    """Fetch a ContractArtifact for the per-artifact download endpoint.

    Org scoped + contract scoped. A miss on any of (artifact_id,
    contract_id, organization_id) is treated as 404 so the caller
    cannot distinguish "no such artifact" from "artifact belongs to
    another contract" from "artifact belongs to another org".
    """
    stmt = select(ContractArtifact).where(
        ContractArtifact.id == artifact_id,
        ContractArtifact.contract_id == contract_id,
        ContractArtifact.organization_id == organization_id,
    )
    result = await session.execute(stmt)
    artifact = result.scalar_one_or_none()
    if artifact is None:
        raise HTTPException(status_code=404, detail="Artifact not found.")
    return artifact


async def _stream_contract_artifact_download(
    session: AsyncSession,
    *,
    user: User,
    contract: Contract,
    artifact: ContractArtifact | None,
    audit_event_type: AuditEventType,
    allow_legacy_fallback: bool,
) -> Response:
    """Decrypt an artifact's bytes and return them as an attachment Response.

    Shared by the contract download endpoint and the per-artifact
    download endpoint. When ``artifact`` is ``None`` and
    ``allow_legacy_fallback`` is true, falls back to
    ``Contract.s3_key`` / ``Contract.wrapped_dek`` / ``Contract.mime_type``
    (legacy pre-artifact path); when ``allow_legacy_fallback`` is
    false a missing artifact raises 404.

    Always emits the supplied audit event on success. Storage
    internals (``storage_key``, ``wrapped_dek``) are read off the
    resolved source and are never returned to the caller.
    """
    plaintext, mime_type = await _decrypt_artifact_bytes(
        session,
        user=user,
        contract=contract,
        artifact=artifact,
        allow_legacy_fallback=allow_legacy_fallback,
    )

    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=audit_event_type,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(contract.id),
        details=_audit_contract_details(
            contract,
            filename=artifact.filename if artifact is not None else None,
            artifact_id=artifact.id if artifact is not None else None,
            artifact_type=artifact.artifact_type if artifact is not None else None,
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


async def _decrypt_artifact_bytes(
    session: AsyncSession,
    *,
    user: User,
    contract: Contract,
    artifact: ContractArtifact | None,
    allow_legacy_fallback: bool,
) -> tuple[bytes, str]:
    """Resolve storage metadata, decrypt, return ``(plaintext, mime_type)``.

    Extracted from the download/streaming helper so the compare
    endpoint (PR #71) can read the bytes through the same code path
    without writing a ``contract.artifact_downloaded`` audit event.
    No audit is written here — the caller is responsible for emitting
    the right event for their flow.

    Storage internals (``storage_key`` / ``wrapped_dek``) stay inside
    this function. ``HTTPException`` is raised for the same shaped
    errors the streaming helper used to raise inline:

      * 404 — artifact is required but missing (no legacy fallback).
      * 409 — storage metadata or wrapped DEK is missing/unusable.
      * 500 — the storage layer raised on retrieval.
    """
    if artifact is None and not allow_legacy_fallback:
        # Defensive: the per-artifact endpoint resolves the row before
        # calling this helper, so this branch only fires if a future
        # caller forgets to do that.
        raise HTTPException(status_code=404, detail="Artifact not found.")

    if allow_legacy_fallback:
        storage_key = _artifact_storage_key_with_legacy(contract, artifact)
        wrapped_dek_bytes = _artifact_wrapped_dek_with_legacy(contract, artifact)
        mime_type = _artifact_content_type_with_legacy(contract, artifact)
    else:
        # No legacy fallback: the per-artifact endpoint requires the
        # artifact row itself to carry retrievable storage metadata.
        # ``signed_pdf`` rows write their own wrapped DEK; older
        # ``original_upload`` / ``generated_docx`` rows leave
        # ``artifact.wrapped_dek`` NULL and rely on
        # ``Contract.wrapped_dek``. That fallback is safe here because
        # the artifact is verified to belong to this contract.
        assert artifact is not None
        storage_key = artifact.storage_key
        wrapped_dek_bytes = (
            artifact.wrapped_dek
            if artifact.wrapped_dek is not None
            else contract.wrapped_dek
        )
        mime_type = artifact.mime_type or contract.mime_type
    if not storage_key or storage_key == "pending":
        raise HTTPException(
            status_code=409,
            detail="Artifact has no retrievable storage metadata.",
        )
    if wrapped_dek_bytes is None:
        raise HTTPException(
            status_code=409, detail="Contract encryption metadata is missing."
        )

    # AAD must match what was used at ``store_encrypted`` time. Older
    # artifacts (and the legacy ``Contract.s3_key`` blob) were encrypted
    # under ``document_id=str(contract.id)``. Per-artifact-DEK rows
    # (``signed_pdf`` from PR #45, and any future per-artifact DEK
    # writers) use a unique document id derived from the storage key.
    if artifact is not None and artifact.wrapped_dek is not None and artifact.storage_key:
        decrypt_document_id = (
            _document_id_from_storage_key(artifact.storage_key)
            or str(contract.id)
        )
    else:
        decrypt_document_id = str(contract.id)

    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)
    storage = DocumentStorage(get_settings())
    try:
        plaintext = await storage.retrieve_decrypted(
            s3_key=storage_key,
            document_id=decrypt_document_id,
            wrapped_dek_bytes=wrapped_dek_bytes,
            org_master_key=org_master_key,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail="Could not retrieve encrypted document."
        ) from e
    finally:
        del org_master_key

    return plaintext, mime_type


def _artifact_storage_key_with_legacy(
    contract: Contract,
    artifact: ContractArtifact | None,
) -> str | None:
    """Pick the storage key for the legacy-fallback download path.

    Used by the contract-level download endpoint where a contract
    without any artifact rows still has to resolve through
    ``Contract.s3_key``. The per-artifact endpoint does NOT use this
    helper — it requires the storage key to live on the artifact.
    """
    if artifact is not None and artifact.storage_key:
        return artifact.storage_key
    return contract.s3_key


def _artifact_wrapped_dek_with_legacy(
    contract: Contract,
    artifact: ContractArtifact | None,
) -> bytes | None:
    if artifact is not None and artifact.wrapped_dek is not None:
        return artifact.wrapped_dek
    return contract.wrapped_dek


def _artifact_content_type_with_legacy(
    contract: Contract,
    artifact: ContractArtifact | None,
) -> str:
    if artifact is not None and artifact.mime_type:
        return artifact.mime_type
    return contract.mime_type




@router.get(
    "/{contract_id}/approval-gate",
    response_model=ContractApprovalGateResponse,
)
async def get_contract_approval_gate(
    contract_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractApprovalGateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    gate = await can_send_contract_to_docuseal(session, contract, user.organization_id)
    return ContractApprovalGateResponse.model_validate(gate.to_safe_dict())

@router.post(
    "/{contract_id}/send-to-docuseal",
    response_model=SendContractToDocuSealResponse,
    status_code=201,
)
async def send_contract_to_docuseal(
    contract_id: uuid.UUID,
    payload: SendContractToDocuSealRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> SendContractToDocuSealResponse:
    """Send a contract to DocuSeal for signature collection.

    Resolves the right artifact to sign in this order:

      1. Latest official ``generated_docx`` ContractArtifact (a draft
         agreement rendered from an AgreementTemplate).
      2. Latest official ``original_upload`` ContractArtifact.
      3. Legacy ``Contract.s3_key`` for contracts uploaded before the
         artifact model landed and not yet backfilled.

    The artifact is decrypted in-process and POSTed to DocuSeal as
    base64. Whereas keeps documents encrypted at rest under the org
    master key, so a presigned URL would only ever serve DocuSeal
    ciphertext; sending the bytes directly keeps the trust boundary
    in one place. Storage internals (``storage_key``, ``wrapped_dek``,
    raw S3 keys) and the DocuSeal auth-bridge JWT are never echoed
    back to the client.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    contract = await _get_contract_for_org(
        session,
        contract_id=contract_id,
        organization_id=user.organization_id,
    )
    if contract.wrapped_dek is None:
        raise HTTPException(
            status_code=409,
            detail="Contract encryption metadata is missing.",
        )

    if payload.approval_override and not user.is_admin:
        raise HTTPException(
            status_code=403,
            detail="Only administrators can override the approval gate.",
        )

    gate = await can_send_contract_to_docuseal(session, contract, user.organization_id)
    if not gate.allowed and not payload.approval_override:
        raise HTTPException(
            status_code=409,
            detail={
                "detail": "Contract cannot be sent to DocuSeal until approvals are completed.",
                "code": "approval_required",
                "gate": gate.to_safe_dict(),
            },
        )
    if not gate.allowed and payload.approval_override and not (payload.approval_override_reason or "").strip():
        raise HTTPException(status_code=422, detail="approval_override_reason is required when override is enabled.")

    artifact = await get_latest_official_signable_artifact(
        session,
        contract_id=contract.id,
        organization_id=user.organization_id,
    )
    storage_key = (
        artifact.storage_key
        if artifact is not None and artifact.storage_key
        else contract.s3_key
    )
    if not storage_key or storage_key == "pending":
        raise HTTPException(
            status_code=409,
            detail=(
                "Contract has no downloadable artifact to send for signature."
            ),
        )
    mime_type = (
        artifact.mime_type
        if artifact is not None and artifact.mime_type
        else contract.mime_type
    )
    filename = _send_filename(contract, artifact=artifact)

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
        raise HTTPException(
            status_code=500,
            detail="Could not retrieve encrypted document.",
        ) from e
    finally:
        del org_master_key

    submitters = [
        {
            "email": signer.email,
            "name": signer.name,
            "role": signer.role,
        }
        for signer in payload.signers
    ]
    try:
        upstream = await send_document_to_docuseal(
            document_bytes=plaintext,
            filename=filename,
            mime_type=mime_type,
            submitters=submitters,
            user_id=user.id,
            user_email=user.email,
            organization_id=user.organization_id,
        )
    except DocuSealError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    finally:
        del plaintext

    submission_id = _extract_submission_id(upstream)
    embed_url = _extract_embed_url(upstream)

    # Repeated sends are deliberately allowed. A user who hit "send"
    # with a typo in a signer's email needs to be able to send again
    # without an admin unsticking the contract; gating this on
    # ``contract.docuseal_submission_id is None`` would either block
    # that legitimate retry or force a parallel "cancel previous
    # submission" surface that DocuSeal already owns. The latest
    # ``docuseal_submission_id`` is what we keep on the row — every
    # send is captured separately in the audit log, so the prior
    # submission ids are not lost from the audit view.
    if submission_id is not None:
        contract.docuseal_submission_id = submission_id
    contract.status = ContractStatus.SENT_FOR_SIGNATURE.value
    await session.flush()

    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.CONTRACT_SENT_FOR_SIGNATURE,
        actor_user_id=user.id,
        target_type="contract",
        target_id=str(contract.id),
        details={
            "contract_id": str(contract.id),
            "artifact_id": str(artifact.id) if artifact is not None else None,
            "artifact_type": artifact.artifact_type if artifact is not None else None,
            "filename": filename,
            "signer_count": len(submitters),
            "submission_id": submission_id,
            "approval_override": bool(payload.approval_override),
            "approval_override_reason": payload.approval_override_reason if payload.approval_override else None,
            "approval_gate_code": gate.code,
            "approval_blocking_workflow_ids": [str(wid) for wid in gate.blocking_workflow_ids],
        },
    )

    return SendContractToDocuSealResponse(
        contract_id=contract.id,
        artifact_id=artifact.id if artifact is not None else None,
        artifact_type=artifact.artifact_type if artifact is not None else None,
        filename=filename,
        submission_id=submission_id,
        status=ContractStatus.SENT_FOR_SIGNATURE.value,
        embed_url=embed_url,
        signer_count=len(submitters),
        raw=_safe_upstream_projection(upstream),
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
            total_uncompressed = sum(info.file_size for info in archive.infolist())
    except zipfile.BadZipFile:
        return False
    # Decompression-bomb guard: a small malicious zip can declare wildly
    # oversized member sizes. Reject before anything downstream extracts it.
    if total_uncompressed > get_settings().DOCX_MAX_UNCOMPRESSED_BYTES:
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


def _choose_title(
    user_title: str | None,
    extracted: ExtractedContractMetadata,
    filename: str,
) -> str:
    """Title precedence: explicit user input wins, then the extractor's
    suggested title, then the filename-derived fallback.

    PR #66 introduces the middle tier so a filename like
    ``Mutual_NDA_Acme_2026.pdf`` produces "Mutual NDA Acme 2026"
    instead of the raw stem with separators preserved. The user-input
    branch is unchanged so explicit overrides remain authoritative.
    """
    clean_user = (user_title or "").strip()
    if clean_user:
        return clean_user[:500]
    if extracted.suggested_title:
        return extracted.suggested_title.strip()[:500]
    stem = os.path.splitext(os.path.basename(filename))[0].strip()
    return (stem or "Untitled contract")[:500]


def _safe_extract_metadata(
    *,
    filename: str,
    mime_type: str | None,
    markdown_text: str | None,
    plain_text: str | None,
) -> ExtractedContractMetadata:
    """Wrap ``extract_basic_contract_metadata`` so a defective heuristic
    can't fail the upload. The extractor already declares itself
    non-raising; this is belt-and-braces.
    """
    try:
        return extract_basic_contract_metadata(
            filename=filename,
            mime_type=mime_type,
            markdown_text=markdown_text,
            plain_text=plain_text,
        )
    except Exception:
        # ``extra={"filename": ...}`` collides with Python's LogRecord
        # built-in ``filename`` attribute and raises a KeyError inside
        # the logging module. Use a namespaced key to avoid the
        # collision.
        log.exception(
            "Contract metadata extraction raised unexpectedly; ignoring",
            extra={
                "upload_filename": filename,
                "upload_mime_type": mime_type,
            },
        )
        return ExtractedContractMetadata(warnings=["extractor_error"])


async def _safe_find_duplicates(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
    file_hash_sha256: str | None,
    suggested_title: str | None,
    counterparty_name: str | None,
    filename: str | None,
    exclude_contract_id: uuid.UUID | None = None,
    limit: int = DUP_DEFAULT_LIMIT,
) -> list[DuplicateCandidate]:
    """Run duplicate detection; never raise, never block the upload."""
    try:
        return await find_possible_duplicate_contracts(
            session,
            organization_id=organization_id,
            file_hash_sha256=file_hash_sha256,
            suggested_title=suggested_title,
            counterparty_name=counterparty_name,
            filename=filename,
            exclude_contract_id=exclude_contract_id,
            limit=limit,
        )
    except Exception:
        log.exception(
            "Duplicate-candidate lookup failed; returning empty",
            extra={"organization_id": str(organization_id)},
        )
        return []


def _metadata_response(meta: ExtractedContractMetadata) -> dict[str, Any]:
    """Project the extracted-metadata dataclass into a dict the response
    schema validates. Surfaces only the allowlisted suggestion fields.
    """
    return {
        "suggested_title": meta.suggested_title,
        "likely_contract_type": meta.likely_contract_type,
        "possible_counterparty_name": meta.possible_counterparty_name,
        "effective_date": meta.effective_date,
        "warnings": list(meta.warnings),
    }


def _duplicate_response(candidate: DuplicateCandidate) -> dict[str, Any]:
    """Project a ``DuplicateCandidate`` into the response shape. Only
    safe identifier fields appear — storage internals are not part of
    the dataclass to begin with.
    """
    return {
        "contract_id": candidate.contract_id,
        "title": candidate.title,
        "reason": candidate.reason,
        "confidence": candidate.confidence,
        "created_at": candidate.created_at,
        "status": candidate.status,
    }


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


_STORAGE_KEY_RE = re.compile(r"^documents/(?P<document_id>.+)\.enc$")


def _document_id_from_storage_key(storage_key: str) -> str | None:
    """Recover the document_id originally bound into AAD from a storage key.

    ``DocumentStorage._s3_key_for`` is the only writer of storage keys
    and uses ``documents/{document_id}.enc`` exclusively, so this
    inversion is exact and stable. Returns ``None`` for any key that
    doesn't match the convention so the caller can fall back to the
    legacy AAD.
    """
    m = _STORAGE_KEY_RE.match(storage_key)
    return m.group("document_id") if m is not None else None


def _send_filename(
    contract: Contract,
    *,
    artifact: ContractArtifact | None,
) -> str:
    """Pick a sensible filename to hand DocuSeal.

    Prefers the artifact's recorded filename (DOCX upload name or
    generated DOCX name) and falls back to a derived form of the
    contract title for legacy contracts.
    """
    if artifact is not None and artifact.filename:
        return artifact.filename[:180]
    return _download_filename(contract, artifact=artifact)


def _extract_submission_id(upstream: dict[str, object] | None) -> str | None:
    """Best-effort extraction of a DocuSeal submission id.

    DocuSeal's response shape varies by version (top-level ``id`` /
    ``submission_id`` / ``slug``). We take the first one that is a
    non-empty primitive and stringify it. ``None`` is fine: callers
    persist ``contract.docuseal_submission_id`` only when an id
    actually came back.
    """
    if not isinstance(upstream, dict):
        return None
    for key in ("submission_id", "id", "slug"):
        value = upstream.get(key)
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value)
    return None


def _extract_embed_url(upstream: dict[str, object] | None) -> str | None:
    """Pull a primary embed URL from the DocuSeal response, if any.

    Handles both the top-level ``embed_url`` shape and the
    ``submitters: [{embed_src: ...}]`` shape some DocuSeal versions
    return. We surface the first signer's embed URL so the frontend can
    render an inline signing flow without modeling per-signer URLs in
    this PR.
    """
    if not isinstance(upstream, dict):
        return None
    for key in ("embed_url", "embed_src"):
        value = upstream.get(key)
        if isinstance(value, str) and value.strip():
            return value
    submitters = upstream.get("submitters")
    if isinstance(submitters, list):
        for entry in submitters:
            if not isinstance(entry, dict):
                continue
            for key in ("embed_src", "embed_url"):
                value = entry.get(key)
                if isinstance(value, str) and value.strip():
                    return value
    return None


def _safe_upstream_projection(
    upstream: dict[str, object] | None,
) -> dict[str, object] | None:
    """Strip auth-bridge / token-shaped values from a DocuSeal payload.

    DocuSeal's response is largely public-shaped (submission ids, embed
    urls, signer emails), but we don't want a future DocuSeal version
    accidentally surfacing a ``token`` or ``secret`` field through our
    response. The blocklist is defensive — Whereas already mints its
    own short-lived JWT for the upstream call, so any token-shaped
    field coming back is something we don't want to reflect.
    """
    if not isinstance(upstream, dict):
        return None
    blocked = {
        "token",
        "access_token",
        "auth_token",
        "secret",
        "signing_secret",
        "api_key",
        "authorization",
    }
    cleaned: dict[str, object] = {}
    for key, value in upstream.items():
        if key.lower() in blocked:
            continue
        cleaned[key] = value
    return cleaned


def _audit_contract_details(
    contract: Contract,
    *,
    filename: str | None,
    artifact_id: uuid.UUID | None = None,
    artifact_type: str | None = None,
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
    if artifact_type is not None:
        details["artifact_type"] = artifact_type
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
    extracted_metadata: ExtractedContractMetadata | None = None,
    duplicate_candidates: Sequence[DuplicateCandidate] = (),
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
    data["extracted_metadata"] = (
        _metadata_response(extracted_metadata)
        if extracted_metadata is not None
        else None
    )
    data["duplicate_candidates"] = [
        _duplicate_response(c) for c in duplicate_candidates
    ]
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
