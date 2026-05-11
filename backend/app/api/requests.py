"""Contract request routes.

A ``ContractRequest`` is the intake/business workflow object: someone in
the org asks for a contract (new NDA, MSA, amendment, renewal, ...) and
the request is tracked through to ``completed`` or ``cancelled``. This
module deliberately stays narrow:

- No approval workflow engine.
- No automatic request-to-contract generation.
- No calendar/reminder integration.

Creating a request also creates one open ``request_review`` ``InboxItem``
in the same transaction so the request is discoverable in the work
queue without polling. Updating a request to ``completed`` or
``cancelled`` resolves the linked open ``request_review`` items in the
same flow.

Linked contract / template IDs must belong to the same organization;
cross-org references are rejected with 422.
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.contracts import (
    DbSession,
    _choose_title,
    _current_dev_user,
    _duplicate_response,
    _load_org_key_or_http,
    _load_organization,
    _metadata_response,
    _parse_or_http,
    _safe_extract_metadata,
    _safe_find_duplicates,
    _safe_input_filename,
    _validate_upload,
)
from app.core.config import get_settings
from app.models import (
    AgreementTemplate,
    ApprovalStep,
    ApprovalWorkflowRun,
    ApprovalWorkflowRunStatus,
    Contract,
    ContractArtifact,
    ContractRequest,
    ContractRequestStatus,
    ContractStatus,
    InboxItem,
    InboxItemStatus,
    User,
)
from app.schemas.activity import ActivityTimelineResponse
from app.schemas.artifacts import ContractArtifactResponse
from app.schemas.contracts import ContractListItemResponse
from app.schemas.markdown import ContractMarkdownSnapshotResponse
from app.schemas.request_approval_status import (
    RequestApprovalPolicySummary,
    RequestApprovalStatusResponse,
    RequestApprovalStepSummary,
    RequestApprovalSummary,
    RequestApprovalWorkflowSummary,
)
from app.schemas.requests import (
    ContractRequestCreateRequest,
    ContractRequestResponse,
    ContractRequestUpdateRequest,
    ConvertRequestToContractRequest,
    ConvertRequestToContractResponse,
    ConvertRequestUploadResponse,
)
from app.security.audit_log import AuditEventType, record_event
from app.services import activity_export, activity_timeline
from app.services.approval_gating import can_send_contract_to_docuseal
from app.services.approval_policies import (
    apply_approval_policies_to_request,
    find_matching_approval_policies,
)
from app.services.document_markdown import create_markdown_snapshot_for_contract
from app.services.storage import DocumentStorage
from app.services.template_generation import (
    TemplateGenerationError,
    generate_docx_from_template,
)

log = logging.getLogger(__name__)

router = APIRouter()

_VALID_STATUSES = {s.value for s in ContractRequestStatus}
_TERMINAL_STATUSES = {
    ContractRequestStatus.COMPLETED.value,
    ContractRequestStatus.CANCELLED.value,
}


@router.post("", response_model=ContractRequestResponse, status_code=201)
async def create_request(
    payload: ContractRequestCreateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractRequestResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    org_id = user.organization_id

    await _validate_links(session, org_id, payload.linked_contract_id, payload.linked_template_id)
    if payload.assigned_to is not None:
        await _validate_user_in_org(session, payload.assigned_to, org_id)

    request = ContractRequest(
        organization_id=org_id,
        title=payload.title,
        description=payload.description,
        request_type=payload.request_type,
        contract_type=payload.contract_type,
        status=ContractRequestStatus.OPEN.value,
        priority=payload.priority,
        requester_name=payload.requester_name,
        requester_email=payload.requester_email,
        counterparty_name=payload.counterparty_name,
        due_date=payload.due_date,
        assigned_to=payload.assigned_to,
        linked_contract_id=payload.linked_contract_id,
        linked_template_id=payload.linked_template_id,
        created_by=user.id,
        metadata_json=payload.metadata_json,
    )
    session.add(request)
    await session.flush()

    # Auto-create the corresponding work-queue item in the same
    # transaction. If the inbox insert fails the request insert is
    # rolled back too — they belong together.
    inbox_item = InboxItem(
        organization_id=org_id,
        title=f"Review request: {request.title}",
        item_type="request_review",
        status=InboxItemStatus.OPEN.value,
        priority=request.priority,
        assigned_to=request.assigned_to,
        due_date=request.due_date,
        request_id=request.id,
        created_by=user.id,
    )
    session.add(inbox_item)
    await session.flush()
    await apply_approval_policies_to_request(session, request, user.id)
    await session.refresh(request)

    return ContractRequestResponse.model_validate(request)


@router.get("", response_model=list[ContractRequestResponse])
async def list_requests(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    status: str | None = None,
    request_type: str | None = None,
    contract_type: str | None = None,
    priority: str | None = None,
    assigned_to: uuid.UUID | None = None,
    due_before: str | None = Query(default=None, description="ISO date (YYYY-MM-DD)."),
    due_after: str | None = Query(default=None, description="ISO date (YYYY-MM-DD)."),
    include_cancelled: bool = Query(default=False),
) -> list[ContractRequestResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    stmt = select(ContractRequest).where(
        ContractRequest.organization_id == user.organization_id
    )
    if not include_cancelled:
        stmt = stmt.where(
            ContractRequest.status != ContractRequestStatus.CANCELLED.value
        )
    if status:
        if status not in _VALID_STATUSES:
            raise HTTPException(status_code=422, detail="Invalid status filter.")
        stmt = stmt.where(ContractRequest.status == status)
    if request_type:
        stmt = stmt.where(ContractRequest.request_type == request_type)
    if contract_type:
        stmt = stmt.where(ContractRequest.contract_type == contract_type)
    if priority:
        stmt = stmt.where(ContractRequest.priority == priority)
    if assigned_to is not None:
        stmt = stmt.where(ContractRequest.assigned_to == assigned_to)
    if due_before:
        stmt = stmt.where(ContractRequest.due_date <= _parse_date(due_before, "due_before"))
    if due_after:
        stmt = stmt.where(ContractRequest.due_date >= _parse_date(due_after, "due_after"))

    stmt = stmt.order_by(
        ContractRequest.created_at.desc(), ContractRequest.id.desc()
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [ContractRequestResponse.model_validate(r) for r in rows]


@router.get("/{request_id}", response_model=ContractRequestResponse)
async def get_request(
    request_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractRequestResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(session, request_id, user.organization_id)
    return ContractRequestResponse.model_validate(request)


@router.patch("/{request_id}", response_model=ContractRequestResponse)
async def update_request(
    request_id: uuid.UUID,
    payload: ContractRequestUpdateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractRequestResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(session, request_id, user.organization_id)

    data = payload.model_dump(exclude_unset=True)

    if "status" in data and data["status"] not in _VALID_STATUSES:
        raise HTTPException(status_code=422, detail="Invalid request status.")

    new_links = {
        "linked_contract_id": data.get(
            "linked_contract_id", request.linked_contract_id
        ),
        "linked_template_id": data.get(
            "linked_template_id", request.linked_template_id
        ),
    }
    if (
        "linked_contract_id" in data
        or "linked_template_id" in data
    ):
        await _validate_links(
            session,
            request.organization_id,
            new_links["linked_contract_id"],
            new_links["linked_template_id"],
        )
    if "assigned_to" in data and data["assigned_to"] is not None:
        await _validate_user_in_org(
            session, data["assigned_to"], request.organization_id
        )

    for key, value in data.items():
        setattr(request, key, value)

    await session.flush()

    policy_fields = {"request_type", "contract_type", "priority", "linked_template_id"}
    if any(k in data for k in policy_fields):
        await apply_approval_policies_to_request(session, request, user.id)

    # If this update transitions the request to a terminal state, mark
    # any open ``request_review`` inbox items pointing at it as
    # completed/dismissed in the same transaction. Item-level edits
    # (assignee, due date, priority) are intentionally NOT mirrored: the
    # inbox item is its own work record once it exists.
    if "status" in data and request.status in _TERMINAL_STATUSES:
        await _resolve_request_review_inbox_items(session, request)

    await session.refresh(request)
    return ContractRequestResponse.model_validate(request)


@router.delete("/{request_id}", status_code=204)
async def cancel_request(
    request_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> None:
    """Soft delete: marks the request as ``cancelled`` and dismisses
    any open ``request_review`` inbox items that pointed at it.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(session, request_id, user.organization_id)
    request.status = ContractRequestStatus.CANCELLED.value
    await session.flush()
    await _resolve_request_review_inbox_items(session, request)


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------


