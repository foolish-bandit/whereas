"""Unit tests for the PR #96 Agreement Template variable detector.

These tests run without Postgres / httpx — they only exercise the
pure ``detect_variable_suggestions`` regex extractor and its
deterministic ordering / dedupe / safety rejections.
"""
from __future__ import annotations

import pytest

from app.services.template_variable_detection import (
    VariableSuggestion,
    detect_variable_suggestions,
)


def test_detects_simple_placeholder() -> None:
    text = "This Agreement is between {{counterparty_name}} and the Company."
    suggestions = detect_variable_suggestions(text)
    assert suggestions == [
        VariableSuggestion(
            key="counterparty_name",
            label="Counterparty Name",
            occurrences=1,
        ),
    ]


def test_trims_whitespace_inside_braces() -> None:
    text = (
        "Effective as of {{   effective_date   }}; "
        "between {{ counterparty_name }} and Co."
    )
    suggestions = detect_variable_suggestions(text)
    keys = [s.key for s in suggestions]
    assert sorted(keys) == ["counterparty_name", "effective_date"]


def test_dedupes_repeated_placeholders_and_counts_occurrences() -> None:
    text = (
        "{{counterparty_name}} agrees with {{counterparty_name}}. "
        "Effective {{effective_date}}; counterparty: {{ counterparty_name }}."
    )
    suggestions = detect_variable_suggestions(text)
    by_key = {s.key: s for s in suggestions}
    assert by_key["counterparty_name"].occurrences == 3
    assert by_key["effective_date"].occurrences == 1
    # Sort order: most occurrences first, then key ascending.
    assert [s.key for s in suggestions] == [
        "counterparty_name",
        "effective_date",
    ]


def test_case_insensitive_dedupe_collapses_to_lowercase_key() -> None:
    text = "{{ Counterparty_Name }} and {{ COUNTERPARTY_NAME }}."
    suggestions = detect_variable_suggestions(text)
    assert len(suggestions) == 1
    assert suggestions[0].key == "counterparty_name"
    assert suggestions[0].occurrences == 2


def test_rejects_unsafe_or_expression_placeholders() -> None:
    text = "\n".join(
        [
            "{{ obj.attr }}",  # attribute access
            "{{ name | upper }}",  # filter
            "{{ name + ' suffix' }}",  # arithmetic
            "{{ func() }}",  # function call
            "{{ items[0] }}",  # subscript
            "{{   }}",  # empty
            "{{}}",  # empty no whitespace
            "{{ 1invalid }}",  # leading digit
            "{{ kebab-name }}",  # hyphen
            "{{ multi\nline }}",  # multi-line identifier
            "{{ ok_name }}",  # this one IS valid; gate-check
        ]
    )
    suggestions = detect_variable_suggestions(text)
    assert [s.key for s in suggestions] == ["ok_name"]


def test_excludes_keys_already_registered() -> None:
    text = (
        "{{ counterparty_name }} and {{ effective_date }} and {{ governing_law }}"
    )
    suggestions = detect_variable_suggestions(
        text, exclude_keys=["counterparty_name", "EFFECTIVE_DATE"]
    )
    assert [s.key for s in suggestions] == ["governing_law"]


def test_humanizes_underscore_keys() -> None:
    text = "{{ governing_law }} and {{ effective_date }} and {{ name }}"
    suggestions = detect_variable_suggestions(text)
    labels = {s.key: s.label for s in suggestions}
    assert labels["governing_law"] == "Governing Law"
    assert labels["effective_date"] == "Effective Date"
    assert labels["name"] == "Name"


def test_empty_or_missing_text_returns_empty_list() -> None:
    assert detect_variable_suggestions("") == []
    assert detect_variable_suggestions(None) == []  # type: ignore[arg-type]


def test_output_is_deterministic() -> None:
    text = "{{ alpha }} {{ beta }} {{ alpha }} {{ gamma }} {{ beta }}"
    a = detect_variable_suggestions(text)
    b = detect_variable_suggestions(text)
    assert [s.key for s in a] == [s.key for s in b]
    assert [s.occurrences for s in a] == [s.occurrences for s in b]


def test_output_dataclass_has_no_storage_internals() -> None:
    """Defense-in-depth: the suggestion dataclass surface is just
    ``key`` / ``label`` / ``occurrences``. Nothing about the source
    bytes, the template's storage key, or any wrapped key material
    ever lands on the returned objects."""
    text = (
        "storage_key=foo wrapped_dek=bar s3_key=baz private_url=q presigned=r "
        "{{ counterparty_name }}"
    )
    suggestions = detect_variable_suggestions(text)
    assert len(suggestions) == 1
    fields = vars(suggestions[0])
    assert set(fields.keys()) == {"key", "label", "occurrences"}
    serialized = str(fields)
    for needle in (
        "storage_key",
        "wrapped_dek",
        "s3_key",
        "private_url",
        "presigned",
    ):
        assert needle not in serialized


def test_caps_suggestion_count() -> None:
    """A malicious template can't blow up the suggestion list — the
    detector caps at a sane upper bound."""
    text = " ".join(f"{{{{ var_{i} }}}}" for i in range(500))
    suggestions = detect_variable_suggestions(text)
    assert len(suggestions) <= 200


@pytest.mark.parametrize(
    "text,expected_keys",
    [
        # docxtpl-style: docxtpl uses single ``{{name}}`` like Jinja.
        (
            "Dear {{counterparty_name}},\n\n{{effective_date}}\n",
            ["counterparty_name", "effective_date"],
        ),
        # Mixed with markdown and other braces.
        (
            "## Section 1\n\n**{{counterparty_name}}** agrees `{ literal }` "
            "and `{{ effective_date }}` too.",
            ["counterparty_name", "effective_date"],
        ),
        # Adjacent placeholders without space.
        (
            "{{a}}{{b}}{{c}}",
            ["a", "b", "c"],
        ),
        # Single `{` braces never start a placeholder.
        (
            "{ counterparty_name } {{ counterparty_name }}",
            ["counterparty_name"],
        ),
    ],
)
def test_real_world_template_shapes(
    text: str, expected_keys: list[str]
) -> None:
    suggestions = detect_variable_suggestions(text)
    assert sorted(s.key for s in suggestions) == sorted(expected_keys)
