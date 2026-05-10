"""Approval workflow routes (PR #50 — narrow approval foundation).

A workflow run is a concrete approval process attached to a request
and/or a contract. It carries an ordered list of approval steps; only
one step is "current" at a time. Each pending step's assignee finds it
through a linked ``InboxItem`` (``item_type='approval'``).

This module is intentionally narrow:

- No parallel approvals.
- No conditional branching.
- No SLA / calendar reminders.
- No auto-send to DocuSeal on approval.
- No mutation of the linked request/contract status (documented as a
  follow-up).

Step progression:

- Creating the workflow creates step rows ``1..n`` and one ``approval``
  inbox item for step 1 only.
- Approving the current step closes its inbox item and (if there's a
  next step) opens an inbox item for the next step. If there is no next
  step the workflow flips to ``completed``.
- Rejecting the current step rejects the workflow, marks remaining
  pending steps ``skipped``, and dismisses the linked inbox item.
- Cancelling the workflow dismisses any open approval inbox items
  pointing at it and skips remaining pending steps.

Cross-org access returns 404. Linked request/contract/template must
belong to the same org as the caller (422 otherwise).
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.contracts import DbSession, _current_dev_user
from app.models import (
    AgreementTemplate,
    ApprovalStep,
    ApprovalStepStatus,
    ApprovalWorkflowRun,
    ApprovalWorkflowRunStatus,
    Contract,
    ContractRequest,
    InboxItem,
    InboxItemStatus,
    User,
)
from app.schemas.approval_workflows import (
    ApprovalStepDecisionRequest,
    ApprovalStepResponse,
    ApprovalStepUpdateRequest,
    ApprovalWorkflowRunCreate,
    ApprovalWorkflowRunListItem,
    ApprovalWorkflowRunResponse,
)

log = logging.getLogger(__name__)

router = APIRouter()

_RUN_STATUSES = {s.value for s in ApprovalWorkflowRunStatus}
_TERMINAL_RUN_STATUSES = {
    ApprovalWorkflowRunStatus.COMPLETED.value,
    ApprovalWorkflowRunStatus.REJECTED.value,
    ApprovalWorkflowRunStatus.CANCELLED.value,
}
_DECIDED_STEP_STATUSES = {
    ApprovalStepStatus.APPROVED.value,
    ApprovalStepStatus.REJECTED.value,
    ApprovalStepStatus.SKIPPED.value,
}


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


@router.post("", response_model=ApprovalWorkflowRunResponse, status_code=201)
async def create_workflow(
    payload: ApprovalWorkflowRunCreate,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowRunResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    org_id = user.organization_id

    await _validate_links(
        session,
        org_id,
        request_id=payload.request_id,
        contract_id=payload.contract_id,
        template_id=payload.template_id,
    )
    for step in payload.steps:
        if step.assigned_to is not None:
            await _validate_user_in_org(session, step.assigned_to, org_id)

    run = ApprovalWorkflowRun(
        organization_id=org_id,
        name=payload.name,
        status=ApprovalWorkflowRunStatus.ACTIVE.value,
        request_id=payload.request_id,
        contract_id=payload.contract_id,
        template_id=payload.template_id,
        current_step_order=1,
        created_by=user.id,
        metadata_json=payload.metadata_json,
    )
    session.add(run)
    await session.flush()

    step_rows: list[ApprovalStep] = []
    for index, step_payload in enumerate(payload.steps, start=1):
        step = ApprovalStep(
            organization_id=org_id,
            workflow_run_id=run.id,
            step_order=index,
            title=step_payload.title,
            description=step_payload.description,
            approver_name=step_payload.approver_name,
            approver_email=step_payload.approver_email,
            assigned_to=step_payload.assigned_to,
            status=ApprovalStepStatus.PENDING.value,
            due_date=step_payload.due_date,
            metadata_json=step_payload.metadata_json,
        )
        session.add(step)
        step_rows.append(step)
    await session.flush()

    # Inbox item for the first step only — later steps activate when the
    # prior step is approved.
    first_step = step_rows[0]
    inbox = await _create_inbox_item_for_step(
        session, run=run, step=first_step, user_id=user.id
    )
    first_step.inbox_item_id = inbox.id
    await session.flush()

    return await _load_run_response(session, run.id, org_id)


# ---------------------------------------------------------------------------
# List + detail
# ---------------------------------------------------------------------------


@router.get("", response_model=list[ApprovalWorkflowRunListItem])
async def list_workflows(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    status: str | None = None,
    request_id: uuid.UUID | None = None,
    contract_id: uuid.UUID | None = None,
    include_terminal: bool = Query(
        default=True,
        description=(
            "Include workflows in completed/rejected/cancelled state. "
            "Defaults to true so users can see their full history."
        ),
    ),
) -> list[ApprovalWorkflowRunListItem]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    stmt = select(ApprovalWorkflowRun).where(
        ApprovalWorkflowRun.organization_id == user.organization_id
    )
    if status:
        if status not in _RUN_STATUSES:
            raise HTTPException(status_code=422, detail="Invalid status filter.")
        stmt = stmt.where(ApprovalWorkflowRun.status == status)
    elif not include_terminal:
        stmt = stmt.where(
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.ACTIVE.value
        )
    if request_id is not None:
        stmt = stmt.where(ApprovalWorkflowRun.request_id == request_id)
    if contract_id is not None:
        stmt = stmt.where(ApprovalWorkflowRun.contract_id == contract_id)

    stmt = stmt.order_by(
        ApprovalWorkflowRun.created_at.desc(), ApprovalWorkflowRun.id.desc()
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [ApprovalWorkflowRunListItem.model_validate(r) for r in rows]


@router.get("/{workflow_id}", response_model=ApprovalWorkflowRunResponse)
async def get_workflow(
    workflow_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowRunResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    return await _load_run_response(session, workflow_id, user.organization_id)


# ---------------------------------------------------------------------------
# Cancel
# ---------------------------------------------------------------------------


@router.patch(
    "/{workflow_id}/cancel", response_model=ApprovalWorkflowRunResponse
)
async def cancel_workflow(
    workflow_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowRunResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    run = await _get_run_for_org(session, workflow_id, user.organization_id)

    if run.status in _TERMINAL_RUN_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Workflow is already {run.status}; "
                "cannot cancel a terminal workflow."
            ),
        )

    now = _utcnow()
    run.status = ApprovalWorkflowRunStatus.CANCELLED.value
    run.completed_at = now

    steps = await _load_steps(session, run.id)
    for step in steps:
        if step.status == ApprovalStepStatus.PENDING.value:
            step.status = ApprovalStepStatus.SKIPPED.value
            step.decided_at = now
            await _resolve_step_inbox_item(
                session, step, InboxItemStatus.DISMISSED.value
            )

    await session.flush()
    return await _load_run_response(session, run.id, run.organization_id)


# ---------------------------------------------------------------------------
# Step decisions
# ---------------------------------------------------------------------------


@router.post(
    "/{workflow_id}/steps/{step_id}/approve",
    response_model=ApprovalWorkflowRunResponse,
)
async def approve_step(
    workflow_id: uuid.UUID,
    step_id: uuid.UUID,
    payload: ApprovalStepDecisionRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowRunResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    run, step = await _load_run_and_step(
        session, workflow_id, step_id, user.organization_id
    )

    _ensure_step_decidable(run, step)

    now = _utcnow()
    step.status = ApprovalStepStatus.APPROVED.value
    step.decided_at = now
    if payload.decision_note is not None:
        step.decision_note = payload.decision_note
    await _resolve_step_inbox_item(
        session, step, InboxItemStatus.COMPLETED.value
    )

    next_step = await _next_pending_step(session, run.id, step.step_order)
    if next_step is not None:
        run.current_step_order = next_step.step_order
        inbox = await _create_inbox_item_for_step(
            session, run=run, step=next_step, user_id=user.id
        )
        next_step.inbox_item_id = inbox.id
    else:
        run.status = ApprovalWorkflowRunStatus.COMPLETED.value
        run.completed_at = now
        run.current_step_order = step.step_order

    await session.flush()
    return await _load_run_response(session, run.id, run.organization_id)


@router.post(
    "/{workflow_id}/steps/{step_id}/reject",
    response_model=ApprovalWorkflowRunResponse,
)
async def reject_step(
    workflow_id: uuid.UUID,
    step_id: uuid.UUID,
    payload: ApprovalStepDecisionRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalWorkflowRunResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    run, step = await _load_run_and_step(
        session, workflow_id, step_id, user.organization_id
    )

    _ensure_step_decidable(run, step)

    now = _utcnow()
    step.status = ApprovalStepStatus.REJECTED.value
    step.decided_at = now
    if payload.decision_note is not None:
        step.decision_note = payload.decision_note
    await _resolve_step_inbox_item(
        session, step, InboxItemStatus.COMPLETED.value
    )

    run.status = ApprovalWorkflowRunStatus.REJECTED.value
    run.completed_at = now
    run.current_step_order = step.step_order

    later_steps = await _load_pending_steps_after(session, run.id, step.step_order)
    for later in later_steps:
        later.status = ApprovalStepStatus.SKIPPED.value
        later.decided_at = now
        await _resolve_step_inbox_item(
            session, later, InboxItemStatus.DISMISSED.value
        )

    await session.flush()
    return await _load_run_response(session, run.id, run.organization_id)


# ---------------------------------------------------------------------------
# Step update (optional polish — only while pending)
# ---------------------------------------------------------------------------


@router.patch(
    "/{workflow_id}/steps/{step_id}",
    response_model=ApprovalStepResponse,
)
async def update_step(
    workflow_id: uuid.UUID,
    step_id: uuid.UUID,
    payload: ApprovalStepUpdateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ApprovalStepResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    run, step = await _load_run_and_step(
        session, workflow_id, step_id, user.organization_id
    )
    if step.status != ApprovalStepStatus.PENDING.value:
        raise HTTPException(
            status_code=409,
            detail="Only pending steps can be edited.",
        )
    if run.status != ApprovalWorkflowRunStatus.ACTIVE.value:
        raise HTTPException(
            status_code=409,
            detail="Workflow is not active; step is not editable.",
        )

    data = payload.model_dump(exclude_unset=True)
    if "assigned_to" in data and data["assigned_to"] is not None:
        await _validate_user_in_org(
            session, data["assigned_to"], run.organization_id
        )
    for key, value in data.items():
        setattr(step, key, value)

    # Mirror title/assignee/due_date onto the open inbox item so the
    # work-queue surface stays in sync with the step it represents.
    if step.inbox_item_id is not None:
        inbox = await _load_inbox_item(session, step.inbox_item_id)
        if inbox is not None and inbox.status == InboxItemStatus.OPEN.value:
            if "title" in data:
                inbox.title = f"Approval needed: {step.title}"
            if "assigned_to" in data:
                inbox.assigned_to = step.assigned_to
            if "due_date" in data:
                inbox.due_date = step.due_date

    await session.flush()
    await session.refresh(step)
    return ApprovalStepResponse.model_validate(step)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utcnow() -> datetime:
    return datetime.now(UTC)


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


async def _get_run_for_org(
    session: AsyncSession,
    workflow_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ApprovalWorkflowRun:
    stmt = select(ApprovalWorkflowRun).where(
        ApprovalWorkflowRun.id == workflow_id,
        ApprovalWorkflowRun.organization_id == organization_id,
    )
    run = (await session.execute(stmt)).scalar_one_or_none()
    if run is None:
        raise HTTPException(
            status_code=404, detail="Approval workflow not found."
        )
    return run


async def _load_steps(
    session: AsyncSession, workflow_run_id: uuid.UUID
) -> list[ApprovalStep]:
    stmt = (
        select(ApprovalStep)
        .where(ApprovalStep.workflow_run_id == workflow_run_id)
        .order_by(ApprovalStep.step_order.asc())
    )
    return list((await session.execute(stmt)).scalars().all())


async def _load_run_response(
    session: AsyncSession,
    workflow_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ApprovalWorkflowRunResponse:
    stmt = (
        select(ApprovalWorkflowRun)
        .where(
            ApprovalWorkflowRun.id == workflow_id,
            ApprovalWorkflowRun.organization_id == organization_id,
        )
        .options(selectinload(ApprovalWorkflowRun.steps))
    )
    run = (await session.execute(stmt)).scalar_one_or_none()
    if run is None:
        raise HTTPException(
            status_code=404, detail="Approval workflow not found."
        )
    return ApprovalWorkflowRunResponse.model_validate(run)


async def _load_run_and_step(
    session: AsyncSession,
    workflow_id: uuid.UUID,
    step_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> tuple[ApprovalWorkflowRun, ApprovalStep]:
    run = await _get_run_for_org(session, workflow_id, organization_id)
    stmt = select(ApprovalStep).where(
        ApprovalStep.id == step_id,
        ApprovalStep.workflow_run_id == run.id,
        ApprovalStep.organization_id == organization_id,
    )
    step = (await session.execute(stmt)).scalar_one_or_none()
    if step is None:
        raise HTTPException(
            status_code=404, detail="Approval step not found."
        )
    return run, step


def _ensure_step_decidable(
    run: ApprovalWorkflowRun, step: ApprovalStep
) -> None:
    """Guard the approve/reject path against duplicate / out-of-order calls.

    A step can only be decided when the workflow is still active, the
    step is still pending, and the step is the workflow's current step.
    Anything else collapses to 409.
    """
    if run.status != ApprovalWorkflowRunStatus.ACTIVE.value:
        raise HTTPException(
            status_code=409,
            detail=f"Workflow is {run.status}; no further decisions allowed.",
        )
    if step.status in _DECIDED_STEP_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f"Step is already {step.status}.",
        )
    if (
        run.current_step_order is not None
        and step.step_order != run.current_step_order
    ):
        raise HTTPException(
            status_code=409,
            detail="Only the current pending step can be decided.",
        )


async def _next_pending_step(
    session: AsyncSession,
    workflow_run_id: uuid.UUID,
    after_order: int,
) -> ApprovalStep | None:
    stmt = (
        select(ApprovalStep)
        .where(
            ApprovalStep.workflow_run_id == workflow_run_id,
            ApprovalStep.step_order > after_order,
            ApprovalStep.status == ApprovalStepStatus.PENDING.value,
        )
        .order_by(ApprovalStep.step_order.asc())
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _load_pending_steps_after(
    session: AsyncSession,
    workflow_run_id: uuid.UUID,
    after_order: int,
) -> list[ApprovalStep]:
    stmt = (
        select(ApprovalStep)
        .where(
            ApprovalStep.workflow_run_id == workflow_run_id,
            ApprovalStep.step_order > after_order,
            ApprovalStep.status == ApprovalStepStatus.PENDING.value,
        )
        .order_by(ApprovalStep.step_order.asc())
    )
    return list((await session.execute(stmt)).scalars().all())


async def _create_inbox_item_for_step(
    session: AsyncSession,
    *,
    run: ApprovalWorkflowRun,
    step: ApprovalStep,
    user_id: uuid.UUID,
) -> InboxItem:
    metadata: dict[str, str] = {
        "workflow_run_id": str(run.id),
        "approval_step_id": str(step.id),
    }
    description_parts: list[str] = [f"Workflow: {run.name}"]
    if step.description:
        description_parts.append(step.description)
    if run.request_id is not None:
        description_parts.append(f"Request: {run.request_id}")
    if run.contract_id is not None:
        description_parts.append(f"Contract: {run.contract_id}")

    item = InboxItem(
        organization_id=run.organization_id,
        title=f"Approval needed: {step.title}",
        description="\n".join(description_parts) or None,
        item_type="approval",
        status=InboxItemStatus.OPEN.value,
        assigned_to=step.assigned_to,
        due_date=step.due_date,
        request_id=run.request_id,
        contract_id=run.contract_id,
        template_id=run.template_id,
        created_by=user_id,
        metadata_json=metadata,
    )
    session.add(item)
    await session.flush()
    return item


async def _load_inbox_item(
    session: AsyncSession, inbox_item_id: uuid.UUID
) -> InboxItem | None:
    stmt = select(InboxItem).where(InboxItem.id == inbox_item_id)
    return (await session.execute(stmt)).scalar_one_or_none()


async def _resolve_step_inbox_item(
    session: AsyncSession,
    step: ApprovalStep,
    new_status: str,
) -> None:
    """Close the inbox item linked to ``step`` if it's still open.

    No-op when the step has no linked item or the linked item is
    already closed; idempotent so a second decide attempt (which is
    already guarded above by 409) never double-touches the row.
    """
    if step.inbox_item_id is None:
        return
    item = await _load_inbox_item(session, step.inbox_item_id)
    if item is None:
        return
    if item.status == InboxItemStatus.OPEN.value:
        item.status = new_status
