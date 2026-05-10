"""Contract request routes.

A ``ContractRequest`` is the intake/business workflow object: someone in
the org asks for a contract (new NDA, MSA, amendment, renewal, ...) and
the request is tracked through to ``completed`` or ``cancelled``. This
module deliberately stays narrow:

- No approval workflow engine.
- No automatic request-to-contract generation.
- No calendar/reminder integration.

Creating a request also creates one open ``request_review`` ``InboxItem``
in the same transaction so the request is discoverable in the work
queue without polling. Updating a request to ``completed`` or
``cancelled`` resolves the linked open ``request_review`` items in the
same flow.

Linked contract / template IDs must belong to the same organization;
cross-org references are rejected with 422.
"""
from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.contracts import (
    DbSession,
    _current_dev_user,
    _load_org_key_or_http,
    _load_organization,
)
from app.core.config import get_settings
from app.models import (
    AgreementTemplate,
    ApprovalStep,
    ApprovalWorkflowRun,
    ApprovalWorkflowRunStatus,
    Contract,
    ContractRequest,
    ContractRequestStatus,
    InboxItem,
    InboxItemStatus,
    User,
)
from app.schemas.artifacts import ContractArtifactResponse
from app.schemas.contracts import ContractListItemResponse
from app.schemas.markdown import ContractMarkdownSnapshotResponse
from app.schemas.request_approval_status import (
    RequestApprovalPolicySummary,
    RequestApprovalStatusResponse,
    RequestApprovalStepSummary,
    RequestApprovalSummary,
    RequestApprovalWorkflowSummary,
)
from app.schemas.requests import (
    ContractRequestCreateRequest,
    ContractRequestResponse,
    ContractRequestUpdateRequest,
    ConvertRequestToContractRequest,
    ConvertRequestToContractResponse,
)
from app.services.approval_gating import can_send_contract_to_docuseal
from app.services.approval_policies import (
    apply_approval_policies_to_request,
    find_matching_approval_policies,
)
from app.services.storage import DocumentStorage
from app.services.template_generation import (
    TemplateGenerationError,
    generate_docx_from_template,
)

log = logging.getLogger(__name__)

router = APIRouter()

_VALID_STATUSES = {s.value for s in ContractRequestStatus}
_TERMINAL_STATUSES = {
    ContractRequestStatus.COMPLETED.value,
    ContractRequestStatus.CANCELLED.value,
}


