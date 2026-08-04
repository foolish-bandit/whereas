from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

import pytest
from pydantic import ValidationError

from app.schemas.inbox_items import InboxItemResponse
from app.schemas.remediation import (
    FindingRemediationPlanResponse,
    FindingRemediationTaskRequest,
    FindingRemediationTaskResponse,
)

ORG_ID = uuid.UUID("00000000-0000-4000-8000-000000000001")
CONTRACT_ID = uuid.UUID("00000000-0000-4000-8000-000000000002")
FINDING_ID = uuid.UUID("00000000-0000-4000-8000-000000000003")
RUN_ID = uuid.UUID("00000000-0000-4000-8000-000000000004")
PLAYBOOK_ID = uuid.UUID("00000000-0000-4000-8000-000000000005")
TASK_ID = uuid.UUID("00000000-0000-4000-8000-000000000006")
USER_ID = uuid.UUID("00000000-0000-4000-8000-000000000007")
SOURCE_ID = uuid.UUID("00000000-0000-4000-8000-000000000008")
NOW = datetime(2026, 8, 4, tzinfo=UTC)


def _task() -> InboxItemResponse:
    return InboxItemResponse(
        id=TASK_ID,
        organization_id=ORG_ID,
        title="Remediate: Governing law",
        description="Review the finding.",
        item_type="finding_remediation",
        status="open",
        priority="high",
        assigned_to=USER_ID,
        due_date=date(2026, 8, 14),
        request_id=None,
        contract_id=CONTRACT_ID,
        template_id=None,
        created_at=NOW,
        updated_at=NOW,
        created_by=USER_ID,
        metadata_json={"finding_id": str(FINDING_ID)},
    )


def _plan(**overrides) -> FindingRemediationPlanResponse:
    values = {
        "finding_id": FINDING_ID,
        "contract_id": CONTRACT_ID,
        "review_run_id": RUN_ID,
        "playbook_id": PLAYBOOK_ID,
        "rule_id": "governing-law-california",
        "rule_title": "Governing law should be California",
        "clause_type": "governing_law",
        "severity": "high",
        "finding_status": "open",
        "suggested_language": "The laws of California govern.",
        "source_type": "clause_template",
        "source_id": SOURCE_ID,
        "source_name": "California Governing Law",
        "rationale": "Selected the preferred Clause Manager source.",
        "scope_warning": None,
        "existing_task": None,
    }
    values.update(overrides)
    return FindingRemediationPlanResponse(**values)


def test_task_request_forbids_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        FindingRemediationTaskRequest.model_validate(
            {"due_date": "2026-08-14", "secret_override": True}
        )


def test_task_request_parses_optional_assignment_and_due_date() -> None:
    request = FindingRemediationTaskRequest(
        assigned_to=USER_ID,
        due_date="2026-08-14",
    )
    assert request.assigned_to == USER_ID
    assert request.due_date == date(2026, 8, 14)


def test_plan_supports_approved_language_with_provenance() -> None:
    plan = _plan()
    assert plan.source_type == "clause_template"
    assert plan.source_id == SOURCE_ID
    assert plan.suggested_language.startswith("The laws")
    assert plan.existing_task is None


def test_plan_supports_honest_no_language_state_and_existing_task() -> None:
    plan = _plan(
        suggested_language=None,
        source_type="none",
        source_id=None,
        source_name=None,
        existing_task=_task(),
    )
    assert plan.suggested_language is None
    assert plan.source_type == "none"
    assert plan.existing_task is not None
    assert plan.existing_task.id == TASK_ID


def test_task_response_reports_creation_and_reopen_state() -> None:
    response = FindingRemediationTaskResponse(
        plan=_plan(existing_task=_task()),
        task=_task(),
        created=False,
        reopened=True,
    )
    assert response.created is False
    assert response.reopened is True
    assert response.plan.existing_task.id == response.task.id
