from __future__ import annotations

import uuid

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ApprovalPolicy,
    ApprovalPolicyStatus,
    ApprovalWorkflowRun,
    ApprovalWorkflowRunStatus,
    ContractRequest,
)
from app.schemas.approval_workflow_templates import CreateApprovalWorkflowFromTemplateRequest


async def find_matching_approval_policies(db: AsyncSession, request: ContractRequest, *, applies_to_generated_contracts: bool | None = None) -> list[ApprovalPolicy]:
    org_id = getattr(request, "organization_id", None)
    if org_id is None:
        return []
    stmt = select(ApprovalPolicy).where(
        ApprovalPolicy.organization_id == org_id,
        ApprovalPolicy.status == ApprovalPolicyStatus.ACTIVE.value,
        or_(ApprovalPolicy.request_type.is_(None), ApprovalPolicy.request_type == getattr(request, "request_type", None)),
        or_(ApprovalPolicy.contract_type.is_(None), ApprovalPolicy.contract_type == getattr(request, "contract_type", None)),
        or_(ApprovalPolicy.priority.is_(None), ApprovalPolicy.priority == getattr(request, "priority", None)),
        or_(ApprovalPolicy.agreement_template_id.is_(None), ApprovalPolicy.agreement_template_id == getattr(request, "linked_template_id", None)),
    )
    if applies_to_generated_contracts is not None:
        stmt = stmt.where(ApprovalPolicy.applies_to_generated_contracts == applies_to_generated_contracts)
    return (await db.execute(stmt)).scalars().all()


async def apply_approval_policies_to_request(db: AsyncSession, request: ContractRequest, user_id: uuid.UUID | None = None) -> dict[str, list[str]]:
    policies = await find_matching_approval_policies(db, request)
    created: list[str] = []
    skipped: list[str] = []
    for policy in policies:
        if not policy.auto_attach:
            skipped.append(str(policy.id))
            continue
        existing = (await db.execute(select(ApprovalWorkflowRun).where(
            ApprovalWorkflowRun.organization_id == request.organization_id,
            ApprovalWorkflowRun.request_id == request.id,
            ApprovalWorkflowRun.status != ApprovalWorkflowRunStatus.CANCELLED.value,
            ApprovalWorkflowRun.metadata_json["source_approval_policy_id"].as_string()
            == str(policy.id),
        ))).scalar_one_or_none()
        if existing is not None:
            skipped.append(str(policy.id))
            continue
        from app.api.approval_workflow_templates import instantiate_workflow_template
        run = await instantiate_workflow_template(
            policy.workflow_template_id,
            CreateApprovalWorkflowFromTemplateRequest(
                request_id=request.id,
                name=f"{policy.name} - {request.title}",
                metadata_json={
                    "source_approval_policy_id": str(policy.id),
                    "source_approval_policy_name": policy.name,
                    "source_workflow_template_id": str(policy.workflow_template_id),
                },
            ),
            session=db,
            x_whereas_dev_user=str(user_id) if user_id else None,
        )
        created.append(str(run.id))
    return {"created_workflow_ids": created, "skipped_policy_ids": skipped}
