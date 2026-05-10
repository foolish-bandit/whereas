from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field

import app.services.approval_gating as gating
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


@dataclass
class DummyPolicy:
    id: uuid.UUID
    name: str = "Standard Legal Review"
    workflow_template_id: uuid.UUID = field(default_factory=uuid.uuid4)
    auto_attach: bool = True
    applies_to_generated_contracts: bool = True
    request_type: str | None = None
    contract_type: str | None = None
    priority: str | None = None
    agreement_template_id: uuid.UUID | None = None


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


def test_required_policy_unmet_blocks_and_ids_reported(monkeypatch):
    policy_id = uuid.uuid4()
    template_id = uuid.uuid4()

    async def fake_match(*_args, **_kwargs):
        return [
            DummyPolicy(
                id=policy_id,
                name="Standard Legal Review",
                workflow_template_id=template_id,
            )
        ]

    monkeypatch.setattr(gating, "find_matching_approval_policies", fake_match)
    req = DummyRequest(id=uuid.uuid4())
    db = FakeSession(request_obj=req, workflows=[])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert res.allowed is False
    assert res.code == "required_approval_policy_unmet"
    assert res.required_policy_ids == [policy_id]
    assert res.missing_policy_ids == [policy_id]
    # PR #59: gate now includes named summaries so the UI doesn't have
    # to look them up. Names appear on both sides and align with ids.
    assert [p.id for p in res.required_policies] == [policy_id]
    assert [p.id for p in res.missing_policies] == [policy_id]
    assert res.missing_policies[0].name == "Standard Legal Review"
    assert res.required_policies[0].workflow_template_id == template_id


def test_completed_policy_workflow_satisfies_but_unrelated_completed_does_not(monkeypatch):
    policy_id = uuid.uuid4()

    async def fake_match(*_args, **_kwargs):
        return [DummyPolicy(id=policy_id)]

    monkeypatch.setattr(gating, "find_matching_approval_policies", fake_match)

    unrelated = DummyWorkflow(
        id=uuid.uuid4(),
        status=ApprovalWorkflowRunStatus.COMPLETED.value,
        metadata_json={"source_approval_policy_id": str(uuid.uuid4())},
    )
    db = FakeSession(request_obj=DummyRequest(id=uuid.uuid4()), workflows=[unrelated])
    blocked = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert blocked.code == "required_approval_policy_unmet"

    matched = DummyWorkflow(
        id=uuid.uuid4(),
        status=ApprovalWorkflowRunStatus.COMPLETED.value,
        metadata_json={"source_approval_policy_id": str(policy_id)},
    )
    db2 = FakeSession(request_obj=DummyRequest(id=uuid.uuid4()), workflows=[matched])
    allowed = run(can_send_contract_to_docuseal(db2, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert allowed.allowed is True
    assert allowed.code == "approvals_completed"


def test_required_policy_summaries_sorted_by_name_for_stable_ui_order(monkeypatch):
    # Two policies returned in a "wrong" order from the DB-mock — the
    # gate should re-sort by name so the SendToDocuSeal panel renders
    # them in a stable order across requests, and ids stay aligned.
    p_zeta = DummyPolicy(id=uuid.uuid4(), name="Zeta Reviewer")
    p_alpha = DummyPolicy(id=uuid.uuid4(), name="Alpha Reviewer")

    async def fake_match(*_args, **_kwargs):
        return [p_zeta, p_alpha]

    monkeypatch.setattr(gating, "find_matching_approval_policies", fake_match)
    db = FakeSession(request_obj=DummyRequest(id=uuid.uuid4()), workflows=[])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))

    assert [p.name for p in res.required_policies] == ["Alpha Reviewer", "Zeta Reviewer"]
    # Ids on the back-compat list line up element-by-element with the
    # named summaries — that invariant is what lets the frontend pick
    # either side without re-sorting.
    assert res.required_policy_ids == [p.id for p in res.required_policies]
    assert res.missing_policy_ids == [p.id for p in res.missing_policies]


def test_safe_dict_includes_summaries_and_aligns_with_ids(monkeypatch):
    p1 = DummyPolicy(id=uuid.uuid4(), name="Standard Legal Review")
    p2 = DummyPolicy(id=uuid.uuid4(), name="High Priority Executive Approval")

    async def fake_match(*_args, **_kwargs):
        return [p1, p2]

    monkeypatch.setattr(gating, "find_matching_approval_policies", fake_match)
    db = FakeSession(request_obj=DummyRequest(id=uuid.uuid4()), workflows=[])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    safe = res.to_safe_dict()

    # Old id fields remain (back-compat for clients that pre-date PR #59).
    assert "required_policy_ids" in safe
    assert "missing_policy_ids" in safe
    # New named summaries.
    assert "required_policies" in safe
    assert "missing_policies" in safe
    assert [p["id"] for p in safe["required_policies"]] == safe["required_policy_ids"]
    assert [p["id"] for p in safe["missing_policies"]] == safe["missing_policy_ids"]
    # Names round-tripped through to_safe_dict.
    names = {p["name"] for p in safe["missing_policies"]}
    assert names == {"Standard Legal Review", "High Priority Executive Approval"}


def test_safe_dict_does_not_include_storage_or_signer_pii(monkeypatch):
    async def fake_match(*_args, **_kwargs):
        return [DummyPolicy(id=uuid.uuid4(), name="Standard Legal Review")]

    monkeypatch.setattr(gating, "find_matching_approval_policies", fake_match)
    db = FakeSession(request_obj=DummyRequest(id=uuid.uuid4()), workflows=[])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    safe = res.to_safe_dict()
    blob = repr(safe)
    for forbidden in (
        "storage_key",
        "wrapped_dek",
        "s3_key",
        "signer_email",
        "signer_name",
        "metadata_json",
        "created_by",
    ):
        assert forbidden not in blob, f"Gate response leaks {forbidden}"
    # The summary itself only has the allowlisted scalar fields.
    summary = safe["missing_policies"][0]
    assert set(summary.keys()) == {
        "id",
        "name",
        "workflow_template_id",
        "auto_attach",
        "applies_to_generated_contracts",
        "request_type",
        "contract_type",
        "priority",
        "agreement_template_id",
    }


def test_active_workflows_keep_required_summaries_but_no_missing(monkeypatch):
    # When the gate blocks for a non-policy reason, required_policies
    # is still populated (so the UI can show context) but
    # missing_policies is empty — we don't claim a policy is "missing"
    # while a different reason is doing the blocking.
    async def fake_match(*_args, **_kwargs):
        return [DummyPolicy(id=uuid.uuid4(), name="Standard Legal Review")]

    monkeypatch.setattr(gating, "find_matching_approval_policies", fake_match)
    active = make_workflow(ApprovalWorkflowRunStatus.ACTIVE.value)
    db = FakeSession(request_obj=DummyRequest(id=uuid.uuid4()), workflows=[active])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert res.code == "active_approval_workflows"
    assert len(res.required_policies) == 1
    assert res.missing_policies == []
    assert res.missing_policy_ids == []


def test_no_policies_no_workflows_returns_empty_summaries():
    db = FakeSession(request_obj=DummyRequest(id=uuid.uuid4()), workflows=[])
    res = run(can_send_contract_to_docuseal(db, DummyContract(uuid.uuid4()), uuid.uuid4()))
    assert res.allowed is True
    assert res.code == "no_workflows_required"
    assert res.required_policies == []
    assert res.missing_policies == []
    safe = res.to_safe_dict()
    assert safe["required_policies"] == []
    assert safe["missing_policies"] == []
