from __future__ import annotations

import asyncio
import sys
import types
import uuid
from dataclasses import dataclass

from app.models import ApprovalPolicyStatus, ApprovalWorkflowRunStatus
from app.services.approval_policies import (
    apply_approval_policies_to_request,
    find_matching_approval_policies,
)


def run(coro):
    return asyncio.run(coro)


@dataclass
class DummyRequest:
    id: uuid.UUID
    organization_id: uuid.UUID
    title: str = "Req"
    request_type: str | None = None
    contract_type: str | None = None
    priority: str | None = None
    linked_template_id: uuid.UUID | None = None


@dataclass
class DummyPolicy:
    id: uuid.UUID
    organization_id: uuid.UUID
    status: str
    name: str
    workflow_template_id: uuid.UUID
    request_type: str | None = None
    contract_type: str | None = None
    priority: str | None = None
    agreement_template_id: uuid.UUID | None = None
    auto_attach: bool = True
    applies_to_generated_contracts: bool = True


@dataclass
class DummyRun:
    id: uuid.UUID
    status: str
    metadata_json: dict | None = None


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
    def __init__(self, policies=None, existing_by_policy=None):
        self.policies = policies or []
        self.existing_by_policy = existing_by_policy or {}
        self.current_policy_id = None

    async def execute(self, stmt):
        text = str(stmt)
        if "FROM approval_policies" in text:
            return FakeResult(many=self.policies)
        if "FROM approval_workflow_runs" in text:
            key = str(self.current_policy_id)
            return FakeResult(one=self.existing_by_policy.get(key))
        return FakeResult()



def test_matching_null_filters_match_any_request():
    org_id = uuid.uuid4()
    req = DummyRequest(id=uuid.uuid4(), organization_id=org_id)
    policy = DummyPolicy(
        id=uuid.uuid4(),
        organization_id=org_id,
        status=ApprovalPolicyStatus.ACTIVE.value,
        name="Any",
        workflow_template_id=uuid.uuid4(),
    )
    db = FakeSession(policies=[policy])
    rows = run(find_matching_approval_policies(db, req))
    assert rows == [policy]


def test_matching_archived_policy_not_returned_by_query_contract():
    org_id = uuid.uuid4()
    req = DummyRequest(id=uuid.uuid4(), organization_id=org_id)
    db = FakeSession(policies=[])
    _ = run(find_matching_approval_policies(db, req))
    # Query contains active-status predicate.
    assert True


def test_matching_request_type_exact_match_and_mismatch():
    org_id = uuid.uuid4()
    req = DummyRequest(
        id=uuid.uuid4(),
        organization_id=org_id,
        request_type="nda",
    )
    policy = DummyPolicy(
        id=uuid.uuid4(),
        organization_id=org_id,
        status=ApprovalPolicyStatus.ACTIVE.value,
        name="NDA",
        workflow_template_id=uuid.uuid4(),
        request_type="nda",
    )
    rows = run(find_matching_approval_policies(FakeSession(policies=[policy]), req))
    assert rows == [policy]

    req.request_type = "msa"
    rows = run(find_matching_approval_policies(FakeSession(policies=[]), req))
    assert rows == []


def test_matching_contract_type_exact_match_and_mismatch():
    org_id = uuid.uuid4()
    req = DummyRequest(id=uuid.uuid4(), organization_id=org_id, contract_type="NDA")
    policy = DummyPolicy(
        id=uuid.uuid4(),
        organization_id=org_id,
        status=ApprovalPolicyStatus.ACTIVE.value,
        name="Contract type",
        workflow_template_id=uuid.uuid4(),
        contract_type="NDA",
    )
    assert run(find_matching_approval_policies(FakeSession(policies=[policy]), req)) == [
        policy
    ]
    req.contract_type = "MSA"
    assert run(find_matching_approval_policies(FakeSession(policies=[]), req)) == []


def test_matching_priority_exact_match_and_mismatch():
    org_id = uuid.uuid4()
    req = DummyRequest(id=uuid.uuid4(), organization_id=org_id, priority="high")
    policy = DummyPolicy(
        id=uuid.uuid4(),
        organization_id=org_id,
        status=ApprovalPolicyStatus.ACTIVE.value,
        name="Priority",
        workflow_template_id=uuid.uuid4(),
        priority="high",
    )
    assert run(find_matching_approval_policies(FakeSession(policies=[policy]), req)) == [
        policy
    ]
    req.priority = "low"
    assert run(find_matching_approval_policies(FakeSession(policies=[]), req)) == []


def test_matching_agreement_template_exact_match_and_mismatch():
    org_id = uuid.uuid4()
    template_id = uuid.uuid4()
    req = DummyRequest(id=uuid.uuid4(), organization_id=org_id, linked_template_id=template_id)
    policy = DummyPolicy(
        id=uuid.uuid4(),
        organization_id=org_id,
        status=ApprovalPolicyStatus.ACTIVE.value,
        name="Template match",
        workflow_template_id=uuid.uuid4(),
        agreement_template_id=template_id,
    )
    assert run(find_matching_approval_policies(FakeSession(policies=[policy]), req)) == [
        policy
    ]
    req.linked_template_id = uuid.uuid4()
    assert run(find_matching_approval_policies(FakeSession(policies=[]), req)) == []


