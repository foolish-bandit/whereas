"""Approval workflow template routes (PR #51 — reusable approval blueprints).

A workflow template is a reusable blueprint, distinct from a concrete
``ApprovalWorkflowRun``. Instantiation copies the template's step rows
into concrete ``ApprovalStep`` rows on a new run; only the run carries
``InboxItem`` links. Editing a template never mutates an in-flight run.

Naming: the path parameter is intentionally ``template_id`` (the workflow
template) and the optional ``AgreementTemplate`` (document blueprint) link
is spelled ``agreement_template_id`` in the instantiate body so the two
template concepts never collide.

Deliberately narrow:

- No conditional logic, no parallel approvals.
- No SLA / calendar reminders.
- No DocuSeal auto-send.
- Mutations on the template do not propagate to existing runs.
- Archived templates cannot be instantiated.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.approval_workflows import (
    _create_inbox_item_for_step,
    _load_run_response,
    _validate_links,
    _validate_user_in_org,
)
from app.api.contracts import DbSession, _current_dev_user
from app.models import (
    ApprovalStep,
    ApprovalStepStatus,
    ApprovalWorkflowRun,
    ApprovalWorkflowRunStatus,
    ApprovalWorkflowTemplate,
    ApprovalWorkflowTemplateStatus,
    ApprovalWorkflowTemplateStep,
)
from app.schemas.approval_workflow_templates import (
    ApprovalWorkflowTemplateCreate,
    ApprovalWorkflowTemplatePatch,
    ApprovalWorkflowTemplateResponse,
    ApprovalWorkflowTemplateStepCreate,
    ApprovalWorkflowTemplateStepPatch,
    ApprovalWorkflowTemplateStepResponse,
    CreateApprovalWorkflowFromTemplateRequest,
)
from app.schemas.approval_workflows import ApprovalWorkflowRunResponse

log = logging.getLogger(__name__)

router = APIRouter()

_VALID_STATUSES = {s.value for s in ApprovalWorkflowTemplateStatus}


# ---------------------------------------------------------------------------
# Template CRUD
# ---------------------------------------------------------------------------


@router.post("", response_model=ApprovalWorkflowTemplateResponse, status_code=201)
async def create_workflow_template(
    payload: ApprovalWorkflowTemplateCreate,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    org_id = user.organization_id

    for step in payload.steps:
        if step.assigned_to is not None:
            await _validate_user_in_org(session, step.assigned_to, org_id)

    if await _name_taken(session, org_id, payload.name):
        raise HTTPException(
            status_code=409,
            detail="A workflow template with that name already exists.",
        )

    template = ApprovalWorkflowTemplate(
        organization_id=org_id,
        name=payload.name,
        description=payload.description,
        template_type=payload.template_type,
        status=ApprovalWorkflowTemplateStatus.ACTIVE.value,
        created_by=user.id,
        metadata_json=payload.metadata_json,
    )
    session.add(template)
    await session.flush()

    for index, step_payload in enumerate(payload.steps, start=1):
        order = step_payload.step_order if step_payload.step_order is not None else index
        session.add(
            ApprovalWorkflowTemplateStep(
                organization_id=org_id,
                workflow_template_id=template.id,
                step_order=order,
                title=step_payload.title,
                description=step_payload.description,
                approver_name=step_payload.approver_name,
                approver_email=step_payload.approver_email,
                assigned_to=step_payload.assigned_to,
                due_in_days=step_payload.due_in_days,
                metadata_json=step_payload.metadata_json,
            )
        )
    await session.flush()
    return await _load_template_response(session, template.id, org_id)


@router.get("", response_model=list[ApprovalWorkflowTemplateResponse])
async def list_workflow_templates(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    status: str | None = None,
    template_type: str | None = None,
    include_archived: bool = Query(default=False),
    query: str | None = Query(default=None, description="Case-insensitive name match."),
) -> list[ApprovalWorkflowTemplateResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    stmt = (
        select(ApprovalWorkflowTemplate)
        .where(ApprovalWorkflowTemplate.organization_id == user.organization_id)
        .options(selectinload(ApprovalWorkflowTemplate.steps))
    )
    if status is not None:
        if status not in _VALID_STATUSES:
            raise HTTPException(status_code=422, detail="Invalid status filter.")
        stmt = stmt.where(ApprovalWorkflowTemplate.status == status)
    elif not include_archived:
        stmt = stmt.where(
            ApprovalWorkflowTemplate.status
            == ApprovalWorkflowTemplateStatus.ACTIVE.value
        )
    if template_type:
        stmt = stmt.where(ApprovalWorkflowTemplate.template_type == template_type)
    if query:
        like = f"%{query.strip().lower()}%"
        stmt = stmt.where(ApprovalWorkflowTemplate.name.ilike(like))
    stmt = stmt.order_by(
        ApprovalWorkflowTemplate.updated_at.desc(),
        ApprovalWorkflowTemplate.id.desc(),
    )
    rows = (await session.execute(stmt)).scalars().unique().all()
    return [ApprovalWorkflowTemplateResponse.model_validate(r) for r in rows]


@router.get(
    "/{template_id}", response_model=ApprovalWorkflowTemplateResponse
)
async def get_workflow_template(
    template_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    return await _load_template_response(session, template_id, user.organization_id)


@router.patch(
    "/{template_id}", response_model=ApprovalWorkflowTemplateResponse
)
async def update_workflow_template(
    template_id: uuid.UUID,
    payload: ApprovalWorkflowTemplatePatch,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowTemplateResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(
        session, template_id, user.organization_id
    )

    data = payload.model_dump(exclude_unset=True)
    if (
        "status" in data
        and data["status"] is not None
        and data["status"] not in _VALID_STATUSES
    ):
        raise HTTPException(status_code=422, detail="Invalid status value.")
    if (
        "name" in data
        and data["name"] is not None
        and data["name"] != template.name
        and await _name_taken(
            session, user.organization_id, data["name"], exclude_id=template.id
        )
    ):
        raise HTTPException(
            status_code=409,
            detail="A workflow template with that name already exists.",
        )
    for key, value in data.items():
        setattr(template, key, value)
    await session.flush()
    return await _load_template_response(
        session, template.id, user.organization_id
    )


@router.delete(
    "/{template_id}", response_model=ApprovalWorkflowTemplateResponse
)
async def archive_workflow_template(
    template_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowTemplateResponse:
    """Soft-archive a template. Existing runs are not touched."""
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(
        session, template_id, user.organization_id
    )
    template.status = ApprovalWorkflowTemplateStatus.ARCHIVED.value
    await session.flush()
    return await _load_template_response(
        session, template.id, user.organization_id
    )


# ---------------------------------------------------------------------------
# Template steps
# ---------------------------------------------------------------------------


@router.post(
    "/{template_id}/steps",
    response_model=ApprovalWorkflowTemplateStepResponse,
    status_code=201,
)
async def add_template_step(
    template_id: uuid.UUID,
    payload: ApprovalWorkflowTemplateStepCreate,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowTemplateStepResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(
        session, template_id, user.organization_id
    )
    if payload.assigned_to is not None:
        await _validate_user_in_org(
            session, payload.assigned_to, user.organization_id
        )

    existing = await _load_template_steps(session, template.id)
    if payload.step_order is None:
        order = (existing[-1].step_order + 1) if existing else 1
    else:
        order = payload.step_order
        if any(s.step_order == order for s in existing):
            raise HTTPException(
                status_code=409,
                detail="step_order is already in use by another step.",
            )

    step = ApprovalWorkflowTemplateStep(
        organization_id=user.organization_id,
        workflow_template_id=template.id,
        step_order=order,
        title=payload.title,
        description=payload.description,
        approver_name=payload.approver_name,
        approver_email=payload.approver_email,
        assigned_to=payload.assigned_to,
        due_in_days=payload.due_in_days,
        metadata_json=payload.metadata_json,
    )
    session.add(step)
    await session.flush()
    await session.refresh(step)
    return ApprovalWorkflowTemplateStepResponse.model_validate(step)


@router.patch(
    "/{template_id}/steps/{step_id}",
    response_model=ApprovalWorkflowTemplateStepResponse,
)
async def update_template_step(
    template_id: uuid.UUID,
    step_id: uuid.UUID,
    payload: ApprovalWorkflowTemplateStepPatch,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowTemplateStepResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(
        session, template_id, user.organization_id
    )
    step = await _get_template_step(session, template.id, step_id)

    data = payload.model_dump(exclude_unset=True)
    if "assigned_to" in data and data["assigned_to"] is not None:
        await _validate_user_in_org(
            session, data["assigned_to"], user.organization_id
        )
    if (
        "step_order" in data
        and data["step_order"] is not None
        and data["step_order"] != step.step_order
    ):
        existing = await _load_template_steps(session, template.id)
        if any(
            s.step_order == data["step_order"] and s.id != step.id
            for s in existing
        ):
            raise HTTPException(
                status_code=409,
                detail="step_order is already in use by another step.",
            )
    for key, value in data.items():
        setattr(step, key, value)
    await session.flush()
    await session.refresh(step)
    return ApprovalWorkflowTemplateStepResponse.model_validate(step)


@router.delete(
    "/{template_id}/steps/{step_id}",
    response_model=ApprovalWorkflowTemplateResponse,
)
async def delete_template_step(
    template_id: uuid.UUID,
    step_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowTemplateResponse:
    """Delete a step and renumber the remaining steps to stay 1..n.

    Renumbering keeps the template's ``step_order`` values dense, which
    matches how ``ApprovalStep.step_order`` is used at instantiation time
    (``current_step_order = first_step.step_order``).

    Refuses (409) to delete the only remaining step: a zero-step
    template is not instantiable, and ``create_workflow_template``
    requires at least one step. Blocking this here keeps the invariant
    ``len(steps) >= 1`` true for the lifetime of the template, so a
    pre-existing template can't silently rot into an unusable state via
    repeated deletes.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    template = await _get_template_for_org(
        session, template_id, user.organization_id
    )
    step = await _get_template_step(session, template.id, step_id)

    existing = await _load_template_steps(session, template.id)
    if len(existing) <= 1:
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot delete the last remaining step; a template must "
                "have at least one step. Add another step first, or "
                "archive the template."
            ),
        )

    await session.delete(step)
    await session.flush()

    remaining = await _load_template_steps(session, template.id)
    for index, row in enumerate(remaining, start=1):
        if row.step_order != index:
            row.step_order = index
    await session.flush()
    return await _load_template_response(
        session, template.id, user.organization_id
    )


