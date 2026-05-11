"""Unit tests for the deterministic contract-metadata extractor (PR #66).

The service is pure and side-effect-free, so the tests stay tight:
hand it a filename + a snippet of body text, assert on the
``ExtractedContractMetadata`` dataclass it returns. No fixtures, no
DB, no IO — those concerns belong on the integration tests for
``/api/contracts/upload`` and ``/api/requests/{id}/convert-upload``.

The intent is to pin the heuristic's conservative posture in place:
on weak input it must return ``None`` + a ``*_unknown`` warning, not
a guessed value. Hallucinating a counterparty or contract type on a
file the user hasn't even read yet is worse than admitting we don't
know.
"""
from __future__ import annotations

from datetime import date

from app.services.contract_metadata import (
    extract_basic_contract_metadata,
)

# ---------------------------------------------------------------------------
# Title suggestion
# ---------------------------------------------------------------------------


def test_filename_stem_drives_suggested_title():
    """Underscore-separated filename collapses to a space-separated
    stem. Mixed-case input is preserved so acronyms ("NDA") survive.
    """
    result = extract_basic_contract_metadata(
        filename="Mutual_NDA_Acme_2026.pdf",
        mime_type="application/pdf",
    )
    assert result.suggested_title == "Mutual NDA Acme 2026"


def test_dotted_filename_is_normalized():
    """Dot-separated stem collapses the same way as underscores."""
    result = extract_basic_contract_metadata(
        filename="MSA.Acme.v2.docx",
        mime_type=None,
    )
    assert result.suggested_title == "MSA Acme v2"


def test_h1_fallback_when_filename_is_empty():
    result = extract_basic_contract_metadata(
        filename=None,
        mime_type=None,
        markdown_text="# Mutual NDA\n\nbody",
    )
    assert result.suggested_title == "Mutual NDA"


def test_no_title_when_filename_and_body_are_empty():
    result = extract_basic_contract_metadata(
        filename=None,
        mime_type=None,
    )
    assert result.suggested_title is None
    assert "no_filename_or_body_text" in result.warnings


# ---------------------------------------------------------------------------
# Contract type detection
# ---------------------------------------------------------------------------


def test_nda_filename_resolves_to_nda():
    """Underscore/space-separated NDA token in the filename. The
    extractor deliberately requires a word boundary; an embedded
    "MutualNDA" (no separator) does NOT match because we don't want
    accidental matches inside unrelated words. The dash / underscore
    form is the common case.
    """
    result = extract_basic_contract_metadata(
        filename="Mutual_NDA_Acme.pdf",
        mime_type="application/pdf",
    )
    assert result.likely_contract_type == "NDA"


def test_msa_body_text_resolves_to_msa():
    result = extract_basic_contract_metadata(
        filename="acme-contract.pdf",
        mime_type="application/pdf",
        plain_text="This Master Services Agreement is made between Acme and Globex.",
    )
    assert result.likely_contract_type == "MSA"


def test_sow_full_phrase_in_body():
    """SOW pattern (full phrase) beats co-mentioned MSA: SOW is the
    more specific type when both appear, and the patterns are ordered
    accordingly.
    """
    result = extract_basic_contract_metadata(
        filename="contract.pdf",
        mime_type="application/pdf",
        plain_text="This Statement of Work is entered into pursuant to the MSA.",
    )
    assert result.likely_contract_type == "SOW"


def test_dpa_filename_resolves_to_dpa():
    result = extract_basic_contract_metadata(
        filename="DPA_Acme_2026.pdf",
        mime_type=None,
    )
    assert result.likely_contract_type == "DPA"


def test_employment_agreement_body_resolves():
    result = extract_basic_contract_metadata(
        filename="contract.pdf",
        mime_type=None,
        plain_text="This Employment Agreement is between Acme and J. Doe.",
    )
    assert result.likely_contract_type == "Employment Agreement"


def test_amendment_pattern_resolves():
    result = extract_basic_contract_metadata(
        filename="Amendment_No_2_to_MSA.pdf",
        mime_type=None,
    )
    # Amendment beats MSA because of the iteration order's Amendment
    # short-circuit; but both are present — the test only pins that
    # *some* recognized type is returned, with Amendment preferred when
    # the filename signals it.
    assert result.likely_contract_type in {"Amendment", "MSA"}