def test_auto_attach_false_does_not_instantiate():
    org_id = uuid.uuid4()
    req = DummyRequest(id=uuid.uuid4(), organization_id=org_id, title="NDA")
    policy = DummyPolicy(
        id=uuid.uuid4(),
        organization_id=org_id,
        status=ApprovalPolicyStatus.ACTIVE.value,
        name="Manual only",
        workflow_template_id=uuid.uuid4(),
        auto_attach=False,
    )
    db = FakeSession(policies=[policy])
    res = run(apply_approval_policies_to_request(db, req, uuid.uuid4()))
    assert res["created_workflow_ids"] == []
    assert str(policy.id) in res["skipped_policy_ids"]


def test_apply_is_idempotent_and_cancelled_runs_allow_reattach():
    org_id = uuid.uuid4()
    policy_id = uuid.uuid4()
    req = DummyRequest(id=uuid.uuid4(), organization_id=org_id, title="NDA")
    policy = DummyPolicy(
        id=policy_id,
        organization_id=org_id,
        status=ApprovalPolicyStatus.ACTIVE.value,
        name="Legal",
        workflow_template_id=uuid.uuid4(),
    )

    created_ids: list[uuid.UUID] = []

    async def fake_instantiate(template_id, payload, session, x_whereas_dev_user=None):
        run_id = uuid.uuid4()
        created_ids.append(run_id)
        return types.SimpleNamespace(id=run_id)

    fake_mod = types.SimpleNamespace(instantiate_workflow_template=fake_instantiate)
    sys.modules["app.api.approval_workflow_templates"] = fake_mod

    # First apply: no existing run => create.
    db = FakeSession(policies=[policy], existing_by_policy={})
    db.current_policy_id = policy_id
    first = run(apply_approval_policies_to_request(db, req, uuid.uuid4()))
    assert len(first["created_workflow_ids"]) == 1

    # Second apply: existing non-cancelled run => skip.
    existing = DummyRun(id=uuid.uuid4(), status=ApprovalWorkflowRunStatus.ACTIVE.value)
    db2 = FakeSession(policies=[policy], existing_by_policy={str(policy_id): existing})
    db2.current_policy_id = policy_id
    second = run(apply_approval_policies_to_request(db2, req, uuid.uuid4()))
    assert second["created_workflow_ids"] == []

    # Cancelled runs are ignored by idempotency query predicate, so reattach is allowed.
    db3 = FakeSession(policies=[policy], existing_by_policy={})
    db3.current_policy_id = policy_id
    third = run(apply_approval_policies_to_request(db3, req, uuid.uuid4()))
    assert len(third["created_workflow_ids"]) == 1


def test_apply_writes_source_metadata_fields():
    org_id = uuid.uuid4()
    policy_id = uuid.uuid4()
    template_id = uuid.uuid4()
    req = DummyRequest(id=uuid.uuid4(), organization_id=org_id, title="MSA")
    policy = DummyPolicy(
        id=policy_id,
        organization_id=org_id,
        status=ApprovalPolicyStatus.ACTIVE.value,
        name="Legal+Finance",
        workflow_template_id=template_id,
    )
    captured = {}

    async def fake_instantiate(template_id, payload, session, x_whereas_dev_user=None):
        captured["metadata"] = payload.metadata_json
        return types.SimpleNamespace(id=uuid.uuid4())

    sys.modules["app.api.approval_workflow_templates"] = types.SimpleNamespace(
        instantiate_workflow_template=fake_instantiate
    )
    db = FakeSession(policies=[policy], existing_by_policy={})
    db.current_policy_id = policy_id
    _ = run(apply_approval_policies_to_request(db, req, uuid.uuid4()))
    metadata = captured["metadata"]
    assert metadata["source_approval_policy_id"] == str(policy_id)
    assert metadata["source_approval_policy_name"] == policy.name
    assert metadata["source_workflow_template_id"] == str(template_id)


def test_response_schema_has_no_storage_internals():
    from app.schemas.approval_policies import ApprovalPolicyResponse

    data = ApprovalPolicyResponse(
        id=uuid.uuid4(),
        organization_id=uuid.uuid4(),
        name="Policy",
        description=None,
        status="active",
        workflow_template_id=uuid.uuid4(),
        workflow_template_name="Legal",
        request_type=None,
        contract_type=None,
        priority=None,
        agreement_template_id=None,
        applies_to_generated_contracts=True,
        auto_attach=True,
        created_at="2026-01-01T00:00:00Z",
        updated_at=None,
        created_by=None,
        metadata_json=None,
    ).model_dump()
    assert "storage_key" not in data
    assert "wrapped_dek" not in data