# ---------------------------------------------------------------------------
# Instantiation
# ---------------------------------------------------------------------------


@router.post(
    "/{template_id}/instantiate",
    response_model=ApprovalWorkflowRunResponse,
    status_code=201,
)
async def instantiate_workflow_template(
    template_id: uuid.UUID,
    payload: CreateApprovalWorkflowFromTemplateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowRunResponse:
    """Create a concrete ``ApprovalWorkflowRun`` from a template.

    Copies template steps into concrete ``ApprovalStep`` rows. Only the
    first step gets an ``InboxItem``; later steps activate when the
    prior step is approved (this matches the existing ad-hoc flow).
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    org_id = user.organization_id

    template = await _get_template_for_org(session, template_id, org_id)
    if template.status != ApprovalWorkflowTemplateStatus.ACTIVE.value:
        raise HTTPException(
            status_code=409,
            detail="Archived workflow templates cannot be instantiated.",
        )

    template_steps = await _load_template_steps(session, template.id)
    if not template_steps:
        # Defense in depth: create-template requires >= 1 step, but a
        # template can be left empty if every step was deleted.
        raise HTTPException(
            status_code=409,
            detail=(
                "Workflow template has no steps; add at least one step "
                "before instantiating."
            ),
        )

    await _validate_links(
        session,
        org_id,
        request_id=payload.request_id,
        contract_id=payload.contract_id,
        template_id=payload.agreement_template_id,
    )

    metadata: dict[str, Any] = dict(payload.metadata_json or {})
    metadata.update(
        {
            "source_workflow_template_id": str(template.id),
            "source_workflow_template_name": template.name,
        }
    )

    run = ApprovalWorkflowRun(
        organization_id=org_id,
        name=payload.name,
        status=ApprovalWorkflowRunStatus.ACTIVE.value,
        request_id=payload.request_id,
        contract_id=payload.contract_id,
        template_id=payload.agreement_template_id,
        current_step_order=template_steps[0].step_order,
        created_by=user.id,
        metadata_json=metadata,
    )
    session.add(run)
    await session.flush()

    today = _today_utc()
    step_rows: list[ApprovalStep] = []
    for tmpl_step in template_steps:
        due = (
            today + timedelta(days=tmpl_step.due_in_days)
            if tmpl_step.due_in_days is not None
            else None
        )
        concrete = ApprovalStep(
            organization_id=org_id,
            workflow_run_id=run.id,
            step_order=tmpl_step.step_order,
            title=tmpl_step.title,
            description=tmpl_step.description,
            approver_name=tmpl_step.approver_name,
            approver_email=tmpl_step.approver_email,
            assigned_to=tmpl_step.assigned_to,
            status=ApprovalStepStatus.PENDING.value,
            due_date=due,
            metadata_json=tmpl_step.metadata_json,
        )
        session.add(concrete)
        step_rows.append(concrete)
    await session.flush()

    first_step = step_rows[0]
    inbox = await _create_inbox_item_for_step(
        session, run=run, step=first_step, user_id=user.id
    )
    first_step.inbox_item_id = inbox.id
    await session.flush()
    return await _load_run_response(session, run.id, org_id)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _today_utc() -> date:
    return datetime.now(UTC).date()


async def _name_taken(
    session: AsyncSession,
    organization_id: uuid.UUID,
    name: str,
    *,
    exclude_id: uuid.UUID | None = None,
) -> bool:
    stmt = select(ApprovalWorkflowTemplate.id).where(
        ApprovalWorkflowTemplate.organization_id == organization_id,
        ApprovalWorkflowTemplate.name == name,
    )
    if exclude_id is not None:
        stmt = stmt.where(ApprovalWorkflowTemplate.id != exclude_id)
    return (await session.execute(stmt)).scalar_one_or_none() is not None


async def _get_template_for_org(
    session: AsyncSession,
    template_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ApprovalWorkflowTemplate:
    stmt = select(ApprovalWorkflowTemplate).where(
        ApprovalWorkflowTemplate.id == template_id,
        ApprovalWorkflowTemplate.organization_id == organization_id,
    )
    template = (await session.execute(stmt)).scalar_one_or_none()
    if template is None:
        raise HTTPException(
            status_code=404,
            detail="Approval workflow template not found.",
        )
    return template


async def _load_template_response(
    session: AsyncSession,
    template_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ApprovalWorkflowTemplateResponse:
    stmt = (
        select(ApprovalWorkflowTemplate)
        .where(
            ApprovalWorkflowTemplate.id == template_id,
            ApprovalWorkflowTemplate.organization_id == organization_id,
        )
        .options(selectinload(ApprovalWorkflowTemplate.steps))
    )
    template = (await session.execute(stmt)).scalar_one_or_none()
    if template is None:
        raise HTTPException(
            status_code=404,
            detail="Approval workflow template not found.",
        )
    return ApprovalWorkflowTemplateResponse.model_validate(template)


async def _load_template_steps(
    session: AsyncSession, template_id: uuid.UUID
) -> list[ApprovalWorkflowTemplateStep]:
    # Ordered by step_order; id is a deterministic tie-break that only
    # matters mid-update (the (workflow_template_id, step_order) unique
    # constraint guarantees no permanent ties), but using it makes the
    # transient state during a renumber observable in a stable order.
    stmt = (
        select(ApprovalWorkflowTemplateStep)
        .where(ApprovalWorkflowTemplateStep.workflow_template_id == template_id)
        .order_by(
            ApprovalWorkflowTemplateStep.step_order.asc(),
            ApprovalWorkflowTemplateStep.id.asc(),
        )
    )
    return list((await session.execute(stmt)).scalars().all())


async def _get_template_step(
    session: AsyncSession,
    template_id: uuid.UUID,
    step_id: uuid.UUID,
) -> ApprovalWorkflowTemplateStep:
    stmt = select(ApprovalWorkflowTemplateStep).where(
        ApprovalWorkflowTemplateStep.id == step_id,
        ApprovalWorkflowTemplateStep.workflow_template_id == template_id,
    )
    step = (await session.execute(stmt)).scalar_one_or_none()
    if step is None:
        raise HTTPException(
            status_code=404, detail="Approval workflow template step not found."
        )
    return step
