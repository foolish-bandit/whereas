"""Tests for the playbook YAML loader and validator."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.playbook_loader import (
    PLAYBOOK_SCHEMA_VERSION,
    PlaybookDocument,
    PlaybookValidationError,
    PreferredValueRule,
    RequiredClauseRule,
    TextContainsRule,
    parse_playbook,
    serialize_playbook,
)

# --------------------------------------------------------------------------
# Sample fixtures
# --------------------------------------------------------------------------


VALID_FULL_YAML = """
name: "Mutual NDA Review Playbook"
description: "Baseline review rules for mutual NDAs."
version: "1.0"
jurisdiction: "California"
contract_type: "mutual_nda"

rules:
  - id: "confidentiality-definition-required"
    title: "Confidential Information definition should be present"
    clause_type: "confidentiality"
    severity: "high"
    rule_type: "required_clause"
    description: "The agreement should define confidential information."
    guidance: "Look for a clause defining what information is protected."
    preferred_language: null

  - id: "governing-law-california"
    title: "Governing law should be California"
    clause_type: "governing_law"
    severity: "medium"
    rule_type: "preferred_value"
    expected_value: "California"
    description: "The governing law clause should select California law."
    guidance: "Flag non-California governing law for attorney review."
    preferred_language: "This Agreement shall be governed by the laws of California."

  - id: "assignment-consent-required"
    title: "Assignment should require consent"
    clause_type: "assignment"
    severity: "medium"
    rule_type: "text_contains"
    required_terms:
      - "consent"
      - "prior written consent"
    description: "Assignment should generally require prior written consent."
    guidance: "Flag assignment clauses that allow transfer without consent."
"""


MINIMAL_YAML = """
name: "Minimal"
rules: []
"""


# --------------------------------------------------------------------------
# Happy path
# --------------------------------------------------------------------------


class TestHappyPath:
    def test_parses_full_playbook(self) -> None:
        playbook = parse_playbook(VALID_FULL_YAML)
        assert isinstance(playbook, PlaybookDocument)
        assert playbook.name == "Mutual NDA Review Playbook"
        assert playbook.version == "1.0"
        assert playbook.jurisdiction == "California"
        assert playbook.contract_type == "mutual_nda"
        assert len(playbook.rules) == 3

    def test_each_rule_type_round_trips(self) -> None:
        playbook = parse_playbook(VALID_FULL_YAML)
        types = {type(r) for r in playbook.rules}
        assert RequiredClauseRule in types
        assert PreferredValueRule in types
        assert TextContainsRule in types

    def test_minimal_playbook_supplies_defaults(self) -> None:
        playbook = parse_playbook(MINIMAL_YAML)
        assert playbook.name == "Minimal"
        assert playbook.description is None
        assert playbook.jurisdiction is None
        assert playbook.contract_type is None
        # Default version comes from PLAYBOOK_SCHEMA_VERSION.
        assert playbook.version == PLAYBOOK_SCHEMA_VERSION
        assert playbook.rules == []

    def test_version_default_matches_constant(self) -> None:
        playbook = parse_playbook("name: x\nrules: []\n")
        assert playbook.version == PLAYBOOK_SCHEMA_VERSION

    def test_serialize_round_trip_through_json(self) -> None:
        playbook = parse_playbook(VALID_FULL_YAML)
        data = serialize_playbook(playbook)
        assert data["name"] == playbook.name
        assert isinstance(data["rules"], list)
        assert {r["rule_type"] for r in data["rules"]} == {
            "required_clause",
            "preferred_value",
            "text_contains",
        }
        # Re-validating the persisted dict must produce the same shape so
        # callers can rely on parsed_rules round-tripping.
        revalidated = PlaybookDocument.model_validate(data)
        assert revalidated == playbook

    def test_required_terms_strips_whitespace_and_dedupes_case_insensitive(
        self,
    ) -> None:
        yaml_src = """
name: "Term cleanup"
rules:
  - id: "assignment-consent"
    title: "Assignment requires consent"
    clause_type: "assignment"
    severity: "low"
    rule_type: "text_contains"
    required_terms:
      - "  consent  "
      - "Consent"
      - "CONSENT"
      - "prior written consent"
