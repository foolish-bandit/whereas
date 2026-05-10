"""Inbox item routes.

An ``InboxItem`` is the per-user work-queue surface. Items can point at
a request, a contract, or a template (or none for a free-floating
"general" task). Most items are auto-created — for example, every new
``ContractRequest`` produces a ``request_review`` item — but operators
can also create ``general`` items by hand for ad-hoc work.

This module deliberately stays narrow:

- No assignment-rule engine.
- No SLA / reminder scheduling.
- No mirror table for DocuSeal signer events.

DELETE soft-dismisses; ``include_dismissed=true`` is required to see
dismissed items.
"""
from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.contracts import DbSession, _current_dev_user
from app.models import (
    AgreementTemplate,
    Contract,
    ContractRequest,
    InboxItem,
    InboxItemStatus,
    User,
)
from app.schemas.inbox_items import (
    InboxItemCreateRequest,
    InboxItemResponse,
    InboxItemUpdateRequest,
)

log = logging.getLogger(__name__)

router = APIRouter()

_VALID_STATUSES = {s.value for s in InboxItemStatus}
# PR #50 — approval inbox items are driven by the approval workflow
# router. The generic inbox PATCH/DELETE endpoints refuse status /
# linkage edits on these so the linked ``ApprovalStep`` cannot decouple.
_APPROVAL_ITEM_TYPE = "approval"


