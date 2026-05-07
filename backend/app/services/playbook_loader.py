"""Playbook YAML loader, schema, and validator.

A *playbook* is a YAML document that captures a firm's review positions
on a particular contract type — for example, "for mutual NDAs in
California, governing law should be California; assignment must require
prior written consent". The downstream deviation engine compares
segmented clauses against these rules and surfaces findings; this
module is upstream of that and only concerns itself with parsing and
validating the YAML the user supplies.

Format (v1, conservative)
-------------------------

A playbook document has top-level metadata and a list of rules:

    name: "Mutual NDA Review Playbook"      # required, <= 255 chars
    description: "Baseline review rules."   # optional
    version: "1.0"                          # optional, default "1.0"
    jurisdiction: "California"              # optional
    contract_type: "mutual_nda"             # optional, snake_case-ish
    rules:                                  # required, may be empty
      - id: "..."
        title: "..."
        clause_type: "..."
        severity: "high"                    # info|low|medium|high|blocker
        rule_type: "required_clause"        # see Rule types below
        ...

Rule types
----------

Every rule has a discriminator `rule_type`. Three are supported in v1:

  required_clause
      Requires a clause with the given `clause_type` to exist somewhere
      in the contract. No further constraints. Carries the human-facing
      `description` and `guidance` strings; if the rule is satisfied the
      finding never surfaces.

  preferred_value
      A specific extracted value is preferred (e.g. governing law =
      California). Carries `expected_value: str`. Optional
      `preferred_language` lets the firm publish a fallback "this is
      what we'd want the clause to say."

  text_contains
      The clause text must contain *all* of the listed `required_terms`
      (case-insensitive). At least one term is required. Used for
      coarse-grained "the assignment clause must mention 'consent'"
      checks; v2 will add regex / NLI variants.

Common contract
---------------

Every rule carries:
  - id: stable, slug-shaped string. Unique within the playbook.
  - title: human-readable headline.
  - clause_type: which clause type this rule applies to. Must match a
    label the segmentation taxonomy can produce (the loader does not
    enforce membership of a specific taxonomy — this lets firms ship
    custom clause labels without forking the loader).
  - severity: one of info | low | medium | high | blocker. Drives the
    UI badge and the "block merge"-style gating in future workflows.
  - description (optional) and guidance (optional): both free-text. The
    UI surfaces description as the "what"; guidance as the "how to
    triage". Either can be null.
  - preferred_language (optional): a redline-friendly string the firm
    would want to substitute in. Loader does not validate its content.

Errors
------

`PlaybookValidationError` is the only exception this module raises for
caller-visible failure. It carries a `errors: list[PlaybookIssue]`
list with at minimum a human-readable `message` and (where available)
a `path` like `rules.2.required_terms` so an editor can highlight.

Why a separate "loader" module
------------------------------

The deviation engine (next PR) will need parsed-rule access without
caring how the YAML reached it. Keeping parse/validate in one place
means:
  - The persistence layer stores `parsed_rules: dict` alongside the
    raw YAML, freeing readers from re-parsing on every request.
  - The same validator runs both at write time (POST /playbooks) and
    at validate-only time (POST /playbooks/validate, used by the
    YAML editor).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# Public constants
# --------------------------------------------------------------------------


PLAYBOOK_SCHEMA_VERSION = "1.0"

Severity = Literal["info", "low", "medium", "high", "blocker"]
RuleType = Literal["required_clause", "preferred_value", "text_contains"]

# Bounds for free-text fields. They are not security-critical (the
# YAML is org-scoped and stored verbatim regardless), but they keep
# editor pathologies — e.g. someone pasting a 10MB file into a single
# `description:` — out of the database.
_MAX_NAME_LEN = 255
_MAX_DESCRIPTION_LEN = 4_000
_MAX_TEXT_FIELD_LEN = 4_000
_MAX_RULES = 500
_MAX_REQUIRED_TERMS = 50
_MAX_TERM_LEN = 200
_MAX_YAML_BYTES = 256 * 1024  # 256 KiB; comfortably above realistic playbooks


# --------------------------------------------------------------------------
# Issue / error types
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class PlaybookIssue:
    """One validation failure with optional dotted path to the offender."""

    message: str
    path: str | None = None

    def to_dict(self) -> dict[str, str | None]:
        return {"message": self.message, "path": self.path}


class PlaybookValidationError(Exception):
    """Raised when a playbook cannot be parsed or validated.

    `errors` is the list every caller should consume (the API layer
    serializes it to JSON; the in-app YAML editor highlights paths).
    `__str__` joins messages so logging the exception is still readable.
    """

    def __init__(self, errors: list[PlaybookIssue]):
        if not errors:
            errors = [PlaybookIssue(message="Unknown playbook validation failure.")]
        self.errors = errors
        super().__init__("; ".join(issue.message for issue in errors))


# --------------------------------------------------------------------------
# Pydantic schema
# --------------------------------------------------------------------------


class _StrictModel(BaseModel):
    """Common config: forbid unknown fields so typos surface loudly."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class _BaseRule(_StrictModel):
    id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=_MAX_NAME_LEN)
    clause_type: str = Field(min_length=1, max_length=64)
    severity: Severity
    description: str | None = Field(default=None, max_length=_MAX_TEXT_FIELD_LEN)
    guidance: str | None = Field(default=None, max_length=_MAX_TEXT_FIELD_LEN)
    preferred_language: str | None = Field(
        default=None, max_length=_MAX_TEXT_FIELD_LEN
    )

    @field_validator("id")
    @classmethod
    def _id_is_slug_like(cls, value: str) -> str:
        # Rule ids are persisted into deviation findings and surfaced in
        # CLI logs, so we keep them slug-shaped: ascii alphanumerics,
        # `-`, and `_`. Whitespace and punctuation get rejected to avoid
        # ambiguous serialization later.
        if not value:
            raise ValueError("Rule id must be non-empty.")
        for ch in value:
            if not (ch.isalnum() or ch in {"-", "_"}):
                raise ValueError(
                    "Rule id may only contain ascii letters, digits, '-', or '_'."
                )
        return value