"""
        playbook = parse_playbook(yaml_src)
        rule = playbook.rules[0]
        assert isinstance(rule, TextContainsRule)
        # Case-insensitive de-dupe collapses to "consent" (the first variant
        # after stripping) and keeps "prior written consent".
        assert rule.required_terms == ["consent", "prior written consent"]


# --------------------------------------------------------------------------
# Structural / parser failures
# --------------------------------------------------------------------------


class TestStructuralFailures:
    def test_invalid_yaml_raises(self) -> None:
        with pytest.raises(PlaybookValidationError) as excinfo:
            parse_playbook("not: : valid yaml: [")
        assert any("YAML parse error" in i.message for i in excinfo.value.errors)

    def test_empty_yaml_raises(self) -> None:
        with pytest.raises(PlaybookValidationError) as excinfo:
            parse_playbook("")
        assert any("empty" in i.message.lower() for i in excinfo.value.errors)

    def test_root_must_be_mapping(self) -> None:
        with pytest.raises(PlaybookValidationError) as excinfo:
            parse_playbook("- one\n- two\n")
        assert any(
            "root must be a mapping" in i.message.lower()
            for i in excinfo.value.errors
        )

    def test_non_string_input_raises(self) -> None:
        # The API caller must hand the loader a string; defensive guard.
        with pytest.raises(PlaybookValidationError):
            parse_playbook(b"name: x\nrules: []")  # type: ignore[arg-type]

    def test_yaml_over_size_limit_raises(self) -> None:
        # 256KiB is the documented ceiling. Build a payload that exceeds it.
        oversized = "name: 'big'\nrules: []\n# " + ("x" * (300 * 1024))
        with pytest.raises(PlaybookValidationError) as excinfo:
            parse_playbook(oversized)
        assert any("limit" in i.message.lower() for i in excinfo.value.errors)


# --------------------------------------------------------------------------
# Top-level field validation
# --------------------------------------------------------------------------


class TestTopLevelFields:
    def test_missing_name_is_rejected(self) -> None:
        with pytest.raises(PlaybookValidationError):
            parse_playbook("rules: []\n")

    def test_unknown_top_level_field_is_rejected(self) -> None:
        # extra="forbid" — typo guard.
        yaml_src = """
