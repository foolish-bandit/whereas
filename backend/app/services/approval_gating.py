from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ApprovalWorkflowRun, ApprovalWorkflowRunStatus, Contract, ContractRequest


@dataclass
class ApprovalGateResult:
    allowed: bool
    code: str
    request_id: uuid.UUID | None
    blocking_workflow_ids: list[uuid.UUID]
    completed_workflow_ids: list[uuid.UUID]
    active_count: int
    rejected_count: int
    cancelled_count: int
    completed_count: int

    def to_safe_dict(self) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "code": self.code,
            "request_id": str(self.request_id) if self.request_id else None,
            "blocking_workflow_ids": [str(i) for i in self.blocking_workflow_ids],
            "completed_workflow_ids": [str(i) for i in self.completed_workflow_ids],
            "active_count": self.active_count,
            "rejected_count": self.rejected_count,
            "cancelled_count": self.cancelled_count,
            "completed_count": self.completed_count,
        }


async def can_send_contract_to_docuseal(
    db: AsyncSession,
    contract: Contract,
    organization_id: uuid.UUID,
) -> ApprovalGateResult:
    req = (
        await db.execute(
            select(ContractRequest).where(
                ContractRequest.organization_id == organization_id,
                ContractRequest.linked_contract_id == contract.id,
            )
        )
    ).scalar_one_or_none()
    if req is None:
        return ApprovalGateResult(True, "no_linked_request", None, [], [], 0, 0, 0, 0)

    workflows = (
        await db.execute(
            select(ApprovalWorkflowRun).where(
                ApprovalWorkflowRun.organization_id == organization_id,
                or_(
                    ApprovalWorkflowRun.request_id == req.id,
                    ApprovalWorkflowRun.contract_id == contract.id,
                ),
            )
        )
    ).scalars().all()
    if not workflows:
        return ApprovalGateResult(True, "no_workflows_required", req.id, [], [], 0, 0, 0, 0)

    active = [w for w in workflows if w.status == ApprovalWorkflowRunStatus.ACTIVE.value]
    rejected = [w for w in workflows if w.status == ApprovalWorkflowRunStatus.REJECTED.value]
    cancelled = [w for w in workflows if w.status == ApprovalWorkflowRunStatus.CANCELLED.value]
    completed = [w for w in workflows if w.status == ApprovalWorkflowRunStatus.COMPLETED.value]

    if active:
        return ApprovalGateResult(False, "active_approval_workflows", req.id, [w.id for w in active], [w.id for w in completed], len(active), len(rejected), len(cancelled), len(completed))
    if rejected:
        return ApprovalGateResult(False, "rejected_approval_workflows", req.id, [w.id for w in rejected], [w.id for w in completed], len(active), len(rejected), len(cancelled), len(completed))
    if completed:
        return ApprovalGateResult(True, "approvals_completed", req.id, [], [w.id for w in completed], len(active), len(rejected), len(cancelled), len(completed))
    return ApprovalGateResult(False, "cancelled_without_completed_approval", req.id, [w.id for w in cancelled], [], len(active), len(rejected), len(cancelled), len(completed))
