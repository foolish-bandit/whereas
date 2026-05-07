from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models import ClauseTemplate, User
from app.schemas.clause_templates import (
    ClauseTemplateCreateRequest,
    ClauseTemplateResponse,
    ClauseTemplateUpdateRequest,
)

router = APIRouter()
DbSession = Annotated[AsyncSession, Depends(get_db)]


@router.post("", response_model=ClauseTemplateResponse, status_code=201)
async def create_clause_template(payload: ClauseTemplateCreateRequest, session: DbSession, x_whereas_dev_user: Annotated[str | None, Header()] = None) -> ClauseTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    row = ClauseTemplate(organization_id=user.organization_id, **payload.model_dump())
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return row


@router.get("", response_model=list[ClauseTemplateResponse])
async def list_clause_templates(session: DbSession, x_whereas_dev_user: Annotated[str | None, Header()] = None, clause_type: str | None = None, jurisdiction: str | None = None, contract_type: str | None = None, tag: str | None = None, include_inactive: bool = False) -> list[ClauseTemplateResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    stmt = select(ClauseTemplate).where(ClauseTemplate.organization_id == user.organization_id)
    if not include_inactive:
        stmt = stmt.where(ClauseTemplate.is_active.is_(True))
    if clause_type:
        stmt = stmt.where(ClauseTemplate.clause_type == clause_type)
    if jurisdiction:
        stmt = stmt.where(ClauseTemplate.jurisdiction == jurisdiction)
    if contract_type:
        stmt = stmt.where(ClauseTemplate.contract_type == contract_type)
    if tag:
        stmt = stmt.where(ClauseTemplate.tags.is_not(None), ClauseTemplate.tags.contains([tag]))
    stmt = stmt.order_by(ClauseTemplate.created_at.desc(), ClauseTemplate.id.desc())
    result = await session.execute(stmt)
    return list(result.scalars())


@router.get("/{template_id}", response_model=ClauseTemplateResponse)
async def get_clause_template(template_id: uuid.UUID, session: DbSession, x_whereas_dev_user: Annotated[str | None, Header()] = None, include_inactive: bool = False) -> ClauseTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    row = await _get_for_org(session, template_id, user.organization_id)
    if not include_inactive and not row.is_active:
        raise HTTPException(status_code=404, detail="Clause template not found.")
    return row


@router.patch("/{template_id}", response_model=ClauseTemplateResponse)
async def update_clause_template(template_id: uuid.UUID, payload: ClauseTemplateUpdateRequest, session: DbSession, x_whereas_dev_user: Annotated[str | None, Header()] = None) -> ClauseTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    row = await _get_for_org(session, template_id, user.organization_id)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    await session.flush()
    await session.refresh(row)
    return row


@router.delete("/{template_id}", response_model=ClauseTemplateResponse)
async def deactivate_clause_template(template_id: uuid.UUID, session: DbSession, x_whereas_dev_user: Annotated[str | None, Header()] = None) -> ClauseTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    row = await _get_for_org(session, template_id, user.organization_id)
    row.is_active = False
    await session.flush()
    await session.refresh(row)
    return row


async def _current_dev_user(session: AsyncSession, header_value: str | None) -> User:
    if not header_value:
        raise HTTPException(status_code=401, detail="Missing X-Whereas-Dev-User header.")
    try:
        user_id = uuid.UUID(header_value)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid X-Whereas-Dev-User header.") from exc
    result = await session.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail="User not found.")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="User is inactive.")
    return user


async def _get_for_org(session: AsyncSession, template_id: uuid.UUID, organization_id: uuid.UUID) -> ClauseTemplate:
    result = await session.execute(select(ClauseTemplate).where(ClauseTemplate.id == template_id, ClauseTemplate.organization_id == organization_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Clause template not found.")
    return row
