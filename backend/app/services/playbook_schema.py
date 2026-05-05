"""Playbook YAML schema and parsing.

A playbook is a YAML document that defines a firm's positions on contract terms.
Each rule in a playbook references either:
  - An extracted metadata field (e.g., "indemnification_cap"), with a constraint expressed
    as a Python-like comparison or a natural-language description.
  - A clause type (e.g., "Limitation_Of_Liability") with a free-text guideline that the
    deviation engine evaluates against actual clause text via LLM.

Rules MUST have stable ids so deviations can be re-run and de-duped across versions.

Example playbook:

    name: "Vendor Agreements - Standard"
    description: "Default positions for inbound vendor MSAs."
    rules:
      - id: indemnification-cap-2yr-fees
        kind: metadata
        field: indemnification_cap
        constraint: "Must not exceed 2x annual fees."
        severity: high
      - id: governing-law-california
        kind: metadata
        field: governing_law
        constraint: "Must be California or Delaware."
        severity: medium
      - id: liability-no-consequential
        kind: clause
        clause_type: Limitation_Of_Liability
        guideline: "Must exclude consequential, indirect, and special damages for both parties."
        severity: high
"""
from __future__ import annotations

from typing import Literal

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator


class MetadataRule(BaseModel):
    id: str
    kind: Literal["metadata"]
    field: str
    constraint: str
    severity: Literal["info", "low", "medium", "high", "blocker"]


class ClauseRule(BaseModel):
    id: str
    kind: Literal["clause"]
    clause_type: str
    guideline: str
    severity: Literal["info", "low", "medium", "high", "blocker"]


Rule = MetadataRule | ClauseRule


class Playbook(BaseModel):
    name: str
    description: str | None = None
    rules: list[Rule] = Field(default_factory=list)

    @field_validator("rules")
    @classmethod
    def _ids_must_be_unique(cls, rules: list[Rule]) -> list[Rule]:
        ids = [r.id for r in rules]
        if len(ids) != len(set(ids)):
            raise ValueError("Rule ids must be unique within a playbook.")
        return rules


class PlaybookParseError(Exception):
    """Raised when a playbook YAML fails to parse or validate."""


def parse_playbook(yaml_source: str) -> Playbook:
    """Parse and validate a playbook from YAML source.

    Raises PlaybookParseError with a human-readable message on failure.
    """
    try:
        raw = yaml.safe_load(yaml_source)
    except yaml.YAMLError as e:
        raise PlaybookParseError(f"Invalid YAML: {e}") from e

    if not isinstance(raw, dict):
        raise PlaybookParseError("Playbook root must be a mapping.")

    try:
        return Playbook.model_validate(raw)
    except ValidationError as e:
        raise PlaybookParseError(f"Playbook validation failed: {e}") from e
