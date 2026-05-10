"""Dashboard summary route.

A *lightweight* read-only aggregate of the rest of the app's state — a
landing surface for "what's open, what's due, what just happened",
intentionally not a BI/reporting engine.

Architectural notes
-------------------

* **Org-scoped, no exceptions.** Every query filters on
  ``organization_id == user.organization_id``. Cross-org access is
  prevented by construction; there is no ``organization_id`` query
  parameter.
* **Compact projections.** Lists return their own ``Dashboard*Summary``
  schemas (see ``app/schemas/dashboard.py``), not the full detail
  responses, so storage internals / extracted text / metadata blobs
  cannot accidentally end up on this surface.
* **Cheap queries only.** Counts use ``COUNT(*)`` over the existing
  indexes; recent / upcoming use ``ORDER BY ... LIMIT N`` with N <= 20.
  No materialized views, no heavy joins.
* **Today / due-soon window.** "Due soon" is ``[today, today + 14 days]``
  inclusive. "Overdue" is ``due_date < today``. Both clamp on the
  current UTC date so the test suite is deterministic.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Header, Query
from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.contracts import DbSession, _current_dev_user
from app.models import (
    AgreementTemplate,
    AgreementTemplateStatus,
    ApprovalStep,
    ApprovalStepStatus,
    ApprovalWorkflowRun,
    ApprovalWorkflowRunStatus,
    ApprovalWorkflowTemplate,
    ApprovalWorkflowTemplateStatus,
    Contract,
    ContractArtifact,
    ContractRequest,
    ContractRequestStatus,
    ContractStatus,
    InboxItem,
    InboxItemStatus,
)
from app.schemas.dashboard import (
    DashboardApprovalAnalytics,
    DashboardApprovalAssigneeBucket,
    DashboardContractSummary,
    DashboardCounts,
    DashboardInboxSummary,
    DashboardOldestPendingStep,
    DashboardRecentActivity,
    DashboardRequestSummary,
    DashboardSummaryResponse,
    DashboardUpcoming,
)

log = logging.getLogger(__name__)

router = APIRouter()

DEFAULT_LIST_LIMIT = 5
MAX_LIST_LIMIT = 20
DUE_SOON_WINDOW_DAYS = 14

# PR #62 — approval analytics tunables. Lists are intentionally tiny;
# the dashboard is not a reporting engine.
ANALYTICS_OLDEST_STEPS_LIMIT = 5
ANALYTICS_BY_ASSIGNEE_LIMIT = 10
ANALYTICS_RECENT_WINDOW_DAYS = 30

_HIGH_OR_URGENT = {"high", "urgent"}


@router.get("/summary", response_model=DashboardSummaryResponse)
async def get_dashboard_summary(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    limit: int = Query(
        default=DEFAULT_LIST_LIMIT,
        ge=1,
        le=MAX_LIST_LIMIT,
        description=(
            "Maximum number of items to return per recent / upcoming "
            f"list. Default {DEFAULT_LIST_LIMIT}, max {MAX_LIST_LIMIT}."
        ),
    ),
) -> DashboardSummaryResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    org_id = user.organization_id
    today = _today_utc()

    counts = await _build_counts(session, org_id, today)
    upcoming = await _build_upcoming(session, org_id, today, limit)
    recent = await _build_recent(session, org_id, limit)
    approval_analytics = await _build_approval_analytics(session, org_id, today)

    return DashboardSummaryResponse(
        counts=counts,
        upcoming=upcoming,
        recent_activity=recent,
        approval_analytics=approval_analytics,
    )


# ---------------------------------------------------------------------------
# Counts
# ---------------------------------------------------------------------------


async def _build_counts(
    session: AsyncSession, org_id: uuid.UUID, today: date
) -> DashboardCounts:
    open_requests = await _scalar_count(
        session,
        select(func.count(ContractRequest.id)).where(
            ContractRequest.organization_id == org_id,
            ContractRequest.status == ContractRequestStatus.OPEN.value,
        ),
    )
    in_progress_requests = await _scalar_count(
        session,
        select(func.count(ContractRequest.id)).where(
            ContractRequest.organization_id == org_id,
            ContractRequest.status == ContractRequestStatus.IN_PROGRESS.value,
        ),
    )
    urgent_or_high = await _scalar_count(
        session,
        select(func.count(ContractRequest.id)).where(
            ContractRequest.organization_id == org_id,
            ContractRequest.status.in_(
                [
                    ContractRequestStatus.OPEN.value,
                    ContractRequestStatus.IN_PROGRESS.value,
                ]
            ),
            ContractRequest.priority.in_(list(_HIGH_OR_URGENT)),
        ),
    )

    open_inbox_items = await _scalar_count(
        session,
        select(func.count(InboxItem.id)).where(
            InboxItem.organization_id == org_id,
            InboxItem.status == InboxItemStatus.OPEN.value,
        ),
    )
    overdue_inbox_items = await _scalar_count(
        session,
        select(func.count(InboxItem.id)).where(
            InboxItem.organization_id == org_id,
            InboxItem.status == InboxItemStatus.OPEN.value,
            InboxItem.due_date.is_not(None),
            InboxItem.due_date < today,
        ),
    )

    contracts_total = await _scalar_count(
        session,
        select(func.count(Contract.id)).where(
            Contract.organization_id == org_id,
        ),
    )
    contracts_sent = await _scalar_count(
        session,
        select(func.count(Contract.id)).where(
            Contract.organization_id == org_id,
            Contract.status == ContractStatus.SENT_FOR_SIGNATURE.value,
        ),
    )
    contracts_executed = await _scalar_count(
        session,
        select(func.count(Contract.id)).where(
            Contract.organization_id == org_id,
            Contract.status == ContractStatus.EXECUTED.value,
        ),
    )

    templates_active = await _scalar_count(
        session,
        select(func.count(AgreementTemplate.id)).where(
            AgreementTemplate.organization_id == org_id,
            AgreementTemplate.status == AgreementTemplateStatus.ACTIVE.value,
        ),
    )

    active_approval_workflows = await _scalar_count(
        session,
        select(func.count(ApprovalWorkflowRun.id)).where(
            ApprovalWorkflowRun.organization_id == org_id,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.ACTIVE.value,
        ),
    )
    pending_approval_steps = await _scalar_count(
        session,
        select(func.count(ApprovalStep.id))
        .join(
            ApprovalWorkflowRun,
            ApprovalWorkflowRun.id == ApprovalStep.workflow_run_id,
        )
        .where(
            ApprovalStep.organization_id == org_id,
            ApprovalStep.status == ApprovalStepStatus.PENDING.value,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.ACTIVE.value,
        ),
    )
    overdue_approval_steps = await _scalar_count(
        session,
        select(func.count(ApprovalStep.id))
        .join(
            ApprovalWorkflowRun,
            ApprovalWorkflowRun.id == ApprovalStep.workflow_run_id,
        )
        .where(
            ApprovalStep.organization_id == org_id,
            ApprovalStep.status == ApprovalStepStatus.PENDING.value,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.ACTIVE.value,
            ApprovalStep.due_date.is_not(None),
            ApprovalStep.due_date < today,
        ),
    )

    active_approval_workflow_templates = await _scalar_count(
        session,
        select(func.count(ApprovalWorkflowTemplate.id)).where(
            ApprovalWorkflowTemplate.organization_id == org_id,
            ApprovalWorkflowTemplate.status
            == ApprovalWorkflowTemplateStatus.ACTIVE.value,
        ),
    )

    return DashboardCounts(
        open_requests=open_requests,
        in_progress_requests=in_progress_requests,
        urgent_or_high_priority_requests=urgent_or_high,
        open_inbox_items=open_inbox_items,
        overdue_inbox_items=overdue_inbox_items,
        contracts_total=contracts_total,
        contracts_sent_for_signature=contracts_sent,
        contracts_executed=contracts_executed,
        templates_active=templates_active,
        active_approval_workflows=active_approval_workflows,
        pending_approval_steps=pending_approval_steps,
        overdue_approval_steps=overdue_approval_steps,
        active_approval_workflow_templates=active_approval_workflow_templates,
    )


# ---------------------------------------------------------------------------
# Upcoming
# ---------------------------------------------------------------------------


async def _build_upcoming(
    session: AsyncSession, org_id: uuid.UUID, today: date, limit: int
) -> DashboardUpcoming:
    window_end = today + timedelta(days=DUE_SOON_WINDOW_DAYS)

    # Requests: still actionable (not cancelled, not completed) AND due
    # in the next two weeks. Sorted by due date so the urgent tail is
    # at the top.
    request_stmt = (
        select(ContractRequest)
        .where(
            ContractRequest.organization_id == org_id,
            ContractRequest.status.in_(
                [
                    ContractRequestStatus.OPEN.value,
                    ContractRequestStatus.IN_PROGRESS.value,
                ]
            ),
            ContractRequest.due_date.is_not(None),
            ContractRequest.due_date >= today,
            ContractRequest.due_date <= window_end,
        )
        .order_by(ContractRequest.due_date.asc(), ContractRequest.id.asc())
        .limit(limit)
    )
    request_rows = (await session.execute(request_stmt)).scalars().all()

    inbox_stmt = (
        select(InboxItem)
        .where(
            InboxItem.organization_id == org_id,
            InboxItem.status == InboxItemStatus.OPEN.value,
            InboxItem.due_date.is_not(None),
            InboxItem.due_date >= today,
            InboxItem.due_date <= window_end,
        )
        .order_by(InboxItem.due_date.asc(), InboxItem.id.asc())
        .limit(limit)
    )
    inbox_rows = (await session.execute(inbox_stmt)).scalars().all()

    return DashboardUpcoming(
        requests_due_soon=[
            DashboardRequestSummary.model_validate(r) for r in request_rows
        ],
        inbox_items_due_soon=[
            DashboardInboxSummary.model_validate(i) for i in inbox_rows
        ],
    )


# ---------------------------------------------------------------------------
# Recent activity
# ---------------------------------------------------------------------------


async def _build_recent(
    session: AsyncSession, org_id: uuid.UUID, limit: int
) -> DashboardRecentActivity:
    recent_contracts_stmt = (
        select(Contract)
        .where(Contract.organization_id == org_id)
        .order_by(Contract.created_at.desc(), Contract.id.desc())
        .limit(limit)
    )
    recent_contracts = (
        await session.execute(recent_contracts_stmt)
    ).scalars().all()

    recent_requests_stmt = (
        select(ContractRequest)
        .where(
            ContractRequest.organization_id == org_id,
            ContractRequest.status != ContractRequestStatus.CANCELLED.value,
        )
        .order_by(ContractRequest.created_at.desc(), ContractRequest.id.desc())
        .limit(limit)
    )
    recent_requests = (
        await session.execute(recent_requests_stmt)
    ).scalars().all()

    recent_signed_stmt = (
        select(Contract)
        .where(
            Contract.organization_id == org_id,
            Contract.status == ContractStatus.EXECUTED.value,
        )
        .order_by(Contract.updated_at.desc(), Contract.id.desc())
        .limit(limit)
    )
    recent_signed = (await session.execute(recent_signed_stmt)).scalars().all()

    # One bulk artifact-existence lookup covers every contract id we're
    # about to emit. Cheaper than N round-trips, and avoids loading the
    # actual artifact rows (which carry storage_key / wrapped_dek that
    # we don't want anywhere near this surface).
    contract_ids = {c.id for c in recent_contracts} | {c.id for c in recent_signed}
    artifact_flags = await _artifact_flags(session, org_id, contract_ids)

    return DashboardRecentActivity(
        recent_contracts=[
            _contract_summary(c, artifact_flags) for c in recent_contracts
        ],
        recent_requests=[
            DashboardRequestSummary.model_validate(r) for r in recent_requests
        ],
        recent_signed_contracts=[
            _contract_summary(c, artifact_flags) for c in recent_signed
        ],
    )


def _contract_summary(
    contract: Contract,
    flags: dict[uuid.UUID, dict[str, bool]],
) -> DashboardContractSummary:
    f = flags.get(contract.id, {})
    return DashboardContractSummary(
        id=contract.id,
        title=contract.title,
        status=contract.status,
        created_at=contract.created_at,
        updated_at=contract.updated_at,
        docuseal_submission_id=contract.docuseal_submission_id,
        has_generated_docx=bool(f.get("generated_docx", False)),
        has_signed_pdf=bool(f.get("signed_pdf", False)),
    )


async def _artifact_flags(
    session: AsyncSession,
    org_id: uuid.UUID,
    contract_ids: set[uuid.UUID],
) -> dict[uuid.UUID, dict[str, bool]]:
    """Return ``{contract_id: {artifact_type: True}}`` for the
    artifact types we surface on the dashboard.

    Returns metadata only (``contract_id`` + ``artifact_type``), never
    storage internals. The org filter is redundant given the contract
    scope but is explicit defense-in-depth — every dashboard query
    passes ``organization_id``, no exceptions.
    """
    if not contract_ids:
        return {}
    stmt = select(
        ContractArtifact.contract_id, ContractArtifact.artifact_type
    ).where(
        ContractArtifact.organization_id == org_id,
        ContractArtifact.contract_id.in_(list(contract_ids)),
        ContractArtifact.artifact_type.in_(["generated_docx", "signed_pdf"]),
    )
    rows = (await session.execute(stmt)).all()
    out: dict[uuid.UUID, dict[str, bool]] = {}
    for contract_id, artifact_type in rows:
        out.setdefault(contract_id, {})[artifact_type] = True
    return out


# ---------------------------------------------------------------------------
# Approval analytics (PR #62)
#
# Lightweight aggregate over the existing approval workflow + step rows;
# no new tables, no new state transitions. Counts are org-scoped, lists
# are tiny (oldest_pending_steps <= 5, pending_by_assignee <= 10) and
# carry no approver email / signer PII / storage internals.
# ---------------------------------------------------------------------------


async def _build_approval_analytics(
    session: AsyncSession, org_id: uuid.UUID, today: date
) -> DashboardApprovalAnalytics:
    cutoff = datetime.combine(
        today - timedelta(days=ANALYTICS_RECENT_WINDOW_DAYS),
        datetime.min.time(),
        tzinfo=UTC,
    )

    # Pending / overdue step counts. We deliberately mirror the
    # ``DashboardCounts`` definitions (pending step on an *active*
    # workflow, overdue = pending + due_date < today) so the analytics
    # block and the headline counter never disagree.
    pending_step_filter = (
        ApprovalStep.organization_id == org_id,
        ApprovalStep.status == ApprovalStepStatus.PENDING.value,
        ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.ACTIVE.value,
    )
    overdue_step_extra = (
        ApprovalStep.due_date.is_not(None),
        ApprovalStep.due_date < today,
    )

    pending_steps = await _scalar_count(
        session,
        select(func.count(ApprovalStep.id))
        .join(
            ApprovalWorkflowRun,
            ApprovalWorkflowRun.id == ApprovalStep.workflow_run_id,
        )
        .where(*pending_step_filter),
    )
    overdue_steps = await _scalar_count(
        session,
        select(func.count(ApprovalStep.id))
        .join(
            ApprovalWorkflowRun,
            ApprovalWorkflowRun.id == ApprovalStep.workflow_run_id,
        )
        .where(*pending_step_filter, *overdue_step_extra),
    )

    # Workflow status counts.
    active_workflows = await _scalar_count(
        session,
        select(func.count(ApprovalWorkflowRun.id)).where(
            ApprovalWorkflowRun.organization_id == org_id,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.ACTIVE.value,
        ),
    )
    completed_workflows = await _scalar_count(
        session,
        select(func.count(ApprovalWorkflowRun.id)).where(
            ApprovalWorkflowRun.organization_id == org_id,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.COMPLETED.value,
        ),
    )
    rejected_workflows = await _scalar_count(
        session,
        select(func.count(ApprovalWorkflowRun.id)).where(
            ApprovalWorkflowRun.organization_id == org_id,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.REJECTED.value,
        ),
    )
    cancelled_workflows = await _scalar_count(
        session,
        select(func.count(ApprovalWorkflowRun.id)).where(
            ApprovalWorkflowRun.organization_id == org_id,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.CANCELLED.value,
        ),
    )

    # Recent-window subsets. ``completed_at`` is the timestamp the
    # workflow flipped into a terminal state for completed/rejected.
    workflows_completed_recent = await _scalar_count(
        session,
        select(func.count(ApprovalWorkflowRun.id)).where(
            ApprovalWorkflowRun.organization_id == org_id,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.COMPLETED.value,
            ApprovalWorkflowRun.completed_at.is_not(None),
            ApprovalWorkflowRun.completed_at >= cutoff,
        ),
    )
    workflows_rejected_recent = await _scalar_count(
        session,
        select(func.count(ApprovalWorkflowRun.id)).where(
            ApprovalWorkflowRun.organization_id == org_id,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.REJECTED.value,
            ApprovalWorkflowRun.completed_at.is_not(None),
            ApprovalWorkflowRun.completed_at >= cutoff,
        ),
    )

    pending_by_assignee = await _build_pending_by_assignee(session, org_id, today)
    oldest_pending_steps = await _build_oldest_pending_steps(session, org_id)

    return DashboardApprovalAnalytics(
        pending_steps=pending_steps,
        overdue_steps=overdue_steps,
        active_workflows=active_workflows,
        completed_workflows=completed_workflows,
        rejected_workflows=rejected_workflows,
        cancelled_workflows=cancelled_workflows,
        workflows_completed_last_30_days=workflows_completed_recent,
        workflows_rejected_last_30_days=workflows_rejected_recent,
        pending_by_assignee=pending_by_assignee,
        oldest_pending_steps=oldest_pending_steps,
    )


async def _build_pending_by_assignee(
    session: AsyncSession, org_id: uuid.UUID, today: date
) -> list[DashboardApprovalAssigneeBucket]:
    overdue_case = case(
        (
            and_(
                ApprovalStep.due_date.is_not(None),
                ApprovalStep.due_date < today,
            ),
            1,
        ),
        else_=0,
    )
    stmt = (
        select(
            ApprovalStep.assigned_to,
            func.count(ApprovalStep.id).label("count"),
            func.coalesce(func.sum(overdue_case), 0).label("overdue_count"),
        )
        .join(
            ApprovalWorkflowRun,
            ApprovalWorkflowRun.id == ApprovalStep.workflow_run_id,
        )
        .where(
            ApprovalStep.organization_id == org_id,
            ApprovalStep.status == ApprovalStepStatus.PENDING.value,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.ACTIVE.value,
        )
        .group_by(ApprovalStep.assigned_to)
        .order_by(
            func.count(ApprovalStep.id).desc(),
            ApprovalStep.assigned_to.asc(),
        )
        .limit(ANALYTICS_BY_ASSIGNEE_LIMIT)
    )
    rows = (await session.execute(stmt)).all()
    return [
        DashboardApprovalAssigneeBucket(
            assigned_to=assigned_to,
            count=int(count),
            overdue_count=int(overdue_count or 0),
        )
        for assigned_to, count, overdue_count in rows
    ]


async def _build_oldest_pending_steps(
    session: AsyncSession, org_id: uuid.UUID
) -> list[DashboardOldestPendingStep]:
    stmt = (
        select(
            ApprovalStep,
            ApprovalWorkflowRun.request_id,
            ApprovalWorkflowRun.contract_id,
        )
        .join(
            ApprovalWorkflowRun,
            ApprovalWorkflowRun.id == ApprovalStep.workflow_run_id,
        )
        .where(
            ApprovalStep.organization_id == org_id,
            ApprovalStep.status == ApprovalStepStatus.PENDING.value,
            ApprovalWorkflowRun.status == ApprovalWorkflowRunStatus.ACTIVE.value,
        )
        .order_by(
            ApprovalStep.due_date.asc().nullslast(),
            ApprovalStep.created_at.asc(),
            ApprovalStep.id.asc(),
        )
        .limit(ANALYTICS_OLDEST_STEPS_LIMIT)
    )
    rows = (await session.execute(stmt)).all()
    return [
        DashboardOldestPendingStep(
            id=step.id,
            workflow_run_id=step.workflow_run_id,
            title=step.title,
            step_order=step.step_order,
            assigned_to=step.assigned_to,
            approver_name=step.approver_name,
            due_date=step.due_date,
            created_at=step.created_at,
            request_id=request_id,
            contract_id=contract_id,
        )
        for step, request_id, contract_id in rows
    ]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _scalar_count(session: AsyncSession, stmt) -> int:
    return int((await session.execute(stmt)).scalar_one() or 0)


def _today_utc() -> date:
    return datetime.now(UTC).date()
