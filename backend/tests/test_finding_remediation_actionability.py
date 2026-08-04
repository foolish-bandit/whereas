from app.services.finding_remediation import remediation_task_block_reason


def test_superseded_finding_cannot_create_or_reopen_work() -> None:
    reason = remediation_task_block_reason("superseded")
    assert reason is not None
    assert "latest review run" in reason.lower()


def test_current_human_workflow_states_remain_actionable() -> None:
    assert remediation_task_block_reason("open") is None
    assert remediation_task_block_reason("reviewed") is None
    assert remediation_task_block_reason("ignored") is None