@router.post("", response_model=ContractRequestResponse, status_code=201)
async def create_request(
    payload: ContractRequestCreateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractRequestResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    org_id = user.organization_id

    await _validate_links(session, org_id, payload.linked_contract_id, payload.linked_template_id)
    if payload.assigned_to is not None:
        await _validate_user_in_org(session, payload.assigned_to, org_id)

    request = ContractRequest(
        organization_id=org_id,
        title=payload.title,
        description=payload.description,
        request_type=payload.request_type,
        contract_type=payload.contract_type,
        status=ContractRequestStatus.OPEN.value,
        priority=payload.priority,
        requester_name=payload.requester_name,
        requester_email=payload.requester_email,
        counterparty_name=payload.counterparty_name,
        due_date=payload.due_date,
        assigned_to=payload.assigned_to,
        linked_contract_id=payload.linked_contract_id,
        linked_template_id=payload.linked_template_id,
        created_by=user.id,
        metadata_json=payload.metadata_json,
    )
    session.add(request)
    await session.flush()

    # Auto-create the corresponding work-queue item in the same
    # transaction. If the inbox insert fails the request insert is
    # rolled back too — they belong together.
    inbox_item = InboxItem(
        organization_id=org_id,
        title=f"Review request: {request.title}",
        item_type="request_review",
        status=InboxItemStatus.OPEN.value,
        priority=request.priority,
        assigned_to=request.assigned_to,
        due_date=request.due_date,
        request_id=request.id,
        created_by=user.id,
    )
    session.add(inbox_item)
    await session.flush()
    await apply_approval_policies_to_request(session, request, user.id)
    await session.refresh(request)

    return ContractRequestResponse.model_validate(request)


@router.get("", response_model=list[ContractRequestResponse])
async def list_requests(
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
    status: str | None = None,
    request_type: str | None = None,
    contract_type: str | None = None,
    priority: str | None = None,
    assigned_to: uuid.UUID | None = None,
    due_before: str | None = Query(default=None, description="ISO date (YYYY-MM-DD)."),
    due_after: str | None = Query(default=None, description="ISO date (YYYY-MM-DD)."),
    include_cancelled: bool = Query(default=False),
) -> list[ContractRequestResponse]:
    user = await _current_dev_user(session, x_whereas_dev_user)
    stmt = select(ContractRequest).where(
        ContractRequest.organization_id == user.organization_id
    )
    if not include_cancelled:
        stmt = stmt.where(
            ContractRequest.status != ContractRequestStatus.CANCELLED.value
        )
    if status:
        if status not in _VALID_STATUSES:
            raise HTTPException(status_code=422, detail="Invalid status filter.")
        stmt = stmt.where(ContractRequest.status == status)
    if request_type:
        stmt = stmt.where(ContractRequest.request_type == request_type)
    if contract_type:
        stmt = stmt.where(ContractRequest.contract_type == contract_type)
    if priority:
        stmt = stmt.where(ContractRequest.priority == priority)
    if assigned_to is not None:
        stmt = stmt.where(ContractRequest.assigned_to == assigned_to)
    if due_before:
        stmt = stmt.where(ContractRequest.due_date <= _parse_date(due_before, "due_before"))
    if due_after:
        stmt = stmt.where(ContractRequest.due_date >= _parse_date(due_after, "due_after"))

    stmt = stmt.order_by(
        ContractRequest.created_at.desc(), ContractRequest.id.desc()
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [ContractRequestResponse.model_validate(r) for r in rows]


@router.get("/{request_id}", response_model=ContractRequestResponse)
async def get_request(
    request_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractRequestResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(session, request_id, user.organization_id)
    return ContractRequestResponse.model_validate(request)


@router.patch("/{request_id}", response_model=ContractRequestResponse)
async def update_request(
    request_id: uuid.UUID,
    payload: ContractRequestUpdateRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ContractRequestResponse:
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(session, request_id, user.organization_id)

    data = payload.model_dump(exclude_unset=True)

    if "status" in data and data["status"] not in _VALID_STATUSES:
        raise HTTPException(status_code=422, detail="Invalid request status.")

    new_links = {
        "linked_contract_id": data.get(
            "linked_contract_id", request.linked_contract_id
        ),
        "linked_template_id": data.get(
            "linked_template_id", request.linked_template_id
        ),
    }
    if (
        "linked_contract_id" in data
        or "linked_template_id" in data
    ):
        await _validate_links(
            session,
            request.organization_id,
            new_links["linked_contract_id"],
            new_links["linked_template_id"],
        )
    if "assigned_to" in data and data["assigned_to"] is not None:
        await _validate_user_in_org(
            session, data["assigned_to"], request.organization_id
        )

    for key, value in data.items():
        setattr(request, key, value)

    await session.flush()

    policy_fields = {"request_type", "contract_type", "priority", "linked_template_id"}
    if any(k in data for k in policy_fields):
        await apply_approval_policies_to_request(session, request, user.id)

    # If this update transitions the request to a terminal state, mark
    # any open ``request_review`` inbox items pointing at it as
    # completed/dismissed in the same transaction. Item-level edits
    # (assignee, due date, priority) are intentionally NOT mirrored: the
    # inbox item is its own work record once it exists.
    if "status" in data and request.status in _TERMINAL_STATUSES:
        await _resolve_request_review_inbox_items(session, request)

    await session.refresh(request)
    return ContractRequestResponse.model_validate(request)


@router.delete("/{request_id}", status_code=204)
async def cancel_request(
    request_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> None:
    """Soft delete: marks the request as ``cancelled`` and dismisses
    any open ``request_review`` inbox items that pointed at it.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(session, request_id, user.organization_id)
    request.status = ContractRequestStatus.CANCELLED.value
    await session.flush()
    await _resolve_request_review_inbox_items(session, request)


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------


@router.post(
    "/{request_id}/convert-to-contract",
    response_model=ConvertRequestToContractResponse,
    status_code=201,
)
async def convert_request_to_contract(
    request_id: uuid.UUID,
    payload: ConvertRequestToContractRequest,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> ConvertRequestToContractResponse:
    """Convert an open request into a draft Contract via its linked template.

    Reuses ``generate_docx_from_template`` from the agreement-templates
    surface so there is exactly one code path that turns a template +
    variable values into a draft Contract + ``generated_docx`` artifact.
    On success we link the new Contract back onto the request, mark the
    request ``completed``, and resolve any open ``request_review`` inbox
    item in the same transaction.

    Validation rules:
      * The request must belong to the caller's org (404 otherwise).
      * The request must not be cancelled (409).
      * The request must not already have a linked contract (409).
      * The request must have a linked template (409); that template
        must belong to the same org (404 otherwise — guarded by the
        same-org invariant on creation, but defended again here).
        Archived templates ARE still convertible — once a request
        links to a template the link survives template archive. This
        matches the link semantics on creation/update (see
        ``_validate_links``) and avoids stranding requests when a
        template is retired between intake and conversion.
      * Variable validation errors propagate from the generation
        service as 400 (unknown / missing required / malformed value).

    Failure semantics:
      * If template generation raises, no request/inbox state mutates.
        ``get_db`` rolls the whole request-scoped transaction back.
      * Markdown conversion failure is non-fatal — the response still
        succeeds with ``markdown_snapshot=None``.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(
        session, request_id, user.organization_id
    )

    if request.status == ContractRequestStatus.CANCELLED.value:
        raise HTTPException(
            status_code=409,
            detail="Cancelled requests cannot be converted to a contract.",
        )
    if request.linked_contract_id is not None:
        raise HTTPException(
            status_code=409,
            detail="This request is already linked to a contract.",
        )
    if request.linked_template_id is None:
        raise HTTPException(
            status_code=409,
            detail="Link an agreement template to this request before converting.",
        )

    template_stmt = select(AgreementTemplate).where(
        AgreementTemplate.id == request.linked_template_id,
        AgreementTemplate.organization_id == request.organization_id,
    )
    template = (await session.execute(template_stmt)).scalar_one_or_none()
    if template is None:
        # The link survived (e.g. the template was archived/deleted, or
        # a stale row predates the same-org invariant). Treat this as a
        # not-found from the caller's perspective rather than leaking
        # the orphan state.
        raise HTTPException(
            status_code=404,
            detail="Linked agreement template not found.",
        )

    settings = get_settings()
    org = await _load_organization(session, user.organization_id)
    org_master_key = _load_org_key_or_http(org)
    storage = DocumentStorage(settings)
    try:
        result = await generate_docx_from_template(
            session,
            template=template,
            variable_values=payload.variable_values,
            generated_title=payload.title,
            user_id=user.id,
            org_master_key=org_master_key,
            storage=storage,
        )
    except TemplateGenerationError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail=str(exc)
        ) from exc
    finally:
        del org_master_key

    # Link the new contract back to the request and close out the
    # workflow. Doing this in the same session/transaction means a
    # failure here rolls the generation back too: we never end up with
    # a Contract that has no request pointing at it OR a request that
    # claims a contract id that doesn't exist.
    request.linked_contract_id = result.contract.id
    request.status = ContractRequestStatus.COMPLETED.value
    await session.flush()
    await _resolve_request_review_inbox_items(session, request)

    await session.refresh(request)
    await session.refresh(result.contract)
    await session.refresh(result.artifact)
    snapshot_response: ContractMarkdownSnapshotResponse | None = None
    if result.markdown_snapshot is not None:
        await session.refresh(result.markdown_snapshot)
        snapshot_response = ContractMarkdownSnapshotResponse.model_validate(
            result.markdown_snapshot
        )
    return ConvertRequestToContractResponse(
        request=ContractRequestResponse.model_validate(request),
        contract=ContractListItemResponse.model_validate(result.contract),
        artifact=ContractArtifactResponse.model_validate(result.artifact),
        markdown_snapshot=snapshot_response,
        variables_used=result.variables_used,
    )


# ---------------------------------------------------------------------------
# Approval visibility (PR #56)
#
# Read-only stitch of policies + workflow runs + the gate result for a
# single request. Reuses ``find_matching_approval_policies`` and
# ``can_send_contract_to_docuseal`` so the answer here cannot drift away
# from the live gate; the UI uses this to render badges / step lists /
# blocking reasons on the Requests page without flipping between pages.
# ---------------------------------------------------------------------------


# Plain-English phrasing for each gate code so every client renders the
# same string. Codes themselves come from ``approval_gating.ApprovalGateResult``;
# extending that enum requires extending this map (covered by tests).
_GATE_REASON_TEXT: dict[str, str] = {
    "active_approval_workflows": (
        "An approval workflow is still active and waiting on a decision."
    ),
    "rejected_approval_workflows": (
        "An approval workflow was rejected; resolve or restart before sending."
    ),
    "required_approval_policy_unmet": (
        "A required approval policy has not been satisfied."
    ),
    "cancelled_without_completed_approval": (
        "All attached approval workflows were cancelled without a completed approval."
    ),
}


@router.get(
    "/{request_id}/approval-status",
    response_model=RequestApprovalStatusResponse,
)
async def get_request_approval_status(
    request_id: uuid.UUID,
    session: DbSession,
    x_whereas_dev_user: Annotated[str | None, Header()] = None,
) -> RequestApprovalStatusResponse:
    """Return matching policies + attached workflows + a gate-aligned summary.

    Visibility only — never mutates state, never auto-creates workflows.
    Cross-org access returns 404 (via ``_get_request_for_org``). Storage
    internals are excluded by construction: every nested response model
    sets ``extra="forbid"`` and only allowlists scalar fields.
    """
    user = await _current_dev_user(session, x_whereas_dev_user)
    request = await _get_request_for_org(
        session, request_id, user.organization_id
    )

    # Policies that match this request *as it stands today*. We pass
    # ``applies_to_generated_contracts=None`` so the visibility surface
    # shows every match — not just the ones the gate cares about — so a
    # user can see, for example, an internal-only policy that's
    # auto-attaching a workflow even though it doesn't gate signature.
    matching_policies = await find_matching_approval_policies(session, request)

    # Workflow runs attached to this request and (if applicable) the
    # linked contract. Cross-org rows are filtered by the same
    # ``organization_id`` constraint used everywhere else.
    workflow_stmt = (
        select(ApprovalWorkflowRun)
        .where(
            ApprovalWorkflowRun.organization_id == request.organization_id,
            _workflow_links_request(request),
        )
        .order_by(
            ApprovalWorkflowRun.started_at.asc(),
            ApprovalWorkflowRun.id.asc(),
        )
    )
    workflow_rows = (
        (await session.execute(workflow_stmt)).scalars().unique().all()
    )

    # Bulk-load steps for the runs we found so the response is one
    # query for the run set + one query for all steps.
    workflow_ids = [w.id for w in workflow_rows]
    steps_by_run: dict[uuid.UUID, list[ApprovalStep]] = {
        wid: [] for wid in workflow_ids
    }
    if workflow_ids:
        step_stmt = (
            select(ApprovalStep)
            .where(ApprovalStep.workflow_run_id.in_(workflow_ids))
            .order_by(
                ApprovalStep.workflow_run_id.asc(),
                ApprovalStep.step_order.asc(),
                ApprovalStep.id.asc(),
            )
        )
        for step in (await session.execute(step_stmt)).scalars().all():
            steps_by_run.setdefault(step.workflow_run_id, []).append(step)

    workflow_summaries = [
        _build_workflow_summary(w, steps_by_run.get(w.id, []))
        for w in workflow_rows
    ]
    policy_summaries = [
        RequestApprovalPolicySummary.model_validate(p) for p in matching_policies
    ]

    summary = await _build_approval_summary(
        session, request, matching_policies, workflow_rows
    )

    return RequestApprovalStatusResponse(
        request_id=request.id,
        linked_contract_id=request.linked_contract_id,
        matching_policy_ids=[p.id for p in matching_policies],
        matching_policies=policy_summaries,
        workflow_runs=workflow_summaries,
        summary=summary,
    )


def _workflow_links_request(request: ContractRequest):
    """``workflow_run_id == request_id OR workflow_run.contract_id == linked_contract_id``.

    Split out so the query can short-circuit cleanly when there's no
    linked contract — most requests don't have one.
    """
    from sqlalchemy import or_

    if request.linked_contract_id is None:
        return ApprovalWorkflowRun.request_id == request.id
    return or_(
        ApprovalWorkflowRun.request_id == request.id,
        ApprovalWorkflowRun.contract_id == request.linked_contract_id,
    )


def _build_workflow_summary(
    run: ApprovalWorkflowRun,
    steps: list[ApprovalStep],
) -> RequestApprovalWorkflowSummary:
    metadata = run.metadata_json or {}
    source_id_raw = metadata.get("source_approval_policy_id")
    source_id: uuid.UUID | None = None
    if isinstance(source_id_raw, str):
        try:
            source_id = uuid.UUID(source_id_raw)
        except (TypeError, ValueError):
            # Bad metadata shouldn't break the visibility surface — fall
            # back to None and let the UI render "ad-hoc workflow".
            source_id = None
    source_name = metadata.get("source_approval_policy_name")
    if not isinstance(source_name, str):
        source_name = None
    return RequestApprovalWorkflowSummary(
        id=run.id,
        name=run.name,
        status=run.status,
        current_step_order=run.current_step_order,
        started_at=run.started_at,
        completed_at=run.completed_at,
        source_approval_policy_id=source_id,
        source_approval_policy_name=source_name,
        steps=[RequestApprovalStepSummary.model_validate(s) for s in steps],
    )


async def _build_approval_summary(
    session: AsyncSession,
    request: ContractRequest,
    matching_policies: list,
    workflow_rows: list[ApprovalWorkflowRun],
) -> RequestApprovalSummary:
    has_required_policies = any(
        p.applies_to_generated_contracts for p in matching_policies
    )
    statuses = [w.status for w in workflow_rows]
    has_active = ApprovalWorkflowRunStatus.ACTIVE.value in statuses
    has_rejected = ApprovalWorkflowRunStatus.REJECTED.value in statuses
    has_completed = ApprovalWorkflowRunStatus.COMPLETED.value in statuses

    # Whether every required-gate policy has at least one completed
    # policy-derived workflow. Mirrors the gate logic exactly so the UI
    # cannot disagree with the actual send decision.
    completed_policy_ids = {
        str((w.metadata_json or {}).get("source_approval_policy_id"))
        for w in workflow_rows
        if w.status == ApprovalWorkflowRunStatus.COMPLETED.value
    }
    required_policy_ids_str = {
        str(p.id) for p in matching_policies if p.applies_to_generated_contracts
    }
    all_required_completed = required_policy_ids_str.issubset(completed_policy_ids)

    ready_for_signature: bool | None = None
    blocking_reason: str | None = None
    if request.linked_contract_id is not None:
        contract = (
            await session.execute(
                select(Contract).where(
                    Contract.id == request.linked_contract_id,
                    Contract.organization_id == request.organization_id,
                )
            )
        ).scalar_one_or_none()
        if contract is not None:
            gate = await can_send_contract_to_docuseal(
                session, contract, request.organization_id
            )
            ready_for_signature = gate.allowed
            if not gate.allowed:
                blocking_reason = gate.code

    if blocking_reason is None and ready_for_signature is None:
        # No linked contract: derive a soft blocker for the UI even
        # though the gate wasn't consulted. Don't claim "ready" in this
        # branch — there's nothing to send yet.
        if has_active:
            blocking_reason = "active_approval_workflows"
        elif has_rejected:
            blocking_reason = "rejected_approval_workflows"
        elif has_required_policies and not all_required_completed:
            blocking_reason = "required_approval_policy_unmet"

    return RequestApprovalSummary(
        has_required_policies=has_required_policies,
        has_active_workflows=has_active,
        has_rejected_workflows=has_rejected,
        has_completed_workflows=has_completed,
        all_required_policy_workflows_completed=all_required_completed,
        ready_for_signature=ready_for_signature,
        blocking_reason=blocking_reason,
        blocking_reason_text=_GATE_REASON_TEXT.get(blocking_reason)
        if blocking_reason
        else None,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_request_for_org(
    session: AsyncSession,
    request_id: uuid.UUID,
    organization_id: uuid.UUID,
) -> ContractRequest:
    stmt = select(ContractRequest).where(
        ContractRequest.id == request_id,
        ContractRequest.organization_id == organization_id,
    )
    request = (await session.execute(stmt)).scalar_one_or_none()
    if request is None:
        raise HTTPException(status_code=404, detail="Contract request not found.")
    return request


async def _validate_links(
    session: AsyncSession,
    organization_id: uuid.UUID,
    linked_contract_id: uuid.UUID | None,
    linked_template_id: uuid.UUID | None,
) -> None:
    if linked_contract_id is not None:
        stmt = select(Contract.id).where(
            Contract.id == linked_contract_id,
            Contract.organization_id == organization_id,
        )
        if (await session.execute(stmt)).scalar_one_or_none() is None:
            raise HTTPException(
                status_code=422,
                detail="Linked contract must belong to the same organization.",
            )
    if linked_template_id is not None:
        stmt = select(AgreementTemplate.id).where(
            AgreementTemplate.id == linked_template_id,
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


async def _resolve_request_review_inbox_items(
    session: AsyncSession,
    request: ContractRequest,
) -> None:
    new_status = (
        InboxItemStatus.DISMISSED.value
        if request.status == ContractRequestStatus.CANCELLED.value
        else InboxItemStatus.COMPLETED.value
    )
    stmt = select(InboxItem).where(
        InboxItem.request_id == request.id,
        InboxItem.organization_id == request.organization_id,
        InboxItem.item_type == "request_review",
        InboxItem.status == InboxItemStatus.OPEN.value,
    )
    rows = (await session.execute(stmt)).scalars().all()
    for item in rows:
        item.status = new_status
    if rows:
        await session.flush()


def _parse_date(value: str, field_name: str):
    from datetime import date

    try:
        return date.fromisoformat(value)
    except ValueError as e:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid date for {field_name}; expected YYYY-MM-DD.",
        ) from e
