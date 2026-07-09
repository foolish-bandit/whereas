"""Regression guard: every shipped sample/example playbook must parse.

backend/app/playbooks/ and backend/app/services/playbook_examples/ ship
YAML files meant to be copy-pasted by operators as a starting point (see
the header comments in those files). If the playbook schema in
app.services.playbook_loader changes without these files being updated,
the shipped samples silently rot into invalid YAML that the loader
rejects. This test globs every .yml/.yaml file in both directories and
asserts each one parses cleanly via `parse_playbook`.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.playbook_loader import PlaybookValidationError, parse_playbook

_PLAYBOOK_DIRS = [
    Path(__file__).resolve().parent.parent / "app" / "playbooks",
    Path(__file__).resolve().parent.parent / "app" / "services" / "playbook_examples",
]


def _shipped_playbook_files() -> list[Path]:
    files: list[Path] = []
    for directory in _PLAYBOOK_DIRS:
        files.extend(sorted(directory.glob("*.yml")))
        files.extend(sorted(directory.glob("*.yaml")))
    return files


_FILES = _shipped_playbook_files()


def test_at_least_one_sample_playbook_is_found() -> None:
    # Guards against the glob silently matching nothing (e.g. a directory
    # rename) and this test suite quietly stopping to cover anything.
    assert _FILES, (
        "No sample playbook YAML files found under "
        f"{[str(d) for d in _PLAYBOOK_DIRS]}"
    )


@pytest.mark.parametrize("path", _FILES, ids=[str(p) for p in _FILES])
def test_shipped_playbook_parses(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    try:
        parse_playbook(source)
    except PlaybookValidationError as exc:
        pytest.fail(f"{path} failed to parse as a valid playbook: {exc}")