name: "Test"
unknown_field: "should fail"
rules: []
"""
        with pytest.raises(PlaybookValidationError):
            parse_playbook(yaml_src)

    def test_blank_name_is_rejected(self) -> None:
        yaml_src = "name: ''\nrules: []\n"
        with pytest.raises(PlaybookValidationError):
            parse_playbook(yaml_src)


# --------------------------------------------------------------------------
# Rule validation
# --------------------------------------------------------------------------


class TestRuleValidation:
    def test_unknown_rule_type_is_rejected(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: "bad-rule"
    title: "Bad"
    clause_type: "x"
    severity: "low"
    rule_type: "vibes_check"
"""
        with pytest.raises(PlaybookValidationError):
            parse_playbook(yaml_src)

    def test_invalid_severity_is_rejected(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: "bad-rule"
    title: "Bad"
    clause_type: "x"
    severity: "catastrophic"
    rule_type: "required_clause"
"""
        with pytest.raises(PlaybookValidationError):
            parse_playbook(yaml_src)

    def test_duplicate_rule_ids_rejected(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: "same-id"
    title: "First"
    clause_type: "confidentiality"
    severity: "low"
    rule_type: "required_clause"
  - id: "same-id"
    title: "Second"
    clause_type: "assignment"
    severity: "low"
    rule_type: "required_clause"
"""
        with pytest.raises(PlaybookValidationError) as excinfo:
            parse_playbook(yaml_src)
        assert any("duplicate" in i.message.lower() for i in excinfo.value.errors)

    def test_non_slug_rule_id_rejected(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: "id with spaces"
    title: "First"
    clause_type: "confidentiality"
    severity: "low"
    rule_type: "required_clause"
"""
        with pytest.raises(PlaybookValidationError):
            parse_playbook(yaml_src)

    def test_preferred_value_requires_expected_value(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: "no-expected"
    title: "Missing expected_value"
    clause_type: "governing_law"
    severity: "medium"
    rule_type: "preferred_value"
"""
        with pytest.raises(PlaybookValidationError):
            parse_playbook(yaml_src)

    def test_text_contains_requires_at_least_one_term(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: "no-terms"
    title: "Missing required_terms"
    clause_type: "assignment"
    severity: "medium"
    rule_type: "text_contains"
    required_terms: []
"""
        with pytest.raises(PlaybookValidationError):
            parse_playbook(yaml_src)

    def test_text_contains_rejects_empty_term(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: "blank-term"
    title: "Blank term"
    clause_type: "assignment"
    severity: "medium"
    rule_type: "text_contains"
    required_terms:
      - "consent"
      - "   "
"""
        with pytest.raises(PlaybookValidationError):
            parse_playbook(yaml_src)

    def test_required_clause_does_not_need_extra_fields(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: "bare-required"
    title: "Bare required clause"
    clause_type: "confidentiality"
    severity: "high"
    rule_type: "required_clause"
"""
        playbook = parse_playbook(yaml_src)
        assert len(playbook.rules) == 1
        rule = playbook.rules[0]
        assert isinstance(rule, RequiredClauseRule)
        assert rule.description is None
        assert rule.guidance is None
        assert rule.preferred_language is None

    def test_unknown_rule_field_is_rejected(self) -> None:
        # extra="forbid" applies per-rule too.
        yaml_src = """
name: "Test"
rules:
  - id: "bad"
    title: "Has typo field"
    clause_type: "x"
    severity: "low"
    rule_type: "required_clause"
    expectd_value: "typo"
"""
        with pytest.raises(PlaybookValidationError):
            parse_playbook(yaml_src)

    def test_rule_count_cap(self) -> None:
        # Cap is documented as 500.
        rules = "\n".join(
            f"  - id: rule-{i}\n"
            f"    title: 'Rule {i}'\n"
            f"    clause_type: 'x'\n"
            f"    severity: 'low'\n"
            f"    rule_type: 'required_clause'"
            for i in range(501)
        )
        yaml_src = f"name: 'Big'\nrules:\n{rules}\n"
        with pytest.raises(PlaybookValidationError):
            parse_playbook(yaml_src)


# --------------------------------------------------------------------------
# Error path detail
# --------------------------------------------------------------------------


class TestErrorPaths:
    def test_error_carries_dotted_path_to_offending_field(self) -> None:
        # severity at index 1 is invalid; the loader should report
        # rules.1.severity (or similar) so an editor can highlight.
        yaml_src = """
name: "Test"
rules:
  - id: ok
    title: ok
    clause_type: x
    severity: low
    rule_type: required_clause
  - id: bad
    title: bad
    clause_type: x
    severity: "catastrophic"
    rule_type: required_clause
"""
        with pytest.raises(PlaybookValidationError) as excinfo:
            parse_playbook(yaml_src)
        paths = [i.path for i in excinfo.value.errors if i.path]
        assert any("rules.1" in p for p in paths)

    def test_str_summarizes_errors(self) -> None:
        try:
            parse_playbook("rules: []\n")  # missing name
        except PlaybookValidationError as exc:
            assert str(exc), "Error string should be non-empty"
            assert exc.errors, "Errors list must not be empty"
        else:  # pragma: no cover
            pytest.fail("expected PlaybookValidationError")


# --------------------------------------------------------------------------
# Bundled example
# --------------------------------------------------------------------------


def test_bundled_example_yaml_validates() -> None:
    """The shipped example must always be a valid playbook.

    The example is the canonical reference for users writing their
    first playbook. If we let it rot relative to the schema, every
    new user sees a broken example.
    """
    example_path = (
        Path(__file__).resolve().parent.parent
        / "app"
        / "services"
        / "playbook_examples"
        / "mutual_nda.yaml"
    )
    yaml_source = example_path.read_text(encoding="utf-8")
    playbook = parse_playbook(yaml_source)
    assert playbook.name == "Mutual NDA Review Playbook"
    assert playbook.contract_type == "mutual_nda"
    rule_types = {r.rule_type for r in playbook.rules}
    assert rule_types == {"required_clause", "preferred_value", "text_contains"}
