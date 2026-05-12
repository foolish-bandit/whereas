"""Deterministic placeholder detection for Agreement Templates (PR #96).

This module reads an already-extracted Text-preview body and returns a
small list of *variable suggestions* — the bare identifiers it finds
between Jinja-style ``{{ … }}`` braces. It is intentionally narrow:

* No LLM, no OCR, no Docling, no remote service. Just a regex.
* The accepted placeholder shape is ``{{[whitespace]*identifier[whitespace]*}}``
  where ``identifier`` matches ``[A-Za-z_][A-Za-z0-9_]*``. Filters,
  dotted attribute access, function calls, and arithmetic
  (``{{ obj.attr | upper }}``, ``{{ price * qty }}``) are deliberately
  rejected — we will not invent semantics around expressions that the
  generation pipeline (``docxtpl`` / Jinja) may interpret differently
  than a naive reader expects.
* Identifiers are normalized: trimmed of surrounding whitespace,
  lower-cased to a canonical ``key`` (Python convention; the variable
  registry already uses snake_case), and given a human-readable
  ``label`` by replacing underscores with spaces and title-casing.
* Repeated placeholders collapse into one suggestion with an
  ``occurrences`` count, so the suggestion list size is bounded by
  the number of *distinct* variables in the template.
* The output dataclass carries only suggestion metadata. The source
  text is never echoed; storage keys, wrapped DEKs, and signer PII
  are never read by this module.

The route layer is responsible for org scoping, loading the latest
ready markdown snapshot, filtering out keys that already have
``AgreementTemplateVariable`` rows, and returning a safe response
shape — see ``app.api.agreement_templates``.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

# {{ identifier }} — anchored to the literal double braces. We capture
# only the inner span so the post-match validator can reject anything
# that isn't a bare identifier.
_PLACEHOLDER_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")

# A safe placeholder identifier: ASCII letter / underscore start,
# followed by ASCII letters / digits / underscores. Conservative on
# purpose — the variable registry already keys by snake_case ids and
# the generation pipeline expects that shape.
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Cap to keep a malicious template from blowing up the suggestion
# response. A real-world contract has tens of placeholders at most.
_MAX_SUGGESTIONS = 200


@dataclass(frozen=True)
class VariableSuggestion:
    """One placeholder detected in the template's Text preview body.

    ``key`` is the canonical ``snake_case`` id the variable registry
    uses. ``label`` is a humanized rendering (``counterparty_name`` →
    ``"Counterparty Name"``) suitable for prefilling the variable
    builder's *Label* field. ``occurrences`` is how many times this
    placeholder appears in the source — useful for sorting / showing
    the most-used placeholders first in the UI.
    """

    key: str
    label: str
    occurrences: int


def detect_variable_suggestions(
    markdown_text: str,
    *,
    exclude_keys: Iterable[str] = (),
) -> list[VariableSuggestion]:
    """Return one suggestion per distinct valid placeholder.

    ``exclude_keys`` is the set of variable keys the template already
    registers — callers pass the existing
    ``AgreementTemplateVariable.key`` set so the response only carries
    *new* suggestions. Matching is case-insensitive against the
    canonical ``key``, which mirrors how the variable registry treats
    keys.

    Output order: by descending ``occurrences`` first, then by ``key``
    ascending. Deterministic given identical input.
    """
    if not markdown_text:
        return []

    excluded = {k.strip().lower() for k in exclude_keys if isinstance(k, str)}

    counts: dict[str, int] = {}
    for match in _PLACEHOLDER_RE.finditer(markdown_text):
        inner = match.group(1).strip()
        # The non-greedy inner capture can still trap multi-line junk;
        # an explicit identifier check is the gate.
        if not _IDENTIFIER_RE.match(inner):
            continue
        key = inner.lower()
        if key in excluded:
            continue
        counts[key] = counts.get(key, 0) + 1
        if len(counts) >= _MAX_SUGGESTIONS:
            break

    suggestions = [
        VariableSuggestion(
            key=key,
            label=_humanize(key),
            occurrences=count,
        )
        for key, count in counts.items()
    ]
    suggestions.sort(key=lambda s: (-s.occurrences, s.key))
    return suggestions


def _humanize(key: str) -> str:
    """Turn ``counterparty_name`` into ``"Counterparty Name"``."""
    words = [w for w in key.split("_") if w]
    if not words:
        return key
    return " ".join(w[:1].upper() + w[1:] for w in words)
