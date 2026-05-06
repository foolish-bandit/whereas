"""Tests for playbook YAML parsing and validation."""
import pytest

from app.services.playbook_schema import PlaybookParseError, parse_playbook

VALID_YAML = """
name: "Test Playbook"
description: "Sample"
rules:
  - id: rule-one
    kind: metadata
    field: indemnification_cap
    constraint: "Must be capped."
    severity: high
  - id: rule-two
    kind: clause
    clause_type: Limitation_Of_Liability
    guideline: "Must be mutual."
    severity: medium
"""


class TestPlaybookParsing:
    def test_parses_valid_yaml(self) -> None:
        playbook = parse_playbook(VALID_YAML)
        assert playbook.name == "Test Playbook"
        assert len(playbook.rules) == 2

    def test_rejects_invalid_yaml(self) -> None:
        with pytest.raises(PlaybookParseError):
            parse_playbook("this is: : not valid: yaml: [")

    def test_rejects_non_mapping_root(self) -> None:
        with pytest.raises(PlaybookParseError):
            parse_playbook("- just\n- a list")

    def test_rejects_duplicate_rule_ids(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: same-id
    kind: metadata
    field: governing_law
    constraint: "x"
    severity: low
  - id: same-id
    kind: metadata
    field: venue
    constraint: "y"
    severity: low
"""
        with pytest.raises(PlaybookParseError):
            parse_playbook(yaml_src)

    def test_rejects_invalid_severity(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: bad-rule
    kind: metadata
    field: governing_law
    constraint: "x"
    severity: catastrophic
"""
        with pytest.raises(PlaybookParseError):
            parse_playbook(yaml_src)

    def test_rejects_unknown_kind(self) -> None:
        yaml_src = """
name: "Test"
rules:
  - id: bad-rule
    kind: vibes
    constraint: "x"
    severity: low
"""
        with pytest.raises(PlaybookParseError):
            parse_playbook(yaml_src)
