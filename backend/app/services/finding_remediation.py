"""Deterministic remediation-language selection for persisted findings.

This module deliberately has no database, network, or model dependency. Callers
load tenant-scoped findings and active Clause Manager templates, then pass those
objects here. Keeping the policy pure makes source precedence and tie-breaking
fully testable and prevents a remediation suggestion from becoming an opaque AI
judgement.
"""
from __future__ import annotations

import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol, TypeVar

_SEPARATOR_RE = re.compile(r"[\s_-]+")


class FindingLike(Protocol):
    id: uuid.UUID
    organization_id: uuid.UUID
    contract_id: uuid.UUID
    playbook_id: uuid.UUID
    review_run_id: uuid.UUID
    rule_id: str
    rule_title: str
    clause_type: str
    severity: str
    preferred_language: str | None


class ClauseTemplateLike(Protocol):
    id: uuid.UUID
    name: str
    clause_type: str
    text: str
    tags: list[str] | None
    jurisdiction: str | None
    contract_type: str | None
    updated_at: datetime | None
    is_active: bool


TemplateT = TypeVar("TemplateT", bound=ClauseTemplateLike)


@dataclass(frozen=True, slots=True)
class RemediationLanguage:
    """Approved language plus the exact provenance for its selection."""

    suggested_language: str | None
    source_type: str
    source_id: uuid.UUID | None
    source_name: str | None
    rationale: str
    scope_warning: str | None


def normalize_clause_type(value: str) -> str:
    """Normalize the clause taxonomy without introducing fuzzy matching."""

    return _SEPARATOR_RE.sub("_", (value or "").strip().lower()).strip("_")


def _normalized_tags(candidate: ClauseTemplateLike) -> frozenset[str]:
    tags = getattr(candidate, "tags", None) or []
    return frozenset(
        str(tag).strip().lower()
        for tag in tags
        if isinstance(tag, str) and tag.strip()
    )


def _updated_at_sort_value(value: datetime | None) -> float:
    """Return a descending-time value suitable for an ascending sort key."""

    if value is None:
        return 0.0
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return -value.astimezone(UTC).timestamp()


def rank_clause_template(
    candidate: ClauseTemplateLike,
) -> tuple[int, int, int, float, str]:
    """Return the documented, stable Clause Manager selection key.

    Lower tuples win. Explicit firm tags outrank scope and recency. Broadly
    reusable templates outrank scoped templates only when neither explicit tag
    decides the result.
    """

    tags = _normalized_tags(candidate)
    broadly_scoped = not (
        (getattr(candidate, "jurisdiction", None) or "").strip()
        or (getattr(candidate, "contract_type", None) or "").strip()
    )
    return (
        0 if "preferred" in tags else 1,
        0 if "default" in tags else 1,
        0 if broadly_scoped else 1,
        _updated_at_sort_value(getattr(candidate, "updated_at", None)),
        str(candidate.id),
    )


def select_clause_template(
    clause_type: str,
    candidates: Sequence[TemplateT],
) -> TemplateT | None:
    """Select one active exact-taxonomy candidate, or return ``None``."""

    normalized_type = normalize_clause_type(clause_type)
    eligible = [
        candidate
        for candidate in candidates
        if getattr(candidate, "is_active", True)
        and normalize_clause_type(getattr(candidate, "clause_type", ""))
        == normalized_type
    ]
    if not eligible:
        return None
    return min(eligible, key=rank_clause_template)


def _scope_warning(candidate: ClauseTemplateLike) -> str | None:
    jurisdiction = (getattr(candidate, "jurisdiction", None) or "").strip()
    contract_type = (getattr(candidate, "contract_type", None) or "").strip()
    if jurisdiction and contract_type:
        return (
            f'This Clause Manager source is scoped to jurisdiction "{jurisdiction}" '
            f'and Repository record type "{contract_type}". Confirm both fit '
            "before using the language."
        )
    if jurisdiction:
        return (
            f'This Clause Manager source is scoped to jurisdiction "{jurisdiction}". '
            "Confirm it fits before using the language."
        )
    if contract_type:
        return (
            f'This Clause Manager source is scoped to Repository record type '
            f'"{contract_type}". Confirm it fits before using the language.'
        )
    return None


