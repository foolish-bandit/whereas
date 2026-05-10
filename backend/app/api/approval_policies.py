from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.contracts import DbSession, _current_dev_user
from app.models import (
    AgreementTemplate,
    ApprovalPolicy,
    ApprovalPolicyStatus,
    ApprovalWorkflowTemplate,
)
from app.schemas.approval_policies import (
    ApprovalPolicyCreate,
    ApprovalPolicyPatch,
    ApprovalPolicyResponse,
)

router = APIRouter()
_VALID = {s.value for s in ApprovalPolicyStatus}


@router.post("", response_model=ApprovalPolicyResponse, status_code=201)
async def create_policy(
    payload: ApprovalPolicyCreate,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalPolicyResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    await _validate_links(
        session,
        user.organization_id,
        payload.workflow_template_id,
        payload.agreement_template_id,
    )
    if await _name_taken(session, user.organization_id, payload.name):
        raise HTTPException(
            status_code=409,
            detail="An approval policy with that name already exists.",
        )
    row = ApprovalPolicy(
        organization_id=user.organization_id,
        created_by=user.id,
        status=ApprovalPolicyStatus.ACTIVE.value,
        **payload.model_dump(),
    )
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return await _to_response(session, row)


@router.get("", response_model=list[ApprovalPolicyResponse])
async def list_policies(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    status: str | None = None,
    include_archived: bool = False,
    request_type: str | None = None,
    contract_type: str | None = None,
    priority: str | None = None,
    workflow_template_id: uuid.UUID | None = None,
) -> list[ApprovalPolicyResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    stmt = select(ApprovalPolicy).where(
        ApprovalPolicy.organization_id == user.organization_id
    )
    if status:
        if status not in _VALID:
            raise HTTPException(status_code=422, detail="Invalid status filter.")
        stmt = stmt.where(ApprovalPolicy.status == status)
    elif not include_archived:
        stmt = stmt.where(ApprovalPolicy.status == ApprovalPolicyStatus.ACTIVE.value)
    if request_type:
        stmt = stmt.where(ApprovalPolicy.request_type == request_type)
    if contract_type:
        stmt = stmt.where(ApprovalPolicy.contract_type == contract_type)
    if priority:
        stmt = stmt.where(ApprovalPolicy.priority == priority)
    if workflow_template_id:
        stmt = stmt.where(ApprovalPolicy.workflow_template_id == workflow_template_id)
    rows = (
        await session.execute(
            stmt.order_by(ApprovalPolicy.updated_at.desc(), ApprovalPolicy.id.desc())
        )
    ).scalars().all()
    return [await _to_response(session, row) for row in rows]


@router.get("/{policy_id}", response_model=ApprovalPolicyResponse)
async def get_policy(
    policy_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalPolicyResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    row = await _get_for_org(session, policy_id, user.organization_id)
    return await _to_response(session, row)


@router.patch("/{policy_id}", response_model=ApprovalPolicyResponse)
async def patch_policy(
    policy_id: uuid.UUID,
    payload: ApprovalPolicyPatch,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalPolicyResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    row = await _get_for_org(session, policy_id, user.organization_id)
    data = payload.model_dump(exclude_unset=True)
    if "status" in data and data["status"] not in _VALID:
        raise HTTPException(status_code=422, detail="Invalid status value.")
    if (
        "name" in data
        and data["name"] != row.name
        and await _name_taken(session, user.organization_id, data["name"], row.id)
    ):
        raise HTTPException(
            status_code=409,
            detail="An approval policy with that name already exists.",
        )
    await _validate_links(
        session,
        user.organization_id,
        data.get("workflow_template_id", row.workflow_template_id),
        data.get("agreement_template_id", row.agreement_template_id),
    )
    for key, value in data.items():
        setattr(row, key, value)
    await session.flush()
    return await _to_response(session, row)


@router.delete("/{policy_id}", response_model=ApprovalPolicyResponse)
async def archive_policy(
    policy_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalPolicyResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    row = await _get_for_org(session, policy_id, user.organization_id)
    row.status = ApprovalPolicyStatus.ARCHIVED.value
    await session.flush()
    return await _to_response(session, row)


async def _get_for_org(
    session: AsyncSession, policy_id: uuid.UUID, org_id: uuid.UUID
) -> ApprovalPolicy:
    row = (
        await session.execute(
            select(ApprovalPolicy).where(
                ApprovalPolicy.id == policy_id,
                ApprovalPolicy.organization_id == org_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Approval policy not found.")
    return row


async def _name_taken(
    session: AsyncSession,
    org_id: uuid.UUID,
    name: str,
    exclude_id: uuid.UUID | None = None,
) -> bool:
    stmt = select(ApprovalPolicy.id).where(
        ApprovalPolicy.organization_id == org_id,
        ApprovalPolicy.name == name,
    )
    if exclude_id is not None:
        stmt = stmt.where(ApprovalPolicy.id != exclude_id)
    return (await session.execute(stmt.limit(1))).scalar_one_or_none() is not None


async def _validate_links(
    session: AsyncSession,
    org_id: uuid.UUID,
    workflow_template_id: uuid.UUID,
    agreement_template_id: uuid.UUID | None,
) -> None:
    template = (
        await session.execute(
            select(ApprovalWorkflowTemplate.id).where(
                ApprovalWorkflowTemplate.id == workflow_template_id,
                ApprovalWorkflowTemplate.organization_id == org_id,
            )
        )
    ).scalar_one_or_none()
    if template is None:
        raise HTTPException(
            status_code=422,
            detail="workflow_template_id must belong to your organization.",
        )
    if agreement_template_id is None:
        return
    agreement = (
        await session.execute(
            select(AgreementTemplate.id).where(
                AgreementTemplate.id == agreement_template_id,
                AgreementTemplate.organization_id == org_id,
            )
        )
    ).scalar_one_or_none()
    if agreement is None:
        raise HTTPException(
            status_code=422,
            detail="agreement_template_id must belong to your organization.",
        )


async def _to_response(
    session: AsyncSession, row: ApprovalPolicy
) -> ApprovalPolicyResponse:
    workflow_template_name = (
        await session.execute(
            select(ApprovalWorkflowTemplate.name).where(
                ApprovalWorkflowTemplate.id == row.workflow_template_id
            )
        )
    ).scalar_one_or_none()
    response = ApprovalPolicyResponse.model_validate(row)
    response.workflow_template_name = workflow_template_name
    return response
