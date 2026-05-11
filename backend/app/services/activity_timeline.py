"""Activity-timeline projection (PR #58).

Reads ``AuditEvent`` rows and projects them into the safe
``ActivityTimelineItem`` shape. The projection is the only place that
decides which underlying audit detail keys are exposed to the API
surface — anything not allowlisted here cannot leak out, even if a
future audit detail accidentally carried it.

Two entry points:

* :func:`load_request_activity` — events tied to a ``ContractRequest``
  via approval workflows attached to the request OR to the request's
  linked contract, plus DocuSeal events on the linked contract.
* :func:`load_contract_activity` — events tied to a ``Contract`` via
  approval workflows attached to it, plus DocuSeal events on it.

Both funnel through :func:`_query_events`, which handles ordering
(``occurred_at DESC, id DESC``), org scoping, and the limit clamp.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ApprovalWorkflowRun, Contract, ContractRequest
from app.schemas.activity import ActivityTimelineItem
from app.security.audit_log import AuditEvent, AuditEventType

# Default + cap for the ``?limit=`` query param. Keep the cap modest;
# the timeline is for "what just happened to this object" not a full
# audit dump.
DEFAULT_LIMIT = 25
MAX_LIMIT = 100


# Approval and DocuSeal events the timeline surfaces. Other event types
# (USER_LOGIN_*, CONTRACT_DOWNLOADED, KEY_ROTATION_*) are deliberately
# omitted; they belong on a security/admin audit page, not on a request
# or contract's activity feed.
_APPROVAL_EVENT_TYPES = (
    AuditEventType.APPROVAL_WORKFLOW_CREATED.value,
    AuditEventType.APPROVAL_STEP_ACTIVATED.value,
    AuditEventType.APPROVAL_STEP_APPROVED.value,
    AuditEventType.APPROVAL_STEP_REJECTED.value,
    AuditEventType.APPROVAL_WORKFLOW_COMPLETED.value,
    AuditEventType.APPROVAL_WORKFLOW_REJECTED.value,
    AuditEventType.APPROVAL_WORKFLOW_CANCELLED.value,
)
_CONTRACT_EVENT_TYPES = (
    AuditEventType.CONTRACT_SENT_FOR_SIGNATURE.value,
    AuditEventType.CONTRACT_EXECUTED.value,
)
# PR #65 — events whose ``target_type='request'`` and ``target_id`` is
# the ``ContractRequest.id``. So far there is only the "converted via
# upload" event from the request-conversion-by-upload path; future
# request-lifecycle events should be added here so the request
# timeline picks them up automatically.
_REQUEST_EVENT_TYPES = (
    AuditEventType.REQUEST_CONVERTED_BY_UPLOAD.value,
)


async def _list_workflow_run_ids_for_request(
    session: AsyncSession,
    request: ContractRequest,
) -> list[str]:
    """Workflow-run ids attached to a request (or its linked contract).

    Mirrors the predicate the visibility surface uses (PR #56's
    ``_workflow_links_request``) so the timeline and the visibility
    panel cannot disagree on which runs are "this request's".
    """
    where_clause = ApprovalWorkflowRun.request_id == request.id
    if request.linked_contract_id is not None:
        where_clause = or_(
            where_clause,
            ApprovalWorkflowRun.contract_id == request.linked_contract_id,
        )
    stmt = select(ApprovalWorkflowRun.id).where(
        ApprovalWorkflowRun.organization_id == request.organization_id,
        where_clause,
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [str(r) for r in rows]


async def _list_workflow_run_ids_for_contract(
    session: AsyncSession,
    contract: Contract,
) -> list[str]:
    """Workflow-run ids attached directly to a contract."""
    stmt = select(ApprovalWorkflowRun.id).where(
        ApprovalWorkflowRun.organization_id == contract.organization_id,
        ApprovalWorkflowRun.contract_id == contract.id,
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [str(r) for r in rows]


async def load_request_activity(
    session: AsyncSession,
    request: ContractRequest,
    *,
    limit: int = DEFAULT_LIMIT,
) -> list[ActivityTimelineItem]:
    """Timeline for a request: approval events for runs attached to it
    (or to its linked contract), DocuSeal events on the linked
    contract, plus request-lifecycle events on the request itself
    (PR #65: ``request.converted_by_upload``).
    """
    workflow_run_ids = await _list_workflow_run_ids_for_request(session, request)
    contract_ids: list[str] = []
    if request.linked_contract_id is not None:
        contract_ids.append(str(request.linked_contract_id))
    return await _query_events(
        session,
        organization_id=request.organization_id,
        approval_workflow_run_ids=workflow_run_ids,
        contract_ids=contract_ids,
        request_ids=[str(request.id)],
        limit=limit,
    )


async def load_contract_activity(
    session: AsyncSession,
    contract: Contract,
    *,
    limit: int = DEFAULT_LIMIT,
) -> list[ActivityTimelineItem]:
    """Timeline for a contract: approval events for runs attached to it,
    plus DocuSeal events on it.
    """
    workflow_run_ids = await _list_workflow_run_ids_for_contract(session, contract)
    return await _query_events(
        session,
        organization_id=contract.organization_id,
        approval_workflow_run_ids=workflow_run_ids,
        contract_ids=[str(contract.id)],
        request_ids=[],
        limit=limit,
    )


async def _query_events(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
    approval_workflow_run_ids: list[str],
    contract_ids: list[str],
    request_ids: list[str],
    limit: int,
) -> list[ActivityTimelineItem]:
    """Build the OR predicate, run the single audit-events query, and
    project the rows into ``ActivityTimelineItem`` instances.
    """
    bounded_limit = max(1, min(MAX_LIMIT, limit))
    if (
        not approval_workflow_run_ids
        and not contract_ids
        and not request_ids
    ):
        return []

    predicates = []
    if approval_workflow_run_ids:
        predicates.append(
            (AuditEvent.event_type.in_(_APPROVAL_EVENT_TYPES))
            & (AuditEvent.target_type == "approval_workflow_run")
            & (AuditEvent.target_id.in_(approval_workflow_run_ids))
        )
    if contract_ids:
        predicates.append(
            (AuditEvent.event_type.in_(_CONTRACT_EVENT_TYPES))
            & (AuditEvent.target_type == "contract")
            & (AuditEvent.target_id.in_(contract_ids))
        )
    if request_ids:
        predicates.append(
            (AuditEvent.event_type.in_(_REQUEST_EVENT_TYPES))
            & (AuditEvent.target_type == "request")
            & (AuditEvent.target_id.in_(request_ids))
        )
    where_clause = predicates[0] if len(predicates) == 1 else or_(*predicates)

    stmt = (
        select(AuditEvent)
        .where(
            AuditEvent.organization_id == organization_id,
            where_clause,
        )
        .order_by(desc(AuditEvent.occurred_at), desc(AuditEvent.id))
        .limit(bounded_limit)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [_project(row) for row in rows]


def _project(row: AuditEvent) -> ActivityTimelineItem:
    """Audit event → safe timeline item.

    The projection is intentionally narrow: only the allowlisted
    identifier fields and the server-rendered ``title`` / ``description``
    are exposed. ``row.details`` is read by key, never embedded raw.
    """
    details: dict[str, Any] = row.details or {}
    return ActivityTimelineItem(
        id=row.id,
        event_type=row.event_type,
        occurred_at=row.occurred_at,
        actor_user_id=row.actor_user_id,
        title=_title_for(row, details),
        description=_description_for(row, details),
        request_id=_uuid_or_none(details.get("request_id")),
        contract_id=_uuid_or_none(details.get("contract_id")),
        workflow_run_id=_uuid_or_none(details.get("workflow_run_id")),
        approval_step_id=_uuid_or_none(details.get("approval_step_id")),
        step_order=details.get("step_order")
        if isinstance(details.get("step_order"), int)
        else None,
        source=details.get("source")
        if isinstance(details.get("source"), str)
        else None,
    )


def _title_for(row: AuditEvent, details: dict[str, Any]) -> str:
    """Server-rendered, deterministic title per event type.

    Kept as a pure function over (event_type, details) so a single
    location decides how an event reads. Adding a new event type
    requires extending this; tests pin the existing ones.
    """
    et = row.event_type
    step_title = details.get("step_title") if isinstance(details.get("step_title"), str) else None
    workflow_name = (
        details.get("workflow_run_name")
        if isinstance(details.get("workflow_run_name"), str)
        else None
    )
    source = details.get("source") if isinstance(details.get("source"), str) else None

    if et == AuditEventType.APPROVAL_WORKFLOW_CREATED.value:
        suffix = ""
        if source == "policy":
            policy_name = (
                details.get("source_approval_policy_name")
                if isinstance(details.get("source_approval_policy_name"), str)
                else None
            )
            suffix = f" from policy {policy_name}" if policy_name else " from policy"
        elif source == "template":
            suffix = " from template"
        return f"Approval workflow created{suffix}: {workflow_name or 'workflow'}"
    if et == AuditEventType.APPROVAL_STEP_ACTIVATED.value:
        return f"Step activated: {step_title or 'step'}"
    if et == AuditEventType.APPROVAL_STEP_APPROVED.value:
        return f"Step approved: {step_title or 'step'}"
    if et == AuditEventType.APPROVAL_STEP_REJECTED.value:
        return f"Step rejected: {step_title or 'step'}"
    if et == AuditEventType.APPROVAL_WORKFLOW_COMPLETED.value:
        return f"Approval workflow completed: {workflow_name or 'workflow'}"
    if et == AuditEventType.APPROVAL_WORKFLOW_REJECTED.value:
        return f"Approval workflow rejected: {workflow_name or 'workflow'}"
    if et == AuditEventType.APPROVAL_WORKFLOW_CANCELLED.value:
        return f"Approval workflow cancelled: {workflow_name or 'workflow'}"
    if et == AuditEventType.CONTRACT_SENT_FOR_SIGNATURE.value:
        return "Sent to DocuSeal for signature"
    if et == AuditEventType.CONTRACT_EXECUTED.value:
        return "Signed contract received from DocuSeal"
    if et == AuditEventType.REQUEST_CONVERTED_BY_UPLOAD.value:
        filename = (
            details.get("filename")
            if isinstance(details.get("filename"), str)
            else None
        )
        if filename:
            return f"Request converted to Repository by upload: {filename}"
        return "Request converted to Repository by upload"
    return et


def _description_for(row: AuditEvent, details: dict[str, Any]) -> str | None:
    """Optional second-line description.

    Step events surface their order ("Step 2"); workflow-level events
    return None (the title is enough).
    """
    et = row.event_type
    step_order = details.get("step_order")
    if not isinstance(step_order, int):
        step_order = None
    if et in (
        AuditEventType.APPROVAL_STEP_ACTIVATED.value,
        AuditEventType.APPROVAL_STEP_APPROVED.value,
        AuditEventType.APPROVAL_STEP_REJECTED.value,
    ):
        if step_order is not None:
            return f"Step {step_order}"
        return None
    return None


def _uuid_or_none(value: Any) -> uuid.UUID | None:
    """Best-effort UUID coercion. Bad data shouldn't break the timeline."""
    if isinstance(value, uuid.UUID):
        return value
    if isinstance(value, str):
        try:
            return uuid.UUID(value)
        except (TypeError, ValueError):
            return None
    return None