class RequiredClauseRule(_BaseRule):
    rule_type: Literal["required_clause"]


class PreferredValueRule(_BaseRule):
    rule_type: Literal["preferred_value"]
    expected_value: str = Field(min_length=1, max_length=_MAX_TEXT_FIELD_LEN)


class TextContainsRule(_BaseRule):
    rule_type: Literal["text_contains"]
    required_terms: list[str] = Field(min_length=1, max_length=_MAX_REQUIRED_TERMS)

    @field_validator("required_terms")
    @classmethod
    def _terms_are_non_empty(cls, terms: list[str]) -> list[str]:
        cleaned: list[str] = []
        for term in terms:
            if not isinstance(term, str):
                raise ValueError("Each required_terms entry must be a string.")
            stripped = term.strip()
            if not stripped:
                raise ValueError("required_terms entries must be non-empty.")
            if len(stripped) > _MAX_TERM_LEN:
                raise ValueError(
                    f"required_terms entries must be <= {_MAX_TERM_LEN} characters."
                )
            cleaned.append(stripped)
        # De-duplicate while preserving order. Case-insensitive duplicates
        # collapse to the first occurrence so "consent" and "Consent" don't
        # both end up in the rule.
        seen: set[str] = set()
        deduped: list[str] = []
        for term in cleaned:
            key = term.casefold()
            if key in seen:
                continue
            seen.add(key)
            deduped.append(term)
        return deduped


Rule = Annotated[
    RequiredClauseRule | PreferredValueRule | TextContainsRule,
    Field(discriminator="rule_type"),
]


