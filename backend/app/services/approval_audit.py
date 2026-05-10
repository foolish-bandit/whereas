"""Audit-event emit helpers for the approval surface (PR #58).

These wrap ``app.security.audit_log.record_event`` with a consistent
shape so every approval timeline row carries the same allowlist of
safe fields (workflow_run_id, request_id, contract_id, source pointers,
plus step-level identifiers and ``decision_note_present``).

**No** decision-note text, signer PII, document bytes, storage keys, or
DocuSeal secrets are ever embedded. The audit chain is hash-validated,
so changes to detail keys / shapes here are effectively a migration —
add new fields, never silently remove or rename existing ones.

The helpers take the ORM rows (``ApprovalWorkflowRun``, ``ApprovalStep``)
rather than free kwargs so the per-event detail set is centralized in
this file. Routers call into these from inside their existing
session/transaction; the chain write is part of the same commit.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ApprovalStep, ApprovalWorkflowRun
from app.security.audit_log import AuditEvent, AuditEventType, record_event


def _run_details(
    run: ApprovalWorkflowRun, *, source: str | None = None
) -> dict[str, Any]:
    """Compact, allowlisted payload for any workflow-level event.

    ``source`` distinguishes ad_hoc / template / policy origins. It's a
    best-effort label derived from ``metadata_json`` when not passed
    explicitly; it never blocks the audit write.
    """
    metadata = run.metadata_json or {}
    if source is None:
        if metadata.get("source_approval_policy_id"):
            source = "policy"
        elif metadata.get("source_workflow_template_id"):
            source = "template"
        else:
            source = "ad_hoc"
    details: dict[str, Any] = {
        "workflow_run_id": str(run.id),
        "workflow_run_name": run.name,
        "request_id": str(run.request_id) if run.request_id else None,
        "contract_id": str(run.contract_id) if run.contract_id else None,
        "source": source,
    }
    src_template = metadata.get("source_workflow_template_id")
    if isinstance(src_template, str):
        details["source_workflow_template_id"] = src_template
    src_policy = metadata.get("source_approval_policy_id")
    if isinstance(src_policy, str):
        details["source_approval_policy_id"] = src_policy
    src_policy_name = metadata.get("source_approval_policy_name")
    if isinstance(src_policy_name, str):
        details["source_approval_policy_name"] = src_policy_name
    return details


def _step_details(
    run: ApprovalWorkflowRun,
    step: ApprovalStep,
    *,
    decision_note: str | None = None,
) -> dict[str, Any]:
    """Compact, allowlisted payload for any step-level event.

    ``decision_note`` is **not** stored as text — only its presence is
    recorded (``decision_note_present: bool``). The note itself is
    user-typed and may contain sensitive language; the audit chain is
    not the right place for it. The ``ApprovalStep.decision_note``
    column already holds the raw text for the few places that need it.
    """
    details = _run_details(run)
    details.update(
        {
            "approval_step_id": str(step.id),
            "step_order": step.step_order,
            "step_title": step.title,
        }
    )
    if decision_note is not None:
        details["decision_note_present"] = bool(decision_note.strip())
    return details


async def record_workflow_created(
    session: AsyncSession,
    *,
    run: ApprovalWorkflowRun,
    actor_user_id: uuid.UUID | None,
    source: str | None = None,
) -> AuditEvent:
    return await record_event(
        session,
        organization_id=run.organization_id,
        event_type=AuditEventType.APPROVAL_WORKFLOW_CREATED,
        actor_user_id=actor_user_id,
        target_type="approval_workflow_run",
        target_id=str(run.id),
        details=_run_details(run, source=source),
    )


async def record_step_activated(
    session: AsyncSession,
    *,
    run: ApprovalWorkflowRun,
    step: ApprovalStep,
    actor_user_id: uuid.UUID | None,
) -> AuditEvent:
    return await record_event(
        session,
        organization_id=run.organization_id,
        event_type=AuditEventType.APPROVAL_STEP_ACTIVATED,
        actor_user_id=actor_user_id,
        target_type="approval_workflow_run",
        target_id=str(run.id),
        details=_step_details(run, step),
    )


async def record_step_approved(
    session: AsyncSession,
    *,
    run: ApprovalWorkflowRun,
    step: ApprovalStep,
    actor_user_id: uuid.UUID | None,
    decision_note: str | None,
) -> AuditEvent:
    return await record_event(
        session,
        organization_id=run.organization_id,
        event_type=AuditEventType.APPROVAL_STEP_APPROVED,
        actor_user_id=actor_user_id,
        target_type="approval_workflow_run",
        target_id=str(run.id),
        details=_step_details(run, step, decision_note=decision_note),
    )


async def record_step_rejected(
    session: AsyncSession,
    *,
    run: ApprovalWorkflowRun,
    step: ApprovalStep,
    actor_user_id: uuid.UUID | None,
    decision_note: str | None,
) -> AuditEvent:
    return await record_event(
        session,
        organization_id=run.organization_id,
        event_type=AuditEventType.APPROVAL_STEP_REJECTED,
        actor_user_id=actor_user_id,
        target_type="approval_workflow_run",
        target_id=str(run.id),
        details=_step_details(run, step, decision_note=decision_note),
    )


async def record_workflow_completed(
    session: AsyncSession,
    *,
    run: ApprovalWorkflowRun,
    actor_user_id: uuid.UUID | None,
) -> AuditEvent:
    return await record_event(
        session,
        organization_id=run.organization_id,
        event_type=AuditEventType.APPROVAL_WORKFLOW_COMPLETED,
        actor_user_id=actor_user_id,
        target_type="approval_workflow_run",
        target_id=str(run.id),
        details=_run_details(run),
    )


async def record_workflow_rejected(
    session: AsyncSession,
    *,
    run: ApprovalWorkflowRun,
    actor_user_id: uuid.UUID | None,
) -> AuditEvent:
    return await record_event(
        session,
        organization_id=run.organization_id,
        event_type=AuditEventType.APPROVAL_WORKFLOW_REJECTED,
        actor_user_id=actor_user_id,
        target_type="approval_workflow_run",
        target_id=str(run.id),
        details=_run_details(run),
    )


async def record_workflow_cancelled(
    session: AsyncSession,
    *,
    run: ApprovalWorkflowRun,
    actor_user_id: uuid.UUID | None,
) -> AuditEvent:
    return await record_event(
        session,
        organization_id=run.organization_id,
        event_type=AuditEventType.APPROVAL_WORKFLOW_CANCELLED,
        actor_user_id=actor_user_id,
        target_type="approval_workflow_run",
        target_id=str(run.id),
        details=_run_details(run),
    )