def _selection_rationale(candidate: ClauseTemplateLike) -> str:
    tags = _normalized_tags(candidate)
    factors: list[str] = []
    if "preferred" in tags:
        factors.append("it is tagged preferred")
    if "default" in tags:
        factors.append("it is tagged default")
    if not (
        (getattr(candidate, "jurisdiction", None) or "").strip()
        or (getattr(candidate, "contract_type", None) or "").strip()
    ):
        factors.append("it is broadly scoped")
    if not factors:
        factors.append("it is the most recently updated eligible source")
    return (
        "Selected the highest-ranked active Clause Manager source with the same "
        f'normalized clause type because {", and ".join(factors)}.'
    )


def build_remediation_language(
    finding: FindingLike,
    candidates: Sequence[ClauseTemplateLike],
) -> RemediationLanguage:
    """Build an honest language suggestion from approved firm sources only."""

    preferred_language = (getattr(finding, "preferred_language", None) or "").strip()
    if preferred_language:
        return RemediationLanguage(
            suggested_language=preferred_language,
            source_type="playbook_preferred_language",
            source_id=finding.playbook_id,
            source_name=finding.rule_title,
            rationale=(
                "Firm-authored preferred language was stored with this playbook rule."
            ),
            scope_warning=None,
        )

    selected = select_clause_template(finding.clause_type, candidates)
    if selected is None:
        return RemediationLanguage(
            suggested_language=None,
            source_type="none",
            source_id=None,
            source_name=None,
            rationale=(
                "No approved language source matches this finding. Add preferred "
                "language to the playbook rule or an active Clause Manager source "
                "with the same clause type."
            ),
            scope_warning=None,
        )

    return RemediationLanguage(
        suggested_language=selected.text.strip(),
        source_type="clause_template",
        source_id=selected.id,
        source_name=selected.name,
        rationale=_selection_rationale(selected),
        scope_warning=_scope_warning(selected),
    )


def priority_for_severity(severity: str) -> str:
    """Map finding severity into the existing Inbox priority vocabulary."""

    normalized = (severity or "").strip().lower()
    if normalized in {"blocker", "critical"}:
        return "urgent"
    if normalized == "high":
        return "high"
    if normalized == "medium":
        return "normal"
    return "low"


def remediation_task_title(rule_title: str) -> str:
    """Build a compact Inbox title within the model's 255-character limit."""

    compact = " ".join((rule_title or "").split()) or "Playbook finding"
    return f"Remediate: {compact}"[:255]


def remediation_task_description(clause_type: str) -> str:
    """Describe the work without copying evidence or approved clause text."""

    friendly_type = normalize_clause_type(clause_type).replace("_", " ")
    if not friendly_type:
        friendly_type = "contract"
    return (
        f"Review this {friendly_type} playbook finding and apply approved firm "
        "language in the linked Repository record as appropriate."
    )


def remediation_task_metadata(
    finding: FindingLike,
    language: RemediationLanguage,
) -> dict[str, str | None]:
    """Return identifier-only task metadata safe for the general Inbox API."""

    return {
        "finding_id": str(finding.id),
        "review_run_id": str(finding.review_run_id),
        "playbook_id": str(finding.playbook_id),
        "rule_id": finding.rule_id,
        "clause_type": normalize_clause_type(finding.clause_type),
        "severity": (finding.severity or "").strip().lower(),
        "source_type": language.source_type,
        "source_id": str(language.source_id) if language.source_id else None,
    }


def remediation_audit_details(
    finding: FindingLike,
    inbox_item_id: uuid.UUID,
    language: RemediationLanguage,
) -> dict[str, str | None]:
    """Build the safe, identifier-only hash-chained audit payload."""

    return {
        **remediation_task_metadata(finding, language),
        "contract_id": str(finding.contract_id),
        "inbox_item_id": str(inbox_item_id),
    }