@router.post("", response_model=InboxItemResponse, status_code=201)
async def create_inbox_item(
    payload: InboxItemCreateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> InboxItemResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    org_id = user.organization_id

    await _validate_links(
        session,
        org_id,
        request_id=payload.request_id,
        contract_id=payload.contract_id,
        template_id=payload.template_id,
    )
    if payload.assigned_to is not None:
        await _validate_user_in_org(session, payload.assigned_to, org_id)

    item = InboxItem(
        organization_id=org_id,
        title=payload.title,
        description=payload.description,
        item_type=payload.item_type,
        status=InboxItemStatus.OPEN.value,
        priority=payload.priority,
        assigned_to=payload.assigned_to,
        due_date=payload.due_date,
        request_id=payload.request_id,
        contract_id=payload.contract_id,
        template_id=payload.template_id,
        created_by=user.id,
        metadata_json=payload.metadata_json,
    )
    session.add(item)
    await session.flush()
    await session.refresh(item)
    return InboxItemResponse.model_validate(item)


@router.get("", response_model=list[InboxItemResponse])
async def list_inbox_items(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    status: str | None = None,
    item_type: str | None = None,
    priority: str | None = None,
    assigned_to: uuid.UUID | None = None,
    due_before: str | None = Query(default=None, description="ISO date (YYYY-MM-DD)."),
    due_after: str | None = Query(default=None, description="ISO date (YYYY-MM-DD)."),
    include_dismissed: bool = Query(default=False),
) -> list[InboxItemResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    stmt = select(InboxItem).where(
        InboxItem.organization_id == user.organization_id
    )
    if not include_dismissed:
        stmt = stmt.where(InboxItem.status != InboxItemStatus.DISMISSED.value)
    if status:
        if status not in _VALID_STATUSES:
            raise HTTPException(status_code=422, detail="Invalid status filter.")
        stmt = stmt.where(InboxItem.status == status)
    if item_type:
        stmt = stmt.where(InboxItem.item_type == item_type)
    if priority:
        stmt = stmt.where(InboxItem.priority == priority)
    if assigned_to is not None:
        stmt = stmt.where(InboxItem.assigned_to == assigned_to)
    if due_before:
        stmt = stmt.where(InboxItem.due_date <= _parse_date(due_before, "due_before"))
    if due_after:
        stmt = stmt.where(InboxItem.due_date >= _parse_date(due_after, "due_after"))

    stmt = stmt.order_by(InboxItem.created_at.desc(), InboxItem.id.desc())
    rows = (await session.execute(stmt)).scalars().all()
    return [InboxItemResponse.model_validate(r) for r in rows]


@router.get("/{item_id}", response_model=InboxItemResponse)
async def get_inbox_item(
    item_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> InboxItemResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    item = await _get_item_for_org(session, item_id, user.organization_id)
    return InboxItemResponse.model_validate(item)


@router.patch("/{item_id}", response_model=InboxItemResponse)
async def update_inbox_item(
    item_id: uuid.UUID,
    payload: InboxItemUpdateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> InboxItemResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    item = await _get_item_for_org(session, item_id, user.organization_id)

    data = payload.model_dump(exclude_unset=True)
    if "status" in data and data["status"] not in _VALID_STATUSES:
        raise HTTPException(status_code=422, detail="Invalid inbox item status.")

    # Approval inbox items are owned by the approval workflow router —
    # status / linkage transitions must go through approve/reject/cancel
    # so the underlying ``ApprovalStep`` stays in lockstep with the
    # work-queue surface. Edits to non-state fields (priority, due
    # date, assignee, description) are still allowed; the approval
    # step's ``PATCH .../steps/{id}`` endpoint mirrors title /
    # assignee / due_date back onto the linked inbox item, but
    # operators may also tweak presentation here without driving the
    # workflow.
    if (
        item.item_type == _APPROVAL_ITEM_TYPE
        and any(
            k in data
            for k in ("status", "request_id", "contract_id", "template_id", "item_type")
        )
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Approval inbox items are driven by the approval workflow. "
                "Use POST /api/approval-workflows/{id}/steps/{step_id}/approve "
                "or /reject, or PATCH /api/approval-workflows/{id}/cancel."
            ),
        )

    new_links = {
        "request_id": data.get("request_id", item.request_id),
        "contract_id": data.get("contract_id", item.contract_id),
        "template_id": data.get("template_id", item.template_id),
    }
    if any(k in data for k in ("request_id", "contract_id", "template_id")):
        await _validate_links(
            session,
            item.organization_id,
            request_id=new_links["request_id"],
            contract_id=new_links["contract_id"],
            template_id=new_links["template_id"],
        )
    if "assigned_to" in data and data["assigned_to"] is not None:
        await _validate_user_in_org(
            session, data["assigned_to"], item.organization_id
        )

    for key, value in data.items():
        setattr(item, key, value)

    await session.flush()
    await session.refresh(item)
    return InboxItemResponse.model_validate(item)


@router.delete("/{item_id}", status_code=204)
async def dismiss_inbox_item(
    item_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> None:
    """Soft delete: marks the inbox item as ``dismissed``.

    Approval items must go through the approval workflow router so the
    underlying ``ApprovalStep`` doesn't decouple from its inbox row.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    item = await _get_item_for_org(session, item_id, user.organization_id)
    if item.item_type == _APPROVAL_ITEM_TYPE:
        raise HTTPException(
            status_code=409,
            detail=(
                "Approval inbox items cannot be dismissed directly. "
                "Reject the step or cancel the workflow via "
                "/api/approval-workflows."
            ),
        )
    item.status = InboxItemStatus.DISMISSED.value
    await session.flush()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_item_for_org(
    session: AsyncSession,
    item_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> InboxItem:
    stmt = select(InboxItem).where(
        InboxItem.id == item_id,
        InboxItem.organization_id == organization_id,
    )
    item = (await session.execute(stmt)).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=404, detail="Inbox item not found.")
    return item


async def _validate_links(
    session: AsyncSession,
    organization_id: uuid.UUID,
    *,
    request_id: uuid.UUID | None,
    contract_id: uuid.UUID | None,
    template_id: uuid.UUID | None,
) -> None:
    if request_id is not None:
        stmt = select(ContractRequest.id).where(
            ContractRequest.id == request_id,
            ContractRequest.organization_id == organization_id,
        )
        if (await session.execute(stmt)).scalar_one_or_none() is None:
            raise HTTPException(
                status_code=422,
                detail="Linked request must belong to the same organization.",
            )
    if contract_id is not None:
        stmt = select(Contract.id).where(
            Contract.id == contract_id,
            Contract.organization_id == organization_id,
        )
        if (await session.execute(stmt)).scalar_one_or_none() is None:
            raise HTTPException(
                status_code=422,
                detail="Linked contract must belong to the same organization.",
            )
    if template_id is not None:
        stmt = select(AgreementTemplate.id).where(
            AgreementTemplate.id == template_id,
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


def _parse_date(value: str, field_name: str):
    from datetime import date

    try:
        return date.fromisoformat(value)
    except ValueError as e:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid date for {field_name}; expected YYYY-MM-DD.",
        ) from e
