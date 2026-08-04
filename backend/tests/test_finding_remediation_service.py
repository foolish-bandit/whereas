from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from app.services.finding_remediation import (
    build_remediation_language,
    normalize_clause_type,
    priority_for_severity,
    select_clause_template,
)


def _template(
    *,
    name: str,
    clause_type: str = "governing_law",
    tags: list[str] | None = None,
    jurisdiction: str | None = None,
    contract_type: str | None = None,
    updated_at: datetime | None = None,
    text: str | None = None,
    template_id: uuid.UUID | None = None,
):
    return SimpleNamespace(
        id=template_id or uuid.uuid4(),
        name=name,
        clause_type=clause_type,
        tags=tags,
        jurisdiction=jurisdiction,
        contract_type=contract_type,
        updated_at=updated_at or datetime(2026, 8, 4, tzinfo=UTC),
        text=text or f"Approved language from {name}.",
        is_active=True,
    )


def _finding(*, preferred_language: str | None = None, clause_type: str = "governing_law"):
    return SimpleNamespace(
        id=uuid.uuid4(),
        playbook_id=uuid.uuid4(),
        rule_title="Governing law should be California",
        rule_id="governing-law-california",
        clause_type=clause_type,
        severity="medium",
        preferred_language=preferred_language,
    )


def test_normalize_clause_type_collapses_supported_separators() -> None:
    assert normalize_clause_type(" Governing-Law ") == "governing_law"
    assert normalize_clause_type("data   processing_agreement") == "data_processing_agreement"


def test_playbook_preferred_language_wins_without_template_selection() -> None:
    finding = _finding(preferred_language="  Use the firm clause.  ")
    template = _template(name="Preferred fallback", tags=["preferred"])

    result = build_remediation_language(finding, [template])

    assert result.suggested_language == "Use the firm clause."
    assert result.source_type == "playbook_preferred_language"
    assert result.source_id == finding.playbook_id
    assert result.source_name == finding.rule_title
    assert result.scope_warning is None


def test_preferred_tag_beats_newer_generic_candidate() -> None:
    now = datetime(2026, 8, 4, tzinfo=UTC)
    newer_generic = _template(name="New generic", updated_at=now)
    older_preferred = _template(
        name="Firm preferred",
        tags=["PREFERRED"],
        updated_at=now - timedelta(days=30),
    )

    selected = select_clause_template(
        "governing law", [newer_generic, older_preferred]
    )

    assert selected is older_preferred


def test_default_tag_beats_broad_scope_when_no_preferred_tag() -> None:
    broad = _template(name="Broad")
    scoped_default = _template(
        name="Default California",
        tags=["default"],
        jurisdiction="California",
    )

    selected = select_clause_template("governing_law", [broad, scoped_default])

    assert selected is scoped_default


def test_broad_scope_beats_newer_scoped_candidate() -> None:
    now = datetime(2026, 8, 4, tzinfo=UTC)
    broad = _template(name="Broad", updated_at=now - timedelta(days=10))
    scoped = _template(
        name="California SaaS",
        jurisdiction="California",
        contract_type="MSA",
        updated_at=now,
    )

    selected = select_clause_template("governing_law", [scoped, broad])

    assert selected is broad


def test_updated_at_then_uuid_make_selection_deterministic() -> None:
    now = datetime(2026, 8, 4, tzinfo=UTC)
    older = _template(name="Older", updated_at=now - timedelta(days=1))
    newer_high_id = _template(
        name="New high id",
        updated_at=now,
        template_id=uuid.UUID("ffffffff-ffff-4fff-8fff-ffffffffffff"),
    )
    newer_low_id = _template(
        name="New low id",
        updated_at=now,
        template_id=uuid.UUID("00000000-0000-4000-8000-000000000001"),
    )

    selected = select_clause_template(
        "governing_law", [newer_high_id, older, newer_low_id]
    )

    assert selected is newer_low_id


def test_selection_ignores_other_clause_types_and_inactive_templates() -> None:
    wrong_type = _template(name="Assignment", clause_type="assignment")
    inactive = _template(name="Inactive")
    inactive.is_active = False

    assert select_clause_template("governing_law", [wrong_type, inactive]) is None


def test_clause_template_plan_reports_provenance_and_scope_warning() -> None:
    finding = _finding()
    template = _template(
        name="California MSA Governing Law",
        tags=["preferred", "negotiated"],
        jurisdiction="California",
        contract_type="MSA",
        text="The laws of California govern.",
    )

    result = build_remediation_language(finding, [template])

    assert result.suggested_language == "The laws of California govern."
    assert result.source_type == "clause_template"
    assert result.source_id == template.id
    assert result.source_name == template.name
    assert "preferred" in result.rationale.lower()
    assert result.scope_warning is not None
    assert "California" in result.scope_warning
    assert "MSA" in result.scope_warning


def test_no_approved_source_returns_honest_empty_plan() -> None:
    result = build_remediation_language(_finding(), [])

    assert result.suggested_language is None
    assert result.source_type == "none"
    assert result.source_id is None
    assert "add preferred language" in result.rationale.lower()


def test_blank_playbook_language_falls_back_to_clause_manager() -> None:
    finding = _finding(preferred_language="   ")
    template = _template(name="Fallback")

    result = build_remediation_language(finding, [template])

    assert result.source_type == "clause_template"
    assert result.suggested_language == template.text


def test_priority_mapping_is_conservative_and_case_insensitive() -> None:
    assert priority_for_severity("BLOCKER") == "urgent"
    assert priority_for_severity("critical") == "urgent"
    assert priority_for_severity("high") == "high"
    assert priority_for_severity("medium") == "normal"
    assert priority_for_severity("low") == "low"
    assert priority_for_severity("unknown") == "low"
