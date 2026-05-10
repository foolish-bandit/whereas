from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass

from app.models import ApprovalWorkflowRunStatus
from app.services.approval_gating import can_send_contract_to_docuseal


@dataclass
class DummyContract:
    id: uuid.UUID


@dataclass
class DummyRequest:
    id: uuid.UUID


@dataclass
class DummyWorkflow:
    id: uuid.UUID
    status: str


class FakeResult:
    def __init__(self, one=None, many=None):
        self._one = one
        self._many = many or []

    def scalar_one_or_none(self):
        return self._one

    def scalars(self):
        return self

    def all(self):
        return self._many


class FakeSession:
    def __init__(self, request_obj, workflows):
        self.request_obj = request_obj
        self.workflows = workflows
        self.calls = []

    async def execute(self, stmt):
        self.calls.append(str(stmt))
        if len(self.calls) == 1:
            return FakeResult(one=self.request_obj)
        return FakeResult(many=self.workflows)


def run(coro):
    return asyncio.run(coro)


def make_workflow(status: str) -> DummyWorkflow:
    return DummyWorkflow(id=uuid.uuid4(), status=status)


def test_no_linked_request_allowed():
    db = FakeSession(request_obj=None, workflows=[])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert res.allowed is True
    assert res.code == "no_linked_request"
    assert res.request_id is None


def test_linked_request_no_workflows_allowed():
    req = DummyRequest(id=uuid.uuid4())
    db = FakeSession(request_obj=req, workflows=[])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert res.allowed is True
    assert res.code == "no_workflows_required"


def test_active_blocks_and_counts_and_ids():
    req = DummyRequest(id=uuid.uuid4())
    active = make_workflow(ApprovalWorkflowRunStatus.ACTIVE.value)
    completed = make_workflow(ApprovalWorkflowRunStatus.COMPLETED.value)
    db = FakeSession(request_obj=req, workflows=[active, completed])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert res.allowed is False
    assert res.code == "active_approval_workflows"
    assert res.blocking_workflow_ids == [active.id]
    assert res.completed_workflow_ids == [completed.id]
    assert res.active_count == 1 and res.completed_count == 1


def test_rejected_blocks():
    req = DummyRequest(id=uuid.uuid4())
    rejected = make_workflow(ApprovalWorkflowRunStatus.REJECTED.value)
    db = FakeSession(request_obj=req, workflows=[rejected])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert (res.allowed, res.code) == (False, "rejected_approval_workflows")


def test_completed_allows():
    req = DummyRequest(id=uuid.uuid4())
    completed = make_workflow(ApprovalWorkflowRunStatus.COMPLETED.value)
    cancelled = make_workflow(ApprovalWorkflowRunStatus.CANCELLED.value)
    db = FakeSession(request_obj=req, workflows=[cancelled, completed])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert (res.allowed, res.code) == (True, "approvals_completed")


def test_cancelled_only_blocks():
    req = DummyRequest(id=uuid.uuid4())
    cancelled = make_workflow(ApprovalWorkflowRunStatus.CANCELLED.value)
    db = FakeSession(request_obj=req, workflows=[cancelled])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert (res.allowed, res.code) == (False, "cancelled_without_completed_approval")


def test_queries_are_org_scoped_and_safe_dict_has_no_storage_fields():
    req = DummyRequest(id=uuid.uuid4())
    db = FakeSession(request_obj=req, workflows=[])
    org_id = uuid.uuid4()
    _ = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), org_id))
    assert any("contract_requests.organization_id" in c for c in db.calls)
    assert any("approval_workflow_runs.organization_id" in c for c in db.calls)

    safe = _.to_safe_dict()
    assert "storage_key" not in safe
    assert "wrapped_dek" not in safe