class PlaybookDocument(_StrictModel):
    """The validated, normalized playbook payload.

    `model_dump()` on this object is what gets persisted into
    `Playbook.parsed_rules`. The discriminator field (`rule_type`) is
    preserved on each rule so deviation analysis can dispatch
    cleanly without re-parsing.
    """

    name: str = Field(min_length=1, max_length=_MAX_NAME_LEN)
    description: str | None = Field(default=None, max_length=_MAX_DESCRIPTION_LEN)
    version: str = Field(default=PLAYBOOK_SCHEMA_VERSION, min_length=1, max_length=32)
    jurisdiction: str | None = Field(default=None, max_length=128)
    contract_type: str | None = Field(default=None, max_length=128)
    rules: list[Rule] = Field(default_factory=list, max_length=_MAX_RULES)

    @field_validator("rules")
    @classmethod
    def _rule_ids_unique(cls, rules: list[Rule]) -> list[Rule]:
        seen: set[str] = set()
        for rule in rules:
            if rule.id in seen:
                raise ValueError(
                    f"Duplicate rule id: {rule.id!r}. Rule ids must be unique within a playbook."
                )
            seen.add(rule.id)
        return rules


_RULE_TYPE_ADAPTER: TypeAdapter[Rule] = TypeAdapter(Rule)


# --------------------------------------------------------------------------
# Public loader API
# --------------------------------------------------------------------------


def parse_playbook(yaml_source: str) -> PlaybookDocument:
    """Parse and validate a playbook from YAML source.

    Raises `PlaybookValidationError` with one or more `PlaybookIssue`s
    on failure. Returns a fully-validated `PlaybookDocument` on
    success.

    The loader is deliberately strict: extra keys in the YAML are an
    error (typo guard), unknown rule_type values are an error, and
    duplicate rule ids are an error. This is so a misconfigured
    playbook never silently misses rules at deviation time.
    """
    if not isinstance(yaml_source, str):
        raise PlaybookValidationError(
            [PlaybookIssue(message="Playbook source must be a string.")]
        )

    if len(yaml_source.encode("utf-8")) > _MAX_YAML_BYTES:
        raise PlaybookValidationError(
            [
                PlaybookIssue(
                    message=(
                        f"Playbook YAML exceeds the {_MAX_YAML_BYTES // 1024} KiB limit. "
                        "Split the rules into multiple playbooks."
                    )
                )
            ]
        )

    try:
        raw = yaml.safe_load(yaml_source)
    except yaml.YAMLError as exc:
        raise PlaybookValidationError(
            [PlaybookIssue(message=f"YAML parse error: {exc}")]
        ) from exc

    if raw is None:
        raise PlaybookValidationError(
            [PlaybookIssue(message="Playbook YAML is empty.")]
        )
    if not isinstance(raw, dict):
        raise PlaybookValidationError(
            [
                PlaybookIssue(
                    message="Playbook root must be a mapping (key/value), not a list or scalar."
                )
            ]
        )

    try:
        return PlaybookDocument.model_validate(raw)
    except ValidationError as exc:
        raise PlaybookValidationError(_format_validation_errors(exc)) from exc


def serialize_playbook(playbook: PlaybookDocument) -> dict[str, Any]:
    """Return a JSON-serializable dict suitable for `Playbook.parsed_rules`.

    Pydantic's `model_dump(mode="json")` is used so embedded values
    (which are all primitives in v1) match the on-disk shape exactly.
    """
    return playbook.model_dump(mode="json")


# --------------------------------------------------------------------------
# Error formatting
# --------------------------------------------------------------------------


def _format_validation_errors(exc: ValidationError) -> list[PlaybookIssue]:
    """Convert Pydantic errors to caller-friendly issues."""
    issues: list[PlaybookIssue] = []
    for err in exc.errors():
        # `loc` is a tuple of path segments. Skip the discriminator
        # internal "tagged-union" hops Pydantic emits ("required_clause"
        # etc) — they confuse path display.
        path_parts: list[str] = []
        for part in err.get("loc", ()):
            if isinstance(part, int):
                path_parts.append(str(part))
            elif isinstance(part, str):
                # Skip discriminator tags like "required_clause"; these
                # appear when a rule fails the discriminated-union check.
                if part in {"required_clause", "preferred_value", "text_contains"}:
                    continue
                path_parts.append(part)
        path = ".".join(path_parts) if path_parts else None
        issues.append(PlaybookIssue(message=err.get("msg", "Validation error."), path=path))
    if not issues:
        issues.append(PlaybookIssue(message="Playbook validation failed."))
    return issues
