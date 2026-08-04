from __future__ import annotations

import uuid
from types import SimpleNamespace

from app.services.finding_remediation import (
    RemediationLanguage,
    remediation_audit_details,
    remediation_task_description,
    remediation_task_metadata,
    remediation_task_title,
)


def _finding():
    return SimpleNamespace(
        id=uuid.UUID("00000000-0000-4000-8000-000000000001"),
        organization_id=uuid.UUID("00000000-0000-4000-8000-000000000002"),
        contract_id=uuid.UUID("00000000-0000-4000-8000-000000000003"),
        playbook_id=uuid.UUID("00000000-0000-4000-8000-000000000004"),
        review_run_id=uuid.UUID("00000000-0000-4000-8000-000000000005"),
        rule_id="governing-law-california",
        rule_title="Governing law should be California",
        clause_type="Governing Law",
        severity="high",
        evidence_text="Counterparty secret evidence",
        preferred_language="Confidential approved clause text",
    )


def _language() -> RemediationLanguage:
    return RemediationLanguage(
        suggested_language="Confidential approved clause text",
        source_type="clause_template",
        source_id=uuid.UUID("00000000-0000-4000-8000-000000000006"),
        source_name="California MSA Governing Law",
        rationale="Selected because it is preferred.",
        scope_warning=None,
    )


def test_task_title_is_readable_and_never_exceeds_database_limit() -> None:
    assert remediation_task_title("  Assignment   requires consent  ") == (
        "Remediate: Assignment requires consent"
    )
    assert len(remediation_task_title("x" * 400)) == 255


def test_task_description_names_work_without_copying_legal_text() -> None:
    description = remediation_task_description("Governing-Law")
    assert "governing law" in description
    assert "Repository record" in description
    assert "approved firm language" in description


def test_task_metadata_contains_identifiers_not_legal_text() -> None:
    metadata = remediation_task_metadata(_finding(), _language())
    serialized = repr(metadata)

    assert metadata["finding_id"].endswith("0001")
    assert metadata["source_type"] == "clause_template"
    assert metadata["source_id"].endswith("0006")
    assert metadata["clause_type"] == "governing_law"
    assert "Counterparty secret evidence" not in serialized
    assert "Confidential approved clause text" not in serialized
    assert "California MSA Governing Law" not in serialized


def test_audit_details_add_task_and_contract_ids_without_legal_text() -> None:
    inbox_item_id = uuid.UUID("00000000-0000-4000-8000-000000000007")
    details = remediation_audit_details(_finding(), inbox_item_id, _language())
    serialized = repr(details)

    assert details["inbox_item_id"].endswith("0007")
    assert details["contract_id"].endswith("0003")
    assert details["finding_id"].endswith("0001")
    assert "Counterparty secret evidence" not in serialized
    assert "Confidential approved clause text" not in serialized
    assert "California MSA Governing Law" not in serialized