@router.post(
    "/{request_id}/convert-to-contract",
    response_model=ConvertRequestToContractResponse,
    status_code=201,
)
async def convert_request_to_contract(
    request_id: uuid.UUID,
    payload: ConvertRequestToContractRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ConvertRequestToContractResponse:
    """Convert an open request into a draft Contract via its linked template.

    Reuses ``generate_docx_from_template`` from the agreement-templates
    surface so there is exactly one code path that turns a template +
    variable values into a draft Contract + ``generated_docx`` artifact.
    On success we link the new Contract back onto the request, mark the
    request ``completed``, and resolve any open ``request_review`` inbox
    item in the same transaction.

    Validation rules:
      * The request must belong to the caller's org (404 otherwise).
      * The request must not be cancelled (409).
      * The request must not already have a linked contract (409).
      * The request must have a linked template (409); that template
        must belong to the same org (404 otherwise — guarded by the
        same-org invariant on creation, but defended again here).
        Archived templates ARE still convertible — once a request
        links to a template the link survives template archive. This
        matches the link semantics on creation/update (see
        ``_validate_links``) and avoids stranding requests when a
        template is retired between intake and conversion.
      * Variable validation errors propagate from the generation
        service as 400 (unknown / missing required / malformed value).

    Failure semantics:
      * If template generation raises, no request/inbox state mutates.
        ``get_db`` rolls the whole request-scoped transaction back.
      * Markdown conversion failure is non-fatal — the response still
        succeeds with ``markdown_snapshot=None``.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(
        session, request_id, user.organization_id
    )

    if request.status == ContractRequestStatus.CANCELLED.value:
        raise HTTPException(
            status_code=409,
            detail="Cancelled requests cannot be converted to a contract.",
        )
    if request.linked_contract_id is not None:
        raise HTTPException(
            status_code=409,
            detail="This request is already linked to a contract.",
        )
    if request.linked_template_id is None:
        raise HTTPException(
            status_code=409,
            detail="Link an agreement template to this request before converting.",
        )

    template_stmt = select(AgreementTemplate).where(
        AgreementTemplate.id == request.linked_template_id,
        AgreementTemplate.organization_id == request.organization_id,
    )
    template = (await session.execute(template_stmt)).scalar_one_or_none()
    if template is None:
        # The link survived (e.g. the template was archived/deleted, or
        # a stale row predates the same-org invariant). Treat this as a
        # not-found from the caller's perspective rather than leaking
        # the orphan state.
        raise HTTPException(
            status_code=404,
            detail="Linked agreement template not found.",
        )

    settings = get_settings()
    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)
    storage = DocumentStorage(settings)
    try:
        result = await generate_docx_from_template(
            session,
            template=template,
            variable_values=payload.variable_values,
            generated_title=payload.title,
            user_id=user.id,
            org_master_key=org_master_key,
            storage=storage,
        )
    except TemplateGenerationError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail=str(exc)
        ) from exc
    finally:
        del org_master_key

    # Link the new contract back to the request and close out the
    # workflow. Doing this in the same session/transaction means a
    # failure here rolls the generation back too: we never end up with
    # a Contract that has no request pointing at it OR a request that
    # claims a contract id that doesn't exist.
    request.linked_contract_id = result.contract.id
    request.status = ContractRequestStatus.COMPLETED.value
    await session.flush()
    await _resolve_request_review_inbox_items(session, request)

    await session.refresh(request)
    await session.refresh(result.contract)
    await session.refresh(result.artifact)
    snapshot_response: ContractMarkdownSnapshotResponse | None = None
    if result.markdown_snapshot is not None:
        await session.refresh(result.markdown_snapshot)
        snapshot_response = ContractMarkdownSnapshotResponse.model_validate(
            result.markdown_snapshot
        )
    return ConvertRequestToContractResponse(
        request=ContractRequestResponse.model_validate(request),
        contract=ContractListItemResponse.model_validate(result.contract),
        artifact=ContractArtifactResponse.model_validate(result.artifact),
        markdown_snapshot=snapshot_response,
        variables_used=result.variables_used,
    )


@router.post(
    "/{request_id}/convert-upload",
    response_model=ConvertRequestUploadResponse,
    status_code=201,
)
async def convert_request_by_upload(
    request_id: uuid.UUID,
    session: DbSession,
    file: Annotated[UploadFile, File()],
    title: Annotated[str | None, Form()] = None,
    counterparty_name: Annotated[str | None, Form()] = None,
    contract_type: Annotated[str | None, Form()] = None,
    notes: Annotated[str | None, Form()] = None,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ConvertRequestUploadResponse:
    """Convert an open request into a Repository contract by uploading a file.

    This is the third-party / counterparty-paper intake path. It sits
    alongside ``/convert-to-contract`` (the template-generation path):
    the request is the same workflow object, the resulting Contract is
    the same downstream Repository row, but the source of the agreement
    text is an uploaded DOCX or PDF instead of a rendered template.

    Behavior:

    * Validate / parse the upload via the same helpers
      ``/api/contracts/upload`` uses. Unsupported extensions / MIME
      mismatches / empty / oversized files surface the same 4xx codes.
    * Store the encrypted file via ``DocumentStorage``.
    * Create a ``Contract`` row + ``original_upload`` ``ContractArtifact``
      whose ``source='request_upload'`` and ``metadata_json`` carries
      ``request_id`` and ``upload_source='request_conversion'``.
    * Best-effort Markdown snapshot via the same converter the upload
      flow uses. Failure is non-fatal — the conversion still succeeds.
    * Link the new contract back to the request, mark the request
      ``completed``, and resolve any open ``request_review`` inbox item
      in the same transaction.

    Validation rules:

    * Cross-org request → 404 (via ``_get_request_for_org``).
    * Cancelled request → 409.
    * Already-converted request (``linked_contract_id`` set) → 409.
    * File validation errors propagate from ``_validate_upload`` /
      ``_parse_or_http`` as 400/413/422.

    Failure semantics:

    * The whole operation runs in a single request-scoped transaction
      (``get_db``). A failure at any DB step rolls back the partial
      Contract / artifact insert *and* leaves the request row
      unchanged. Storage success without DB commit only leaves an
      orphan blob in S3 — which is preferable to a half-written
      Contract row that's missing its official artifact, matching the
      existing ``/contracts/upload`` posture.
    * Markdown conversion failure is non-fatal — the response still
      succeeds with ``markdown_snapshot=None``.

    Approval gate / policy matching:

    * No approval workflows are auto-created here beyond what the
      existing request lifecycle already wires up. The linked
      ``Contract`` flows through the existing DocuSeal gate via the
      request's matching policies. The gate / state-transition logic
      is unchanged by this PR.

    Storage / privacy:

    * The response carries ``ContractArtifactResponse`` and
      ``ContractListItemResponse`` — both forbid ``storage_key`` and
      ``wrapped_dek`` by construction (``extra='forbid'`` with
      allowlist-only fields). Audit details mirror the upload route's
      shape and never include the storage key, wrapped DEK, or raw
      bytes.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(
        session, request_id, user.organization_id
    )

    if request.status == ContractRequestStatus.CANCELLED.value:
        raise HTTPException(
            status_code=409,
            detail="Cancelled requests cannot be converted to a contract.",
        )
    if request.linked_contract_id is not None:
        raise HTTPException(
            status_code=409,
            detail="This request is already linked to a contract.",
        )

    settings = get_settings()
    filename = _safe_input_filename(file.filename)
    file_bytes = await file.read()
    # ``_validate_upload`` enforces non-empty, size, extension, magic
    # bytes, and content-type alignment. Errors propagate as 400/413
    # which matches /api/contracts/upload exactly.
    mime_type = _validate_upload(
        filename=filename,
        content_type=file.content_type,
        file_bytes=file_bytes,
        max_bytes=settings.CONTRACT_UPLOAD_MAX_BYTES,
    )
    file_hash = hashlib.sha256(file_bytes).hexdigest()
    parsed = _parse_or_http(file_bytes=file_bytes, filename=filename)

    # PR #66 — deterministic, best-effort metadata extraction. We honor
    # the user's explicit ``title`` first, then the extractor's
    # ``suggested_title``, then the filename-derived fallback. Failure
    # is non-fatal; an empty result still produces a usable response.
    extracted_metadata = _safe_extract_metadata(
        filename=filename,
        mime_type=mime_type,
        markdown_text=None,
        plain_text=parsed.full_text,
    )
    contract_title = _choose_title(title, extracted_metadata, filename)

    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)

    contract = Contract(
        organization_id=user.organization_id,
        uploaded_by=user.id,
        title=contract_title,
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
        # ``get_db`` rolls the session back on the resulting HTTPException
        # so the half-written Contract row does not persist. The S3 blob
        # — if anything was written — is orphan, which is preferable to
        # a Contract row that has no original_upload artifact.
        raise HTTPException(
            status_code=500,
            detail="Could not store encrypted document.",
        ) from e
    finally:
        del org_master_key

    contract.s3_key = stored.s3_key
    contract.wrapped_dek = stored.wrapped_dek_bytes
    # No extraction step in the conversion path — match the
    # template-generation conversion route, which also lands at READY
    # without running metadata extraction. Users who want extraction
    # can run it from the contract workspace later.
    contract.status = ContractStatus.READY.value
    await session.flush()

    artifact_metadata: dict[str, object] = {
        "request_id": str(request.id),
        "upload_source": "request_conversion",
    }
    notes_clean = (notes or "").strip()
    if notes_clean:
        artifact_metadata["notes"] = notes_clean[:1000]
    # Counterparty precedence: explicit form > request.counterparty_name
    # > extractor suggestion. We persist whichever wins to the artifact
    # so users can see what the upload thought it was about, but we
    # never overwrite the request row itself.
    counterparty_clean = _choose_string(
        (counterparty_name or "").strip(),
        (request.counterparty_name or "").strip(),
        extracted_metadata.possible_counterparty_name,
        cap=255,
    )
    if counterparty_clean:
        artifact_metadata["counterparty_name"] = counterparty_clean
    contract_type_clean = _choose_string(
        (contract_type or "").strip(),
        (request.contract_type or "").strip(),
        extracted_metadata.likely_contract_type,
        cap=64,
    )
    if contract_type_clean:
        artifact_metadata["contract_type"] = contract_type_clean
    if extracted_metadata.effective_date is not None:
        artifact_metadata["effective_date"] = (
            extracted_metadata.effective_date.isoformat()
        )

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
        source="request_upload",
        is_official=True,
        created_by=user.id,
        metadata_json=artifact_metadata,
    )
    session.add(original_artifact)
    await session.flush()

    # Best-effort markdown snapshot — failure is logged but does not
    # fail the conversion. Same behavior as ``/api/contracts/upload``.
    try:
        snapshot = await create_markdown_snapshot_for_contract(
            session,
            contract=contract,
            file_bytes=file_bytes,
            fallback_plain_text=parsed.full_text,
            actor_user_id=user.id,
        )
    except Exception:
        log.exception(
            "Markdown snapshot creation failed; conversion continues",
            extra={"contract_id": str(contract.id)},
        )
        snapshot = None

    # PR #66 — warning-level duplicate candidates. Computed AFTER the
    # contract row is added so we can ``exclude_contract_id`` and not
    # match the upload-in-progress against itself. Failure is
    # non-fatal: the conversion still succeeds with an empty list.
    duplicate_candidates = await _safe_find_duplicates(
        session,
        organization_id=user.organization_id,
        file_hash_sha256=file_hash,
        suggested_title=extracted_metadata.suggested_title,
        counterparty_name=counterparty_clean
        or extracted_metadata.possible_counterparty_name,
        filename=filename,
        exclude_contract_id=contract.id,
    )

    # Link the new contract back to the request and close out the
    # workflow. Same-transaction guarantee: if anything below fails the
    # contract + artifact + snapshot inserts roll back too — we never
    # end up with a Contract that has no request pointing at it OR a
    # request that claims a contract id that doesn't exist.
    request.linked_contract_id = contract.id
    request.status = ContractRequestStatus.COMPLETED.value
    await session.flush()
    await _resolve_request_review_inbox_items(session, request)

    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.REQUEST_CONVERTED_BY_UPLOAD,
        actor_user_id=user.id,
        target_type="request",
        target_id=str(request.id),
        details={
            "request_id": str(request.id),
            "contract_id": str(contract.id),
            "artifact_id": str(original_artifact.id),
            "filename": filename,
            "mime_type": mime_type,
            "file_hash_sha256": file_hash,
            "size_bytes": len(file_bytes),
        },
    )

    await session.refresh(request)
    await session.refresh(contract)
    await session.refresh(original_artifact)
    snapshot_response: ContractMarkdownSnapshotResponse | None = None
    if snapshot is not None:
        await session.refresh(snapshot)
        snapshot_response = ContractMarkdownSnapshotResponse.model_validate(
            snapshot
        )
    return ConvertRequestUploadResponse(
        request=ContractRequestResponse.model_validate(request),
        contract=ContractListItemResponse.model_validate(contract),
        artifact=ContractArtifactResponse.model_validate(original_artifact),
        markdown_snapshot=snapshot_response,
        extracted_metadata=_metadata_response(extracted_metadata),
        duplicate_candidates=[
            _duplicate_response(c) for c in duplicate_candidates
        ],
    )


