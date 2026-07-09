"""Tests for the tolerant JSON parsing helpers in extraction.py.

Weak local models (the default self-hosted target, per the LiteLLM design
principle) frequently wrap valid JSON in markdown fences, add a chatty
preamble/postamble, or leave a trailing comma. `_repair_json_text` is a
conservative, local-only repair pass applied before `json.loads` so those
common malformations don't fail extraction outright. It does not attempt to
fix structurally broken JSON - that case must still fall through to the
existing failure path.
"""
from __future__ import annotations

import json

import pytest

from app.services.extraction import (
    ExtractionError,
    _parse_json_response,
    _repair_json_text,
)


class TestRepairJsonText:
    def test_already_clean_json_is_unchanged_in_meaning(self) -> None:
        raw = '{"governing_law": {"value": "Delaware", "span": "Delaware", "confidence": 0.9}}'
        assert json.loads(_repair_json_text(raw)) == json.loads(raw)

    def test_strips_markdown_code_fence_with_json_tag(self) -> None:
        raw = '```json\n{"a": 1, "b": 2}\n```'
        assert json.loads(_repair_json_text(raw)) == {"a": 1, "b": 2}

    def test_strips_markdown_code_fence_without_tag(self) -> None:
        raw = '```\n{"a": 1}\n```'
        assert json.loads(_repair_json_text(raw)) == {"a": 1}

    def test_strips_chatty_preamble(self) -> None:
        raw = 'Here is the JSON you requested:\n{"a": 1, "b": 2}'
        assert json.loads(_repair_json_text(raw)) == {"a": 1, "b": 2}

    def test_strips_chatty_postamble(self) -> None:
        raw = '{"a": 1, "b": 2}\nHope that helps! Let me know if you need anything else.'
        assert json.loads(_repair_json_text(raw)) == {"a": 1, "b": 2}

    def test_strips_preamble_and_fence_together(self) -> None:
        raw = 'Here is the JSON:\n```json\n{"a": 1}\n```\nLet me know if this works.'
        assert json.loads(_repair_json_text(raw)) == {"a": 1}

    def test_removes_trailing_comma_before_closing_brace(self) -> None:
        raw = '{"a": 1, "b": 2,}'
        assert json.loads(_repair_json_text(raw)) == {"a": 1, "b": 2}

    def test_removes_trailing_comma_before_closing_bracket(self) -> None:
        raw = '{"a": [1, 2, 3,], "b": 2}'
        assert json.loads(_repair_json_text(raw)) == {"a": [1, 2, 3], "b": 2}

    def test_removes_multiple_trailing_commas(self) -> None:
        raw = '{"a": [1, 2,], "b": {"c": 3,},}'
        assert json.loads(_repair_json_text(raw)) == {"a": [1, 2], "b": {"c": 3}}

    def test_irreparably_broken_input_still_fails_to_parse(self) -> None:
        raw = '{"a": 1, "b": '  # truncated mid-value
        repaired = _repair_json_text(raw)
        with pytest.raises(json.JSONDecodeError):
            json.loads(repaired)


class TestParseJsonResponse:
    def test_parses_clean_json_directly(self) -> None:
        raw = '{"a": 1}'
        assert _parse_json_response(raw, "contract-1") == {"a": 1}

    def test_repairs_fenced_chatty_response_before_giving_up(self) -> None:
        raw = 'Sure, here you go:\n```json\n{"a": 1, "b": 2,}\n```'
        assert _parse_json_response(raw, "contract-1") == {"a": 1, "b": 2}

    def test_raises_extraction_error_for_irreparable_input(self) -> None:
        raw = "not json at all and no braces either"
        with pytest.raises(ExtractionError, match="Invalid JSON"):
            _parse_json_response(raw, "contract-1")

    def test_raises_extraction_error_for_non_object_json(self) -> None:
        raw = "[1, 2, 3]"
        with pytest.raises(ExtractionError, match="not a JSON object"):
            _parse_json_response(raw, "contract-1")
