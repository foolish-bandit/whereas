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

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.contracts import (
    DbSession,
    _current_dev_user,
    _load_org_key_or_http,
    _load_organization,
)
from app.core.config import get_settings
from app.models import (
    AgreementTemplate,
    Contract,
    ContractRequest,
    ContractRequestStatus,
    InboxItem,
    InboxItemStatus,
    User,
)
from app.schemas.artifacts import ContractArtifactResponse
from app.schemas.contracts import ContractListItemResponse
from app.schemas.markdown import ContractMarkdownSnapshotResponse
from app.schemas.requests import (
    ContractRequestCreateRequest,
    ContractRequestResponse,
    ContractRequestUpdateRequest,
    ConvertRequestToContractRequest,
    ConvertRequestToContractResponse,
)
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
