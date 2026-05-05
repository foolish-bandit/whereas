"""Contract metadata extraction service.

Pipeline:
1. Send document text + extraction prompt to LLM via LiteLLM.
2. Parse JSON response. Reject malformed responses.
3. Validate every span: it MUST appear verbatim in the source text. If it doesn't,
   we treat that field as a hallucination and drop it.
4. Compute character offsets for valid spans.
5. Apply confidence thresholds from settings.
6. Return ExtractedField records ready to persist.

This is the load-bearing reliability mechanism. The model can lie, but it can't
fabricate text that's actually in the document.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass

import litellm
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import get_settings
from app.prompts.extraction import (
    PROMPT_VERSION,
    build_extraction_messages,
)

log = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class ExtractedFieldResult:
    field_name: str
    value: object | None
    span_text: str | None
    span_start: int | None
    span_end: int | None
    confidence: float
    model_name: str
    prompt_version: str
    rejected_reason: str | None = None


class ExtractionError(Exception):
    """Raised when extraction fails irrecoverably."""


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    reraise=True,
)
async def _call_llm(document_text: str) -> str:
    """Call the LLM with retries. Returns raw response text."""
    messages = build_extraction_messages(document_text)
    model = _resolve_model_name()

    response = await litellm.acompletion(
        model=model,
        messages=messages,
        temperature=0.0,
        response_format={"type": "json_object"},
        timeout=settings.LLM_REQUEST_TIMEOUT_SECONDS,
    )
    content = response.choices[0].message.content
    if not content:
        raise ExtractionError("LLM returned empty content")
    return content


def _resolve_model_name() -> str:
    """Map our config-style model name to a LiteLLM-compatible string."""
    if settings.LITELLM_PROVIDER == "ollama":
        return f"ollama/{settings.EXTRACTION_MODEL}"
    if settings.LITELLM_PROVIDER == "openai":
        return settings.EXTRACTION_MODEL
    if settings.LITELLM_PROVIDER == "anthropic":
        return f"anthropic/{settings.EXTRACTION_MODEL}"
    if settings.LITELLM_PROVIDER == "azure":
        return f"azure/{settings.EXTRACTION_MODEL}"
    return settings.EXTRACTION_MODEL


def _validate_span(span: str | None, document_text: str) -> tuple[int | None, int | None]:
    """Validate that a span appears verbatim in the source.

    Returns (start, end) offsets if valid, (None, None) if not.
    Uses the FIRST occurrence. This is a known limitation; if a span appears
    multiple times in the document, we don't currently disambiguate.
    """
    if not span:
        return None, None
    idx = document_text.find(span)
    if idx == -1:
        return None, None
    return idx, idx + len(span)


async def extract_metadata(
    document_text: str,
    contract_id: str,
) -> list[ExtractedFieldResult]:
    """Extract structured metadata from a contract.

    `document_text` MUST be `ParsedDocument.full_text` produced by
    `app.services.document_parser.parse_document`. Span validation here uses
    `str.find(span)` against this exact string, so feeding in any other
    rendering (raw bytes decoded, output from a different parser, normalized
    whitespace, etc.) will cause every span to be rejected as a hallucination.

    Returns a list of ExtractedFieldResult. Fields where the model returned a
    value but we could not validate the span are returned with rejected_reason
    set, so the caller can audit hallucinations.
    """
    try:
        raw_response = await _call_llm(document_text)
    except Exception as e:
        log.error("LLM call failed", extra={"contract_id": contract_id, "error": str(e)})
        raise ExtractionError(f"LLM call failed: {e}") from e

    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError as e:
        log.error(
            "LLM returned invalid JSON",
            extra={"contract_id": contract_id, "response": raw_response[:500]},
        )
        raise ExtractionError(f"Invalid JSON from LLM: {e}") from e

    if not isinstance(parsed, dict):
        raise ExtractionError("LLM response is not a JSON object")

    model_name = _resolve_model_name()
    results: list[ExtractedFieldResult] = []

    for field_name, payload in parsed.items():
        if not isinstance(payload, dict):
            log.warning(
                "Malformed field payload, skipping",
                extra={"contract_id": contract_id, "field": field_name},
            )
            continue

        value = payload.get("value")
        span = payload.get("span")
        confidence = payload.get("confidence", 0.0)

        try:
            confidence = float(confidence)
        except (TypeError, ValueError):
            confidence = 0.0

        # Drop below the hard threshold entirely
        if confidence < settings.EXTRACTION_DROP_THRESHOLD and value is not None:
            log.info(
                "Dropping low-confidence extraction",
                extra={
                    "contract_id": contract_id,
                    "field": field_name,
                    "confidence": confidence,
                },
            )
            continue

        # Validate span for non-null values
        rejected_reason = None
        span_start: int | None = None
        span_end: int | None = None

        if value is not None:
            if not span:
                rejected_reason = "missing_span"
                value = None
            else:
                span_start, span_end = _validate_span(span, document_text)
                if span_start is None:
                    rejected_reason = "span_not_found_in_source"
                    log.warning(
                        "Span not found in source - probable hallucination",
                        extra={
                            "contract_id": contract_id,
                            "field": field_name,
                            "span_preview": span[:100],
                        },
                    )
                    value = None
                    span = None

        results.append(
            ExtractedFieldResult(
                field_name=field_name,
                value=value,
                span_text=span,
                span_start=span_start,
                span_end=span_end,
                confidence=confidence,
                model_name=model_name,
                prompt_version=PROMPT_VERSION,
                rejected_reason=rejected_reason,
            )
        )

    return results