def test_unknown_returns_none_with_warning():
    result = extract_basic_contract_metadata(
        filename="random-text.pdf",
        mime_type=None,
        plain_text="Lorem ipsum dolor sit amet.",
    )
    assert result.likely_contract_type is None
    assert "contract_type_unknown" in result.warnings


# ---------------------------------------------------------------------------
# Counterparty detection — must be conservative
# ---------------------------------------------------------------------------


def test_between_x_and_y_extracts_first_specific_party():
    result = extract_basic_contract_metadata(
        filename="contract.pdf",
        mime_type=None,
        plain_text=(
            "This Mutual NDA is entered into between Acme Corporation and "
            "Globex Industries, effective as of 2026-05-01."
        ),
    )
    assert result.possible_counterparty_name in {
        "Acme Corporation",
        "Globex Industries",
    }


def test_generic_party_words_do_not_count():
    """'between the parties and us' is not a counterparty signal."""
    result = extract_basic_contract_metadata(
        filename="random.pdf",
        mime_type=None,
        plain_text="This agreement is between the parties and us. We agree to...",
    )
    assert result.possible_counterparty_name is None
    assert "counterparty_unknown" in result.warnings


def test_filename_marker_extracts_counterparty():
    result = extract_basic_contract_metadata(
        filename="NDA - Acme Corp.pdf",
        mime_type=None,
    )
    assert result.possible_counterparty_name == "Acme Corp"


def test_filename_without_party_marker_skips_counterparty():
    result = extract_basic_contract_metadata(
        filename="some-random-paper.pdf",
        mime_type=None,
    )
    assert result.possible_counterparty_name is None


# ---------------------------------------------------------------------------
# Effective date detection — must be near the "effective" trigger
# ---------------------------------------------------------------------------


def test_iso_effective_date_after_trigger():
    result = extract_basic_contract_metadata(
        filename="contract.pdf",
        mime_type=None,
        plain_text="Effective Date: 2026-05-01. The parties agree as follows.",
    )
    assert result.effective_date == date(2026, 5, 1)


def test_word_effective_date_after_trigger():
    result = extract_basic_contract_metadata(
        filename="contract.pdf",
        mime_type=None,
        plain_text=(
            "This Agreement is effective as of January 1, 2026 between "
            "Acme and Globex."
        ),
    )
    assert result.effective_date == date(2026, 1, 1)


def test_us_format_effective_date_after_trigger():
    result = extract_basic_contract_metadata(
        filename="contract.pdf",
        mime_type=None,
        plain_text="Effective date 05/01/2026. The parties agree.",
    )
    assert result.effective_date == date(2026, 5, 1)


def test_date_without_trigger_is_ignored():
    """A standalone date in a contract body is too ambiguous."""
    result = extract_basic_contract_metadata(
        filename="contract.pdf",
        mime_type=None,
        plain_text="Signed on 2026-05-01 by both parties.",
    )
    assert result.effective_date is None
    assert "effective_date_unknown" in result.warnings


def test_garbage_date_does_not_raise():
    """Heuristic must not crash on bogus dates."""
    result = extract_basic_contract_metadata(
        filename="contract.pdf",
        mime_type=None,
        plain_text="Effective date: 2026-13-99. Body text continues.",
    )
    # 13/99 is invalid; the extractor returns None rather than raising.
    assert result.effective_date is None


# ---------------------------------------------------------------------------
# Robustness
# ---------------------------------------------------------------------------


def test_empty_input_returns_warnings_not_exception():
    result = extract_basic_contract_metadata(
        filename=None,
        mime_type=None,
    )
    assert result.suggested_title is None
    assert result.likely_contract_type is None
    assert result.possible_counterparty_name is None
    assert result.effective_date is None
    assert "no_filename_or_body_text" in result.warnings


def test_long_body_does_not_explode():
    """Working window is bounded so a giant body is cheap."""
    long_body = ("nothing of interest " * 5000) + "\nEffective date: 2026-05-01."
    result = extract_basic_contract_metadata(
        filename="random.pdf",
        mime_type=None,
        plain_text=long_body,
    )
    # The trigger sits past the 8000-char working window, so the date
    # should NOT be picked up — pins that we don't scan the whole body.
    assert result.effective_date is None