# ---------------------------------------------------------------------------
# Approval visibility (PR #56)
#
# Read-only stitch of policies + workflow runs + the gate result for a
# single request. Reuses ``find_matching_approval_policies`` and
# ``can_send_contract_to_docuseal`` so the answer here cannot drift away
# from the live gate; the UI uses this to render badges / step lists /
# blocking reasons on the Requests page without flipping between pages.
# ---------------------------------------------------------------------------


# Plain-English phrasing for each gate code so every client renders the
# same string. Codes themselves come from ``approval_gating.ApprovalGateResult``;
# extending that enum requires extending this map (covered by tests).
_GATE_REASON_TEXT: dict[str, str] = {
    "active_approval_workflows": (
        "An approval workflow is still active and waiting on a decision."
    ),
    "rejected_approval_workflows": (
        "An approval workflow was rejected; resolve or restart before sending."
    ),
    "required_approval_policy_unmet": (
        "A required approval policy has not been satisfied."
    ),
    "cancelled_without_completed_approval": (
        "All attached approval workflows were cancelled without a completed approval."
    ),
}


@router.get(
    "/{request_id}/approval-status",
    response_model=RequestApprovalStatusResponse,
)
async def get_request_approval_status(
    request_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> RequestApprovalStatusResponse:
    """Return matching policies + attached workflows + a gate-aligned summary.

    Visibility only — never mutates state, never auto-creates workflows.
    Cross-org access returns 404 (via ``_get_request_for_org``). Storage
    internals are excluded by construction: every nested response model
    sets ``extra="forbid"`` and only allowlists scalar fields.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(
        session, request_id, user.organization_id
    )

    # Policies that match this request *as it stands today*. We pass
    # ``applies_to_generated_contracts=None`` so the visibility surface
    # shows every match — not just the ones the gate cares about — so a
    # user can see, for example, an internal-only policy that's
    # auto-attaching a workflow even though it doesn't gate signature.
    matching_policies = await find_matching_approval_policies(session, request)

    # Workflow runs attached to this request and (if applicable) the
    # linked contract. Cross-org rows are filtered by the same
    # ``organization_id`` constraint used everywhere else.
    workflow_stmt = (
        select(ApprovalWorkflowRun)
        .where(
            ApprovalWorkflowRun.organization_id == request.organization_id,
            _workflow_links_request(request),
        )
        .order_by(
            ApprovalWorkflowRun.started_at.asc(),
            ApprovalWorkflowRun.id.asc(),
        )
    )
    workflow_rows = (
        (await session.execute(workflow_stmt)).scalars().unique().all()
    )

    # Bulk-load steps for the runs we found so the response is one
    # query for the run set + one query for all steps.
    workflow_ids = [w.id for w in workflow_rows]
    steps_by_run: dict[uuid.UUID, list[ApprovalStep]] = {
        wid: [] for wid in workflow_ids
    }
    if workflow_ids:
        step_stmt = (
            select(ApprovalStep)
            .where(ApprovalStep.workflow_run_id.in_(workflow_ids))
            .order_by(
                ApprovalStep.workflow_run_id.asc(),
                ApprovalStep.step_order.asc(),
                ApprovalStep.id.asc(),
            )
        )
        for step in (await session.execute(step_stmt)).scalars().all():
            steps_by_run.setdefault(step.workflow_run_id, []).append(step)

    workflow_summaries = [
        _build_workflow_summary(w, steps_by_run.get(w.id, []))
        for w in workflow_rows
    ]
    policy_summaries = [
        RequestApprovalPolicySummary.model_validate(p) for p in matching_policies
    ]

    summary = await _build_approval_summary(
        session, request, matching_policies, workflow_rows
    )

    return RequestApprovalStatusResponse(
        request_id=request.id,
        linked_contract_id=request.linked_contract_id,
        matching_policy_ids=[p.id for p in matching_policies],
        matching_policies=policy_summaries,
        workflow_runs=workflow_summaries,
        summary=summary,
    )


@router.get(
    "/{request_id}/activity",
    response_model=ActivityTimelineResponse,
)
async def get_request_activity(
    request_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    limit: int = Query(
        default=activity_timeline.DEFAULT_LIMIT,
        ge=1,
        le=activity_timeline.MAX_LIMIT,
        description=(
            "Max number of timeline items to return. Default "
            f"{activity_timeline.DEFAULT_LIMIT}, hard-capped at "
            f"{activity_timeline.MAX_LIMIT}."
        ),
    ),
) -> ActivityTimelineResponse:
    """Chronological activity feed for a request.

    Visibility-only: assembled from existing ``AuditEvent`` rows. Cross-org
    access returns 404 (via ``_get_request_for_org``). Storage internals
    cannot leak — every nested item model uses ``extra="forbid"`` and only
    allowlisted scalar fields are projected from each audit row's
    ``details``.

    The timeline starts recording approval events at PR #58. Older
    workflow runs and step decisions that happened before this PR have
    no audit rows and will not appear; existing DocuSeal send /
    completion audit events from PR #44 / PR #45 are surfaced if they
    point at this request's linked contract.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(
        session, request_id, user.organization_id
    )
    items = await activity_timeline.load_request_activity(
        session, request, limit=limit
    )
    return ActivityTimelineResponse(items=items)


