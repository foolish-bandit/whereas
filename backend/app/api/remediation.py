"""Deterministic review-to-action workflow for persisted playbook findings."""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.contracts import DbSession, _current_dev_user
from app.models import ClauseTemplate, DeviationFinding, InboxItem, InboxItemStatus, User
from app.models.remediation import FindingRemediationTask
from app.schemas.inbox_items import InboxItemResponse
from app.schemas.remediation import (
    FindingRemediationPlanResponse,
    FindingRemediationTaskRequest,
    FindingRemediationTaskResponse,
)
from app.security.audit_log import record_event
from app.services.finding_remediation import (
    RemediationLanguage,
    build_remediation_language,
    normalize_clause_type,
    priority_for_severity,
    remediation_audit_details,
    remediation_task_block_reason,
    remediation_task_description,
    remediation_task_metadata,
    remediation_task_title,
)

router = APIRouter()

_REMEDIATION_ITEM_TYPE = "finding_remediation"
_TASK_CREATED_EVENT = "finding.remediation_task.created"
_TASK_REOPENED_EVENT = "finding.remediation_task.reopened"


@router.get(
    "/{contract_id}/findings/{finding_id}/remediation",
    response_model=FindingRemediationPlanResponse,
)
async def get_finding_remediation_plan(
    contract_id: uuid.UUID,
    finding_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> FindingRemediationPlanResponse:
    """Return approved language and provenance without mutating workflow state."""

    user = await _current_dev_user(session, x_whereas_dev_user)
    finding = await _get_finding_for_org(
        session,
        organization_id=user.organization_id,
        contract_id=contract_id,
        finding_id=finding_id,
    )
    candidates = await _list_active_clause_templates(
        session, organization_id=user.organization_id
    )
    link = await _get_task_link(
        session,
        organization_id=user.organization_id,
        finding_id=finding.id,
    )
    language = build_remediation_language(finding, candidates)
    return _plan_response(
        finding,
        language,
        existing_task=link.inbox_item if link is not None else None,
    )


@router.post(
    "/{contract_id}/findings/{finding_id}/remediation/task",
    response_model=FindingRemediationTaskResponse,
)
async def create_finding_remediation_task(
    contract_id: uuid.UUID,
    finding_id: uuid.UUID,
    payload: FindingRemediationTaskRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> FindingRemediationTaskResponse:
    """Create, reuse, or reopen one provenance-linked Inbox task."""

    user = await _current_dev_user(session, x_whereas_dev_user)
    finding = await _get_finding_for_org(
        session,
        organization_id=user.organization_id,
        contract_id=contract_id,
        finding_id=finding_id,
    )
    block_reason = remediation_task_block_reason(finding.finding_status)
    if block_reason is not None:
        raise HTTPException(status_code=409, detail=block_reason)
    if payload.assigned_to is not None:
        await _validate_user_in_org(
            session,
            user_id=payload.assigned_to,
            organization_id=user.organization_id,
        )
    assigned_to = payload.assigned_to or user.id

    candidates = await _list_active_clause_templates(
        session, organization_id=user.organization_id
    )
    language = build_remediation_language(finding, candidates)
    existing_link = await _get_task_link(
        session,
        organization_id=user.organization_id,
        finding_id=finding.id,
    )

    if existing_link is not None:
        task = existing_link.inbox_item
        reopened = task.status == InboxItemStatus.DISMISSED.value
        if reopened:
            task.title = remediation_task_title(finding.rule_title)
            task.description = remediation_task_description(finding.clause_type)
            task.status = InboxItemStatus.OPEN.value
            task.priority = priority_for_severity(finding.severity)
            task.assigned_to = assigned_to
            task.due_date = payload.due_date
            task.contract_id = finding.contract_id
            task.metadata_json = remediation_task_metadata(finding, language)
            existing_link.source_type = language.source_type
            existing_link.source_id = language.source_id
            await session.flush()
            await record_event(
                session,
                organization_id=user.organization_id,
                actor_user_id=user.id,
                event_type=_TASK_REOPENED_EVENT,
                target_type="deviation_finding",
                target_id=str(finding.id),
                details=remediation_audit_details(finding, task.id, language),
            )
            await session.refresh(task)

        return FindingRemediationTaskResponse(
            plan=_plan_response(finding, language, existing_task=task),
            task=InboxItemResponse.model_validate(task),
            created=False,
            reopened=reopened,
        )

    task: InboxItem
    try:
        # The link's unique (organization_id, finding_id) constraint is the
        # concurrency backstop. A nested transaction rolls back the losing
        # Inbox row too, without poisoning the request's outer transaction.
        async with session.begin_nested():
            task = InboxItem(
                organization_id=user.organization_id,
                title=remediation_task_title(finding.rule_title),
                description=remediation_task_description(finding.clause_type),
                item_type=_REMEDIATION_ITEM_TYPE,
                status=InboxItemStatus.OPEN.value,
                priority=priority_for_severity(finding.severity),
                assigned_to=assigned_to,
                due_date=payload.due_date,
                contract_id=finding.contract_id,
                created_by=user.id,
                metadata_json=remediation_task_metadata(finding, language),
            )
            session.add(task)
            await session.flush()

            link = FindingRemediationTask(
                organization_id=user.organization_id,
                finding_id=finding.id,
                inbox_item_id=task.id,
                source_type=language.source_type,
                source_id=language.source_id,
            )
            session.add(link)
            await session.flush()
    except IntegrityError:
        # Another request created the one-to-one link while this request was
        # in flight. Return that task rather than surfacing a duplicate error.
        raced_link = await _get_task_link(
            session,
            organization_id=user.organization_id,
            finding_id=finding.id,
        )
        if raced_link is None:
            raise
        raced_task = raced_link.inbox_item
        return FindingRemediationTaskResponse(
            plan=_plan_response(finding, language, existing_task=raced_task),
            task=InboxItemResponse.model_validate(raced_task),
            created=False,
            reopened=False,
        )

    await record_event(
        session,
        organization_id=user.organization_id,
        actor_user_id=user.id,
        event_type=_TASK_CREATED_EVENT,
        target_type="deviation_finding",
        target_id=str(finding.id),
        details=remediation_audit_details(finding, task.id, language),
    )
    await session.refresh(task)
    return FindingRemediationTaskResponse(
        plan=_plan_response(finding, language, existing_task=task),
        task=InboxItemResponse.model_validate(task),
        created=True,
        reopened=False,
    )


def _plan_response(
    finding: DeviationFinding,
    language: RemediationLanguage,
    *,
    existing_task: InboxItem | None,
) -> FindingRemediationPlanResponse:
    return FindingRemediationPlanResponse(
        finding_id=finding.id,
        contract_id=finding.contract_id,
        review_run_id=finding.review_run_id,
        playbook_id=finding.playbook_id,
        rule_id=finding.rule_id,
        rule_title=finding.rule_title,
        clause_type=normalize_clause_type(finding.clause_type),
        severity=finding.severity,
        finding_status=finding.finding_status,
        suggested_language=language.suggested_language,
        source_type=language.source_type,
        source_id=language.source_id,
        source_name=language.source_name,
        rationale=language.rationale,
        scope_warning=language.scope_warning,
        existing_task=(
            InboxItemResponse.model_validate(existing_task)
            if existing_task is not None
            else None
        ),
    )


async def _get_finding_for_org(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
    contract_id: uuid.UUID,
    finding_id: uuid.UUID,
) -> DeviationFinding:
    stmt = select(DeviationFinding).where(
        DeviationFinding.id == finding_id,
        DeviationFinding.contract_id == contract_id,
        DeviationFinding.organization_id == organization_id,
    )
    finding = (await session.execute(stmt)).scalar_one_or_none()
    if finding is None:
        raise HTTPException(status_code=404, detail="Finding not found.")
    return finding


async def _list_active_clause_templates(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
) -> list[ClauseTemplate]:
    stmt = select(ClauseTemplate).where(
        ClauseTemplate.organization_id == organization_id,
        ClauseTemplate.is_active.is_(True),
    )
    return list((await session.execute(stmt)).scalars().all())


async def _get_task_link(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
    finding_id: uuid.UUID,
) -> FindingRemediationTask | None:
    stmt = (
        select(FindingRemediationTask)
        .options(selectinload(FindingRemediationTask.inbox_item))
        .where(
            FindingRemediationTask.organization_id == organization_id,
            FindingRemediationTask.finding_id == finding_id,
        )
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _validate_user_in_org(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> None:
    stmt = select(User.id).where(
        User.id == user_id,
        User.organization_id == organization_id,
        User.is_active.is_(True),
    )
    if (await session.execute(stmt)).scalar_one_or_none() is None:
        raise HTTPException(
            status_code=422,
            detail="Assigned user must be active and belong to the same organization.",
        )
