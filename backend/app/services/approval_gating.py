from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ApprovalPolicy,
    ApprovalWorkflowRun,
    ApprovalWorkflowRunStatus,
    Contract,
    ContractRequest,
)
from app.services.approval_policies import find_matching_approval_policies


@dataclass
class ApprovalGatePolicySummary:
    """Compact, UI-safe projection of an :class:`ApprovalPolicy` row.

    Mirrors the shape of ``RequestApprovalPolicySummary`` (PR #56) so
    callers reading either surface see the same scalar allowlist. Only
    fields the gate UI needs to *name* a policy or explain *why* it
    matched (request_type / contract_type / priority / agreement_template_id)
    are exposed; ``description``, ``metadata_json``, ``created_by``,
    ``created_at`` and storage / artifact fields are intentionally
    omitted so a future column on :class:`ApprovalPolicy` cannot
    accidentally leak through this surface.
    """

    id: uuid.UUID
    name: str
    workflow_template_id: uuid.UUID
    auto_attach: bool
    applies_to_generated_contracts: bool
    request_type: str | None
    contract_type: str | None
    priority: str | None
    agreement_template_id: uuid.UUID | None

    @classmethod
    def from_policy(cls, policy: ApprovalPolicy) -> ApprovalGatePolicySummary:
        return cls(
            id=policy.id,
            name=policy.name,
            workflow_template_id=policy.workflow_template_id,
            auto_attach=policy.auto_attach,
            applies_to_generated_contracts=policy.applies_to_generated_contracts,
            request_type=policy.request_type,
            contract_type=policy.contract_type,
            priority=policy.priority,
            agreement_template_id=policy.agreement_template_id,
        )

    def to_safe_dict(self) -> dict[str, object]:
        return {
            "id": str(self.id),
            "name": self.name,
            "workflow_template_id": str(self.workflow_template_id),
            "auto_attach": bool(self.auto_attach),
            "applies_to_generated_contracts": bool(self.applies_to_generated_contracts),
            "request_type": self.request_type,
            "contract_type": self.contract_type,
            "priority": self.priority,
            "agreement_template_id": (
                str(self.agreement_template_id)
                if self.agreement_template_id is not None
                else None
            ),
        }


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
    required_policy_ids: list[uuid.UUID]
    missing_policy_ids: list[uuid.UUID]
    required_policies: list[ApprovalGatePolicySummary] = field(default_factory=list)
    missing_policies: list[ApprovalGatePolicySummary] = field(default_factory=list)

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
            "required_policy_ids": [str(i) for i in self.required_policy_ids],
            "missing_policy_ids": [str(i) for i in self.missing_policy_ids],
            "required_policies": [p.to_safe_dict() for p in self.required_policies],
            "missing_policies": [p.to_safe_dict() for p in self.missing_policies],
        }


def _sorted_policy_summaries(
    policies: list[ApprovalPolicy],
) -> list[ApprovalGatePolicySummary]:
    """Project policies into UI summaries with a stable sort.

    Sort by (name, id) so the gate UI renders policies in the same
    order across requests regardless of the underlying SQL row order.
    The `id` tiebreaker keeps two policies with the same display name
    from flipping positions between calls.
    """
    return [
        ApprovalGatePolicySummary.from_policy(p)
        for p in sorted(policies, key=lambda p: (p.name, str(p.id)))
    ]


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
        return ApprovalGateResult(True, "no_linked_request", None, [], [], 0, 0, 0, 0, [], [])

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
    required_policies = await find_matching_approval_policies(db, req, applies_to_generated_contracts=True)
    required_summaries = _sorted_policy_summaries(required_policies)
    required_policy_ids = [s.id for s in required_summaries]
    if not workflows and not required_policies:
        return ApprovalGateResult(True, "no_workflows_required", req.id, [], [], 0, 0, 0, 0, [], [])

    active = [w for w in workflows if w.status == ApprovalWorkflowRunStatus.ACTIVE.value]
    rejected = [w for w in workflows if w.status == ApprovalWorkflowRunStatus.REJECTED.value]
    cancelled = [w for w in workflows if w.status == ApprovalWorkflowRunStatus.CANCELLED.value]
    completed = [w for w in workflows if w.status == ApprovalWorkflowRunStatus.COMPLETED.value]

    if active:
        return ApprovalGateResult(False, "active_approval_workflows", req.id, [w.id for w in active], [w.id for w in completed], len(active), len(rejected), len(cancelled), len(completed), required_policy_ids, [], required_summaries, [])
    if rejected:
        return ApprovalGateResult(False, "rejected_approval_workflows", req.id, [w.id for w in rejected], [w.id for w in completed], len(active), len(rejected), len(cancelled), len(completed), required_policy_ids, [], required_summaries, [])
    completed_policy_ids = {str((getattr(w, "metadata_json", None) or {}).get("source_approval_policy_id")) for w in completed}
    missing_summaries = [s for s in required_summaries if str(s.id) not in completed_policy_ids]
    missing_policy_ids = [s.id for s in missing_summaries]
    if missing_policy_ids:
        return ApprovalGateResult(False, "required_approval_policy_unmet", req.id, [w.id for w in cancelled], [w.id for w in completed], len(active), len(rejected), len(cancelled), len(completed), required_policy_ids, missing_policy_ids, required_summaries, missing_summaries)
    if completed:
        return ApprovalGateResult(True, "approvals_completed", req.id, [], [w.id for w in completed], len(active), len(rejected), len(cancelled), len(completed), required_policy_ids, [], required_summaries, [])
    return ApprovalGateResult(False, "cancelled_without_completed_approval", req.id, [w.id for w in cancelled], [], len(active), len(rejected), len(cancelled), len(completed), required_policy_ids, required_policy_ids, required_summaries, list(required_summaries))
