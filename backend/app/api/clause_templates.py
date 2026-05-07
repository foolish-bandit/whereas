from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Query, status
from sqlalchemy import select

from app.api.contracts import DbSession, _current_dev_user
from app.models import ClauseTemplate
from app.schemas.clause_templates import (
    ClauseTemplateCreateRequest,
    ClauseTemplateResponse,
    ClauseTemplateUpdateRequest,
)

router = APIRouter()


@router.post("", response_model=ClauseTemplateResponse, status_code=status.HTTP_201_CREATED)
async def create_clause_template(
    payload: ClauseTemplateCreateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ClauseTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    row = ClauseTemplate(organization_id=user.organization_id, **payload.model_dump())
    session.add(row)
    await session.flush()
    await session.refresh(row)
    return _to_response(row)


@router.get("", response_model=list[ClauseTemplateResponse])
async def list_clause_templates(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    clause_type: str | None = None,
    jurisdiction: str | None = None,
    contract_type: str | None = None,
    tag: str | None = None,
    include_inactive: bool = Query(default=False),
) -> list[ClauseTemplateResponse]:
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
    stmt = stmt.order_by(ClauseTemplate.updated_at.desc(), ClauseTemplate.id.desc())
    rows = (await session.execute(stmt)).scalars().all()
    return [_to_response(r) for r in rows]


@router.get("/{template_id}", response_model=ClauseTemplateResponse)
async def get_clause_template(
    template_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ClauseTemplateResponse:
    row = await _get_for_org(session, template_id, x_whereas_dev_user)
    return _to_response(row)


@router.patch("/{template_id}", response_model=ClauseTemplateResponse)
async def update_clause_template(
    template_id: uuid.UUID,
    payload: ClauseTemplateUpdateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ClauseTemplateResponse:
    row = await _get_for_org(session, template_id, x_whereas_dev_user)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, key, value)
    await session.flush()
    await session.refresh(row)
    return _to_response(row)


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_clause_template(
    template_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> None:
    row = await _get_for_org(session, template_id, x_whereas_dev_user)
    row.is_active = False
    await session.flush()


async def _get_for_org(session: DbSession, template_id: uuid.UUID, dev_user: str | None) -> ClauseTemplate:
    user = await _current_dev_user(session, dev_user)
    stmt = select(ClauseTemplate).where(
        ClauseTemplate.id == template_id,
        ClauseTemplate.organization_id == user.organization_id,
    )
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Clause template not found.")
    return row


def _to_response(row: ClauseTemplate) -> ClauseTemplateResponse:
    return ClauseTemplateResponse.model_validate(
        {
            "id": row.id,
            "organization_id": row.organization_id,
            "name": row.name,
            "clause_type": row.clause_type,
            "text": row.text,
            "description": row.description,
            "jurisdiction": row.jurisdiction,
            "contract_type": row.contract_type,
            "version": row.version,
            "source": row.source,
            "tags": list(row.tags or []),
            "is_active": row.is_active,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
    )