@router.get("/{request_id}/activity/export")
async def export_request_activity(
    request_id: uuid.UUID,
    session: DbSession,
    export_format: str = Query(
        default="csv",
        alias="format",
        description="Export format: 'csv' or 'json'.",
    ),
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> Response:
    """Download the request's activity timeline as CSV or JSON (PR #75).

    Reuses the same sanitized projection as ``GET /activity`` — the
    timeline service decides which audit detail keys are exposed; this
    handler only formats that projection into bytes. Storage internals,
    raw audit details, document bytes, signer PII, and DocuSeal
    payloads cannot leak through this path.

    Cross-org / missing requests return 404 via ``_get_request_for_org``.
    Unsupported ``?format=`` values return 422.
    """
    fmt = export_format.lower().strip()
    if fmt not in activity_export.SUPPORTED_FORMATS:
        raise HTTPException(
            status_code=422,
            detail="Unsupported export format. Use 'csv' or 'json'.",
        )

    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(session, request_id, user.organization_id)
    items = await activity_timeline.load_request_activity(
        session,
        request,
        limit=activity_timeline.EXPORT_MAX_LIMIT,
        max_cap=activity_timeline.EXPORT_MAX_LIMIT,
    )

    filename = activity_export.export_filename(
        subject_type="request",
        subject_id=request.id,
        fmt=fmt,  # type: ignore[arg-type]
    )

    # Audit the export. Safe details only — subject id, format, count.
    # The exported content is not recorded. The new event type sits
    # outside the timeline's surfaced event-type list so a request
    # export doesn't appear inside the timeline it produced.
    await record_event(
        session,
        organization_id=user.organization_id,
        event_type=AuditEventType.REQUEST_ACTIVITY_EXPORTED,
        actor_user_id=user.id,
        target_type="request",
        target_id=str(request.id),
        details={
            "request_id": str(request.id),
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
        subject_type="request",
        subject_id=request.id,
        items=items,
    )
    return JSONResponse(
        content=envelope,
        media_type=activity_export.JSON_MEDIA_TYPE,
        headers=headers,
    )


def _workflow_links_request(request: ContractRequest):
    """``workflow_run_id == request_id OR workflow_run.contract_id == linked_contract_id``.

    Split out so the query can short-circuit cleanly when there's no
    linked contract — most requests don't have one.
    """
    from sqlalchemy import or_

    if request.linked_contract_id is None:
        return ApprovalWorkflowRun.request_id == request.id
    return or_(
        ApprovalWorkflowRun.request_id == request.id,
        ApprovalWorkflowRun.contract_id == request.linked_contract_id,
    )


def _build_workflow_summary(
    run: ApprovalWorkflowRun,
    steps: list[ApprovalStep],
) -> RequestApprovalWorkflowSummary:
    metadata = run.metadata_json or {}
    source_id_raw = metadata.get("source_approval_policy_id")
    source_id: uuid.UUID | None = None
    if isinstance(source_id_raw, str):
        try:
            source_id = uuid.UUID(source_id_raw)
        except (TypeError, ValueError):
            # Bad metadata shouldn't break the visibility surface — fall
            # back to None and let the UI render "ad-hoc workflow".
            source_id = None
    source_name = metadata.get("source_approval_policy_name")
    if not isinstance(source_name, str):
        source_name = None
    return RequestApprovalWorkflowSummary(
        id=run.id,
        name=run.name,
        status=run.status,
        current_step_order=run.current_step_order,
        started_at=run.started_at,
        completed_at=run.completed_at,
        source_approval_policy_id=source_id,
        source_approval_policy_name=source_name,
        steps=[RequestApprovalStepSummary.model_validate(s) for s in steps],
    )


async def _build_approval_summary(
    session: AsyncSession,
    request: ContractRequest,
    matching_policies: list,
    workflow_rows: list[ApprovalWorkflowRun],
) -> RequestApprovalSummary:
    has_required_policies = any(
        p.applies_to_generated_contracts for p in matching_policies
    )
    statuses = [w.status for w in workflow_rows]
    has_active = ApprovalWorkflowRunStatus.ACTIVE.value in statuses
    has_rejected = ApprovalWorkflowRunStatus.REJECTED.value in statuses
    has_completed = ApprovalWorkflowRunStatus.COMPLETED.value in statuses

    # Whether every required-gate policy has at least one completed
    # policy-derived workflow. Mirrors the gate logic exactly so the UI
    # cannot disagree with the actual send decision.
    completed_policy_ids = {
        str((w.metadata_json or {}).get("source_approval_policy_id"))
        for w in workflow_rows
        if w.status == ApprovalWorkflowRunStatus.COMPLETED.value
    }
    required_policy_ids_str = {
        str(p.id) for p in matching_policies if p.applies_to_generated_contracts
    }
    all_required_completed = required_policy_ids_str.issubset(completed_policy_ids)

    ready_for_signature: bool | None = None
    blocking_reason: str | None = None
    if request.linked_contract_id is not None:
        contract = (
            await session.execute(
                select(Contract).where(
                    Contract.id == request.linked_contract_id,
                    Contract.organization_id == request.organization_id,
                )
            )
        ).scalar_one_or_none()
        if contract is not None:
            gate = await can_send_contract_to_docuseal(
                session, contract, request.organization_id
            )
            ready_for_signature = gate.allowed
            if not gate.allowed:
                blocking_reason = gate.code

    if blocking_reason is None and ready_for_signature is None:
        # No linked contract: derive a soft blocker for the UI even
        # though the gate wasn't consulted. Don't claim "ready" in this
        # branch — there's nothing to send yet.
        if has_active:
            blocking_reason = "active_approval_workflows"
        elif has_rejected:
            blocking_reason = "rejected_approval_workflows"
        elif has_required_policies and not all_required_completed:
            blocking_reason = "required_approval_policy_unmet"

    return RequestApprovalSummary(
        has_required_policies=has_required_policies,
        has_active_workflows=has_active,
        has_rejected_workflows=has_rejected,
        has_completed_workflows=has_completed,
        all_required_policy_workflows_completed=all_required_completed,
        ready_for_signature=ready_for_signature,
        blocking_reason=blocking_reason,
        blocking_reason_text=_GATE_REASON_TEXT.get(blocking_reason)
        if blocking_reason
        else None,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_request_for_org(
    session: AsyncSession,
    request_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ContractRequest:
    stmt = select(ContractRequest).where(
        ContractRequest.id == request_id,
        ContractRequest.organization_id == organization_id,
    )
    request = (await session.execute(stmt)).scalar_one_or_none()
    if request is None:
        raise HTTPException(status_code=404, detail="Contract request not found.")
    return request


async def _validate_links(
    session: AsyncSession,
    organization_id: uuid.UUID,
    linked_contract_id: uuid.UUID | None,
    linked_template_id: uuid.UUID | None,
) -> None:
    if linked_contract_id is not None:
        stmt = select(Contract.id).where(
            Contract.id == linked_contract_id,
            Contract.organization_id == organization_id,
        )
        if (await session.execute(stmt)).scalar_one_or_none() is None:
            raise HTTPException(
                status_code=422,
                detail="Linked contract must belong to the same organization.",
            )
    if linked_template_id is not None:
        stmt = select(AgreementTemplate.id).where(
            AgreementTemplate.id == linked_template_id,
            AgreementTemplate.organization_id == organization_id,
        )
        if (await session.execute(stmt)).scalar_one_or_none() is None:
            raise HTTPException(
                status_code=422,
                detail="Linked template must belong to the same organization.",
            )


async def _validate_user_in_org(
    session: AsyncSession,
    user_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> None:
    stmt = select(User.id).where(
        User.id == user_id, User.organization_id == organization_id
    )
    if (await session.execute(stmt)).scalar_one_or_none() is None:
        raise HTTPException(
            status_code=422,
            detail="Assigned user must belong to the same organization.",
        )


async def _resolve_request_review_inbox_items(
    session: AsyncSession,
    request: ContractRequest,
) -> None:
    new_status = (
        InboxItemStatus.DISMISSED.value
        if request.status == ContractRequestStatus.CANCELLED.value
        else InboxItemStatus.COMPLETED.value
    )
    stmt = select(InboxItem).where(
        InboxItem.request_id == request.id,
        InboxItem.organization_id == request.organization_id,
        InboxItem.item_type == "request_review",
        InboxItem.status == InboxItemStatus.OPEN.value,
    )
    rows = (await session.execute(stmt)).scalars().all()
    for item in rows:
        item.status = new_status
    if rows:
        await session.flush()


def _parse_date(value: str, field_name: str):
    from datetime import date

    try:
        return date.fromisoformat(value)
    except ValueError as e:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid date for {field_name}; expected YYYY-MM-DD.",
        ) from e


def _choose_string(*candidates: str | None, cap: int) -> str | None:
    """First non-empty candidate, trimmed to ``cap`` chars.

    Used by the convert-upload path to express the
    "form > request > extractor" precedence in a single line without
    five layered conditionals. ``None`` and empty strings are skipped.
    """
    for value in candidates:
        if value is None:
            continue
        stripped = value.strip() if isinstance(value, str) else value
        if stripped:
            return stripped[:cap]
    return None
